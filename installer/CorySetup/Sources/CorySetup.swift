import SwiftUI
import AppKit

// MARK: - Steps

enum Step: Int, CaseIterable {
    case welcome, trust, requirements, fullDiskAccess, access, installing, agentAccess, done

    var title: String {
        switch self {
        case .welcome:        return "Welcome"
        case .trust:          return "What Cory can do"
        case .requirements:   return "Check this Mac"
        case .fullDiskAccess: return "Allow access to Messages"
        case .access:         return "Who can use Cory"
        case .installing:     return "Setting up"
        case .agentAccess:    return "One more permission"
        case .done:           return "Ready"
        }
    }
}

enum AccessChoice: String { case onlyMe, people, anyone }

// MARK: - Shell

@MainActor
final class Shell {
    /// Runs a command and returns (exitCode, combined output). Never throws: the wizard
    /// shows failures as text rather than dying on them.
    static func run(_ launchPath: String, _ args: [String], env: [String: String] = [:]) -> (Int32, String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: launchPath)
        task.arguments = args
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in env { environment[key] = value }
        task.environment = environment
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        do { try task.run() } catch { return (127, "could not run \(launchPath)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    static func which(_ name: String) -> String? {
        let common = ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
        for path in common where FileManager.default.isExecutableFile(atPath: path) { return path }
        let (code, out) = run("/usr/bin/env", ["which", name])
        let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return code == 0 && !trimmed.isEmpty ? trimmed : nil
    }
}

// MARK: - Model

@MainActor
final class Model: ObservableObject {
    /// Granting Full Disk Access forces a relaunch — macOS only hands the permission to a
    /// fresh process. So progress has to survive being quit, or the one unavoidable manual
    /// step also throws away everything answered before it.
    private let store = UserDefaults.standard
    private enum Key {
        static let step = "wizard.step"
        static let trust = "wizard.trustAccepted"
        static let access = "wizard.accessChoice"
        static let own = "wizard.ownHandle"
        static let extras = "wizard.extraHandles"
        static let tag = "wizard.tag"
    }

    @Published var step: Step = .welcome { didSet { store.set(step.rawValue, forKey: Key.step) } }
    @Published var trustAccepted = false { didSet { store.set(trustAccepted, forKey: Key.trust) } }

    @Published var claudePath: String?
    @Published var imsgPath: String?
    @Published var checking = false

    @Published var hasFullDiskAccess = false
    private var accessTimer: Timer?

    @Published var accessChoice: AccessChoice = .onlyMe {
        didSet { store.set(accessChoice.rawValue, forKey: Key.access) }
    }
    @Published var ownHandle = "" { didSet { store.set(ownHandle, forKey: Key.own) } }
    @Published var extraHandles: [String] = [""] {
        didSet { store.set(extraHandles, forKey: Key.extras) }
    }

    @Published var tag = "@cory" { didSet { store.set(tag, forKey: Key.tag) } }
    @Published var installLog = ""
    @Published var installFailed = false

    init() {
        // Restore, but never resume into a finished install: a second run should set up
        // again from a sensible place rather than claim to be done.
        trustAccepted = store.bool(forKey: Key.trust)
        if let raw = store.string(forKey: Key.access), let choice = AccessChoice(rawValue: raw) {
            accessChoice = choice
        }
        ownHandle = store.string(forKey: Key.own) ?? ""
        if let saved = store.stringArray(forKey: Key.extras), !saved.isEmpty { extraHandles = saved }
        tag = store.string(forKey: Key.tag) ?? "@cory"

        let savedStep = Step(rawValue: store.integer(forKey: Key.step)) ?? .welcome
        // .installing is a transient state; resuming into it would show a stalled spinner.
        step = (savedStep == .installing || savedStep == .done) ? .fullDiskAccess : savedStep
        if step != .welcome { refreshFullDiskAccess() }
    }

    /// Called once setup succeeds, so the next launch starts clean rather than resuming
    /// into a wizard that has already finished.
    func clearSavedProgress() {
        for key in [Key.step, Key.trust, Key.access, Key.own, Key.extras, Key.tag] {
            store.removeObject(forKey: key)
        }
    }

    /// The agent binary shipped inside this app, so nothing has to be installed first.
    var bundledCory: String? {
        Bundle.main.url(forResource: "cory", withExtension: nil)?.path
    }

    /// Where the agent lives once installed. Full Disk Access is granted per binary, so
    /// this exact path is what the person has to authorise — not this installer.
    var installedCoryPath: String {
        NSHomeDirectory() + "/Library/Application Support/cory/bin/cory"
    }

    // Reading the Messages database is the only honest test of Full Disk Access: the
    // permission cannot be queried, only exercised.
    func refreshFullDiskAccess() {
        let db = NSHomeDirectory() + "/Library/Messages/chat.db"
        hasFullDiskAccess = FileManager.default.isReadableFile(atPath: db)
            && (try? FileHandle(forReadingFrom: URL(fileURLWithPath: db))) != nil
    }

    /// Polls until the grant appears, so the wizard continues on its own rather than
    /// asking the person to come back and press something.
    func startPollingAccess() {
        refreshFullDiskAccess()
        accessTimer?.invalidate()
        accessTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.refreshFullDiskAccess()
                if self.hasFullDiskAccess { self.stopPollingAccess() }
            }
        }
    }

    func stopPollingAccess() {
        accessTimer?.invalidate()
        accessTimer = nil
    }

    /// Whether the INSTALLED agent can read Messages. Asking the binary to do it is the
    /// only real test; the installer's own permission says nothing about the agent's.
    @Published var agentHasAccess = false
    private var agentTimer: Timer?

    /// Puts the agent at its final path so there is something to authorise.
    ///
    /// Setup rolls back when it stops at the permission gate, taking the installed binary
    /// with it — so the path it just told the person to authorise does not exist by the
    /// time they go looking. Placing the same bytes here is safe: setup reinstalls this
    /// very file afterwards, and because it is signed with a stable identity the grant
    /// survives being rewritten.
    @discardableResult
    func placeAgentBinary() -> Bool {
        guard let bundled = bundledCory else { return false }
        let destination = installedCoryPath
        let directory = (destination as NSString).deletingLastPathComponent
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
            if fm.fileExists(atPath: destination) { try fm.removeItem(atPath: destination) }
            try fm.copyItem(atPath: bundled, toPath: destination)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination)
            return true
        } catch {
            installLog += "\nCould not place Cory at \(destination): \(error.localizedDescription)"
            return false
        }
    }

    func refreshAgentAccess() {
        guard FileManager.default.isExecutableFile(atPath: installedCoryPath) else {
            agentHasAccess = false
            return
        }
        let (_, out) = Shell.run(installedCoryPath, ["doctor", "--offline"])
        // Setup prints this whenever the agent still cannot reach Messages.
        agentHasAccess = !out.contains("grant Full Disk Access")
            && !out.lowercased().contains("full disk access")
    }

    func startPollingAgentAccess() {
        refreshAgentAccess()
        agentTimer?.invalidate()
        agentTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.refreshAgentAccess()
                if self.agentHasAccess { self.stopPollingAgentAccess() }
            }
        }
    }

    func stopPollingAgentAccess() {
        agentTimer?.invalidate()
        agentTimer = nil
    }

    func openFullDiskAccessSettings() {
        let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
        NSWorkspace.shared.open(url)
    }

    func checkRequirements() {
        checking = true
        claudePath = Shell.which("claude")
        imsgPath = Shell.which("imsg") ?? bundledResource("imsg")
        checking = false
    }

    func bundledResource(_ name: String) -> String? {
        Bundle.main.url(forResource: name, withExtension: nil)?.path
    }

    func detectOwnHandle() {
        guard let imsg = imsgPath else { return }
        let (code, out) = Shell.run(imsg, ["account", "--local", "--json"])
        guard code == 0, let data = out.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accounts = root["accounts"] as? [[String: Any]] else { return }
        // Prefer a phone number: it is what people text.
        for account in accounts {
            if let login = account["login"] as? String, login.hasPrefix("P:") {
                ownHandle = String(login.dropFirst(2)); return
            }
        }
        for account in accounts {
            if let login = account["login"] as? String, login.count > 2 {
                ownHandle = String(login.dropFirst(2)); return
            }
        }
    }

    var setupArguments: [String] {
        var args = ["setup", "--tag", tag, "--runtime", "claude", "--accept-trust",
                    "--working-directory", NSHomeDirectory() + "/Cory"]
        switch accessChoice {
        case .anyone:
            args += ["--access", "everyone"]
        case .onlyMe:
            args += ["--access", "allowlist"]
            if !ownHandle.isEmpty { args += ["--allow", ownHandle] }
        case .people:
            args += ["--access", "allowlist"]
            if !ownHandle.isEmpty { args += ["--allow", ownHandle] }
            for handle in extraHandles where !handle.trimmingCharacters(in: .whitespaces).isEmpty {
                args += ["--allow", handle.trimmingCharacters(in: .whitespaces)]
            }
        }
        return args
    }

    func install() {
        guard let cory = bundledCory ?? Shell.which("cory") else {
            installLog = "Could not find the Cory program inside this app."
            installFailed = true
            return
        }
        installLog = "Installing…\n"
        let (code, out) = Shell.run(cory, setupArguments)
        installLog += out
        // Full Disk Access is granted per binary. This installer holding it is what let
        // setup's checks pass; the agent it just installed is a different binary and needs
        // its own grant before it can run on its own. Setup says so and stops, so treat
        // that as a step rather than a failure.
        if out.contains("grant Full Disk Access") {
            installFailed = false
            step = .agentAccess
            return
        }
        installFailed = code != 0
        if !installFailed {
            clearSavedProgress()
            step = .done
        }
    }
}

// MARK: - Shared chrome

struct StepChrome<Content: View>: View {
    let model: Model
    let heading: String
    let blurb: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                ForEach(Step.allCases, id: \.rawValue) { s in
                    Capsule()
                        .fill(s.rawValue <= model.step.rawValue
                              ? Color.accentColor : Color.secondary.opacity(0.22))
                        .frame(height: 3)
                }
            }
            .padding(.bottom, 26)

            Text(heading)
                .font(.system(size: 24, weight: .semibold))
                .padding(.bottom, 8)
            Text(blurb)
                .font(.system(size: 13.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 22)

            content
            Spacer(minLength: 12)
        }
        .padding(32)
        .frame(width: 620, height: 520, alignment: .topLeading)
    }
}

struct Row: View {
    let ok: Bool?
    let label: String
    let detail: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Group {
                if ok == nil { Image(systemName: "circle.dotted").foregroundStyle(.secondary) }
                else if ok! { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                else { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange) }
            }.font(.system(size: 15))
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 13.5, weight: .medium))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

// MARK: - App

@main
struct CorySetupApp: App {
    var body: some Scene {
        WindowGroup("Cory by Crate Systems") { RootView() }
            .windowResizability(.contentSize)
            .defaultSize(width: 620, height: 520)
    }
}

struct RootView: View {
    @StateObject private var model = Model()

    var body: some View {
        Group {
            switch model.step {
            case .welcome:        welcome
            case .trust:          trust
            case .requirements:   requirements
            case .fullDiskAccess: fullDiskAccess
            case .access:         access
            case .installing:     installing
            case .agentAccess:    agentAccess
            case .done:           done
            }
        }
    }

    private var welcome: some View {
        StepChrome(model: model,
                   heading: "Set up Cory",
                   blurb: "Cory answers your text messages and can do real work on this Mac — look things up, write documents, make files. This takes about three minutes.") {
            VStack(alignment: .leading, spacing: 14) {
                Row(ok: nil, label: "You'll need a Claude subscription", detail: "Cory signs in with your own Claude account.")
                Row(ok: nil, label: "You'll grant one permission", detail: "macOS asks you to allow access to Messages. We'll show you where.")
                Spacer()
                HStack { Spacer(); Button("Continue") { model.step = .trust }.keyboardShortcut(.defaultAction) }
            }
        }
    }

    private var trust: some View {
        StepChrome(model: model,
                   heading: "What Cory can do",
                   blurb: "Read this before continuing. It is the part people skip and later wish they hadn't.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Cory can run programs and open, change, or delete files anywhere on this Mac that you can — without asking each time.\n\nAnyone allowed to message Cory can ask it to do those things. A message is not a password. On the next screens you choose who is allowed.")
                    .font(.system(size: 13.5))
                    .fixedSize(horizontal: false, vertical: true)
                Toggle("I understand what Cory can do on this Mac", isOn: $model.trustAccepted)
                    .padding(.top, 4)
                Spacer()
                HStack {
                    Button("Back") { model.step = .welcome }
                    Spacer()
                    Button("Continue") {
                        model.checkRequirements(); model.detectOwnHandle(); model.step = .requirements
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.trustAccepted)
                }
            }
        }
    }

    private var requirements: some View {
        StepChrome(model: model,
                   heading: "Check this Mac",
                   blurb: "Cory needs Claude to think with, and a small helper to read Messages.") {
            VStack(alignment: .leading, spacing: 14) {
                Row(ok: model.claudePath != nil,
                    label: model.claudePath != nil ? "Claude is installed" : "Claude is not installed",
                    detail: model.claudePath ?? "Install Claude Code, then press Check again.")
                Row(ok: model.imsgPath != nil,
                    label: "Messages helper",
                    detail: model.imsgPath ?? "Missing — this app should include it.")
                if model.claudePath == nil {
                    Link("Get Claude Code", destination: URL(string: "https://claude.com/product/claude-code")!)
                        .font(.system(size: 12.5))
                }
                Spacer()
                HStack {
                    Button("Back") { model.step = .trust }
                    Button("Check again") { model.checkRequirements(); model.detectOwnHandle() }
                    Spacer()
                    Button("Continue") { model.refreshFullDiskAccess(); model.step = .fullDiskAccess }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.claudePath == nil || model.imsgPath == nil)
                }
            }
        }
    }

    private var fullDiskAccess: some View {
        StepChrome(model: model,
                   heading: "Allow access to Messages",
                   blurb: "macOS will not let any app grant this for you, so this one step is manual. It takes about twenty seconds.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("1.  Press Open Settings below.\n2.  Find Full Disk Access.\n3.  Turn on Cory by Crate Systems in the list.\n\nmacOS may ask you to quit and reopen this app — that is normal, and it is the only way the permission takes effect. Your answers are saved, so reopening returns you to this step.")
                    .font(.system(size: 13.5))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Open Settings") { model.openFullDiskAccessSettings() }
                    if model.hasFullDiskAccess {
                        Label("Granted", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Waiting…").foregroundStyle(.secondary).font(.system(size: 12.5))
                        }
                    }
                }
                Spacer()
                HStack {
                    Button("Back") { model.step = .requirements }
                    Spacer()
                    Button("Continue") { model.step = .access }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!model.hasFullDiskAccess)
                }
            }
        }
        .onAppear { model.startPollingAccess() }
        .onDisappear { model.stopPollingAccess() }
    }

    private var access: some View {
        StepChrome(model: model,
                   heading: "Who can use Cory",
                   blurb: "Anyone you allow can ask Cory to run things on this Mac. Start narrow — you can widen it later.") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("", selection: $model.accessChoice) {
                    Text("Only me").tag(AccessChoice.onlyMe)
                    Text("Me and people I choose").tag(AccessChoice.people)
                    Text("Anyone who texts me").tag(AccessChoice.anyone)
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()

                if model.accessChoice != .anyone {
                    HStack {
                        Text("Your number").font(.system(size: 12.5)).foregroundStyle(.secondary)
                        TextField("+1 555 123 4567", text: $model.ownHandle).frame(width: 200)
                    }
                }
                if model.accessChoice == .people {
                    ForEach(model.extraHandles.indices, id: \.self) { index in
                        HStack {
                            TextField("Phone number or email", text: $model.extraHandles[index])
                                .frame(width: 260)
                            if index == model.extraHandles.count - 1 {
                                Button("Add") { model.extraHandles.append("") }
                            }
                        }
                    }
                }
                if model.accessChoice == .anyone {
                    Text("Anyone who can message you will be able to run programs and change files on this Mac. Only choose this if that is genuinely what you want.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                HStack {
                    Button("Back") { model.step = .fullDiskAccess }
                    Spacer()
                    Button("Install") { model.step = .installing; model.install() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    private var installing: some View {
        StepChrome(model: model, heading: "Setting up", blurb: "This takes a few seconds.") {
            VStack(alignment: .leading, spacing: 12) {
                if !model.installFailed { ProgressView().controlSize(.small) }
                ScrollView {
                    Text(model.installLog.isEmpty ? "Working…" : model.installLog)
                        .font(.system(size: 11.5, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(height: 220)
                if model.installFailed {
                    HStack {
                        Button("Back") { model.installFailed = false; model.step = .access }
                        Spacer()
                        Button("Try again") { model.install() }
                    }
                }
            }
        }
    }

    private var agentAccess: some View {
        StepChrome(model: model,
                   heading: "One more permission",
                   blurb: "Cory is installed. macOS grants this permission to one program at a time, and the installer's own permission does not carry over to Cory itself.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("1.  Press Open Settings below.\n2.  Find Full Disk Access.\n3.  Add this file, then switch it on:")
                    .font(.system(size: 13.5))
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.installedCoryPath)
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                Text("If Cory is already listed, remove that row and add this file again — switching it off and on is not enough once the program has been replaced.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Open Settings") { model.openFullDiskAccessSettings() }
                    if model.agentHasAccess {
                        Label("Granted", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Waiting…").foregroundStyle(.secondary).font(.system(size: 12.5))
                        }
                    }
                }
                Spacer()
                HStack {
                    Spacer()
                    Button("Finish setup") { model.step = .installing; model.install() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!model.agentHasAccess)
                }
            }
        }
        .onAppear {
            model.placeAgentBinary()
            model.startPollingAgentAccess()
        }
        .onDisappear { model.stopPollingAgentAccess() }
    }

    private var done: some View {
        StepChrome(model: model,
                   heading: "Cory is ready",
                   blurb: "Text yourself to try it.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Open Messages and send yourself:")
                    .font(.system(size: 13.5))
                Text("\(model.tag) ping")
                    .font(.system(size: 15, design: .monospaced))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("Cory replies in the same conversation. It takes up to a minute the first time.")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                Spacer()
                HStack {
                    Spacer()
                    Button("Done") { NSApplication.shared.terminate(nil) }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
    }
}
