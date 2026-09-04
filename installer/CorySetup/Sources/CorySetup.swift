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

/// What setup is doing, in words someone can act on.
///
/// The progress is real rather than a timer: each stage completes when setup prints the
/// line that proves it. Nobody outside this project needs to read "claude-effective-
/// permissions", but everybody understands "Checking your Claude account".
enum InstallStage: Int, CaseIterable {
    case starting, messages, claude, permissions, installing, finishing

    var label: String {
        switch self {
        case .starting:    return "Getting started"
        case .messages:    return "Checking your Messages app"
        case .claude:      return "Checking your Claude account"
        case .permissions: return "Checking permissions"
        case .installing:  return "Installing Cory"
        case .finishing:   return "Almost done"
        }
    }

    /// The text setup prints once this stage is genuinely finished.
    var completionMarker: String? {
        switch self {
        case .starting:    return nil
        case .messages:    return "ok       imessage-read-watch"
        case .claude:      return "ok       claude-authentication"
        case .permissions: return "ok       claude-effective-permissions"
        case .installing:  return "Full Disk Access"
        case .finishing:   return nil
        }
    }
}

// MARK: - Shell

/// Every call here spawns a process and waits for it. Run on the main actor that freezes
/// the window — `pronto setup` takes tens of seconds, which macOS reports as "application
/// not responding". So the work happens off the main thread and only the result comes back.
enum Shell {
    static func run(
        _ launchPath: String,
        _ args: [String],
        env: [String: String] = [:],
    ) async -> (code: Int32, output: String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: launchPath)
                task.arguments = args
                var environment = ProcessInfo.processInfo.environment
                for (key, value) in env { environment[key] = value }
                task.environment = environment
                let pipe = Pipe()
                task.standardOutput = pipe
                task.standardError = pipe
                do { try task.run() } catch {
                    continuation.resume(returning: (127, "could not run \(launchPath)"))
                    return
                }
                // Read before waiting: a process that fills the pipe buffer blocks forever
                // if nothing is draining it.
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                continuation.resume(
                    returning: (task.terminationStatus, String(data: data, encoding: .utf8) ?? ""))
            }
        }
    }

    /// Same as `run`, but hands each chunk of output over as it arrives. Setup prints its
    /// checks one line at a time over about a minute; showing them as they land is the
    /// difference between visible progress and a spinner that looks stuck.
    static func stream(
        _ launchPath: String,
        _ args: [String],
        onOutput: @escaping @Sendable (String) -> Void,
    ) async -> Int32 {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: launchPath)
                task.arguments = args
                task.environment = ProcessInfo.processInfo.environment
                let pipe = Pipe()
                task.standardOutput = pipe
                task.standardError = pipe
                do { try task.run() } catch {
                    onOutput("could not run \(launchPath)\n")
                    continuation.resume(returning: 127)
                    return
                }
                let handle = pipe.fileHandleForReading
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    if let text = String(data: chunk, encoding: .utf8) { onOutput(text) }
                }
                task.waitUntilExit()
                continuation.resume(returning: task.terminationStatus)
            }
        }
    }

    static func which(_ name: String) async -> String? {
        let common = ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
        for path in common where FileManager.default.isExecutableFile(atPath: path) { return path }
        let (code, out) = await run("/usr/bin/env", ["which", name])
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
    /// True while a process is running. Drives the progress indicator and keeps the
    /// buttons from being pressed twice.
    @Published var busy = false

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
    @Published var stage: InstallStage = .starting
    @Published var showDetails = false

    /// How far along, as a fraction. Tied to stages setup actually reached, so it never
    /// claims progress that has not happened.
    var progress: Double {
        Double(stage.rawValue) / Double(InstallStage.allCases.count - 1)
    }

    /// Advances the stage when setup prints the line proving one finished.
    func noteProgress(_ chunk: String) {
        for candidate in InstallStage.allCases
        where candidate.rawValue > stage.rawValue {
            if let marker = candidate.completionMarker, chunk.contains(marker) {
                stage = candidate
            }
        }
    }

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

    func refreshAgentAccess() async {
        guard FileManager.default.isExecutableFile(atPath: installedCoryPath) else {
            agentHasAccess = false
            return
        }
        let (_, out) = await Shell.run(installedCoryPath, ["doctor", "--offline"])
        // Setup prints this whenever the agent still cannot reach Messages.
        agentHasAccess = !out.contains("grant Full Disk Access")
            && !out.lowercased().contains("full disk access")
    }

    func startPollingAgentAccess() {
        Task { await refreshAgentAccess() }
        agentTimer?.invalidate()
        agentTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.refreshAgentAccess()
                if self.agentHasAccess { self.stopPollingAgentAccess() }
            }
        }
    }

    func stopPollingAgentAccess() {
        agentTimer?.invalidate()
        agentTimer = nil
    }

    /// Opens Finder with the agent selected. Asking someone to find a file inside
    /// ~/Library — which Finder hides by default — is a dead end; letting them drag the
    /// highlighted file into Settings is not.
    func revealAgentInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: installedCoryPath)])
    }

    func openFullDiskAccessSettings() {
        let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
        NSWorkspace.shared.open(url)
    }

    func checkRequirements() async {
        busy = true
        defer { busy = false }
        claudePath = await Shell.which("claude")
        imsgPath = await Shell.which("imsg") ?? bundledResource("imsg")
    }

    func bundledResource(_ name: String) -> String? {
        Bundle.main.url(forResource: name, withExtension: nil)?.path
    }

    func detectOwnHandle() async {
        guard let imsg = imsgPath else { return }
        let (code, out) = await Shell.run(imsg, ["account", "--local", "--json"])
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

    func install() async {
        busy = true
        defer { busy = false }
        guard let cory = bundledCory else {
            installLog = "Could not find the Cory program inside this app."
            installFailed = true
            return
        }
        installLog = ""
        stage = .starting
        var out = ""
        let code = await Shell.stream(cory, setupArguments) { chunk in
            Task { @MainActor in
                self.installLog += chunk
                self.noteProgress(chunk)
            }
            out += chunk
        }
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
                // A hollow circle beside a label reads as something to tick. These rows are
                // statements, not choices, so an informational one gets a plain bullet and
                // only real states get an icon.
                if ok == nil {
                    Circle().fill(Color.secondary.opacity(0.45))
                        .frame(width: 5, height: 5).padding(.top, 5)
                } else if ok! {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        .font(.system(size: 15))
                } else {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                        .font(.system(size: 15))
                }
            }
            .frame(width: 16, alignment: .center)
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
                Row(ok: nil, label: "You'll need a Claude account",
                    detail: "Cory uses your own Claude subscription to think.")
                Row(ok: nil, label: "You'll allow Cory to read your messages",
                    detail: "Apple asks you to do this yourself. We'll show you exactly where — twice, because Apple asks per app.")
                Row(ok: nil, label: "Your Mac needs to stay awake",
                    detail: "Cory runs here, so it only replies while this Mac is on.")
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
                        model.step = .requirements
                        Task {
                            await model.checkRequirements()
                            await model.detectOwnHandle()
                        }
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
                if model.busy {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking…").font(.system(size: 12.5)).foregroundStyle(.secondary)
                    }
                }
                Row(ok: model.claudePath != nil,
                    label: model.claudePath != nil ? "Claude is ready" : "Claude is not installed yet",
                    detail: model.claudePath != nil
                      ? "Cory thinks using your own Claude account."
                      : "Cory needs Claude to work. Install it, then press Check again.")
                Row(ok: model.imsgPath != nil,
                    label: model.imsgPath != nil ? "Messages is ready" : "Something is missing",
                    detail: model.imsgPath != nil
                      ? "Included with this installer — nothing to do."
                      : "This installer is incomplete. Download it again.")
                if model.claudePath == nil {
                    Link("Get Claude Code", destination: URL(string: "https://claude.com/product/claude-code")!)
                        .font(.system(size: 12.5))
                }
                Spacer()
                HStack {
                    Button("Back") { model.step = .trust }
                    Button("Check again") {
                        Task { await model.checkRequirements(); await model.detectOwnHandle() }
                    }
                    .disabled(model.busy)
                    Spacer()
                    Button("Continue") { model.refreshFullDiskAccess(); model.step = .fullDiskAccess }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.busy || model.claudePath == nil || model.imsgPath == nil)
                }
            }
        }
    }

    private var fullDiskAccess: some View {
        StepChrome(model: model,
                   heading: "Let Cory read your messages",
                   blurb: "Cory replies to your texts, so it needs permission to see them. Apple only lets you give this permission yourself — no app can do it for you. It takes about twenty seconds.") {
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
                    Button("Install") {
                        model.step = .installing
                        Task { await model.install() }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    private var installing: some View {
        StepChrome(model: model,
                   heading: model.installFailed ? "Something went wrong" : "Setting up Cory",
                   blurb: model.installFailed
                     ? "Nothing on your Mac was changed. You can try again, or go back and change your answers."
                     : "This takes about a minute. You do not need to do anything.") {
            VStack(alignment: .leading, spacing: 18) {
                if !model.installFailed {
                    VStack(alignment: .leading, spacing: 10) {
                        ProgressView(value: model.progress)
                            .progressViewStyle(.linear)
                        Text(model.stage.label)
                            .font(.system(size: 14, weight: .medium))
                        // Everything already done, so the wait feels like movement.
                        ForEach(InstallStage.allCases.filter { $0.rawValue < model.stage.rawValue },
                                id: \.rawValue) { done in
                            HStack(spacing: 7) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green).font(.system(size: 12))
                                Text(done.label)
                                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // The raw output is kept, but folded away. It is reassurance for anyone who
                // wants it and noise for everyone else.
                DisclosureGroup(isExpanded: $model.showDetails) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            Text(model.installLog.isEmpty ? "Starting…" : model.installLog)
                                .font(.system(size: 11, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                                .id("log")
                        }
                        .frame(height: 150)
                        .onChange(of: model.installLog) { _ in
                            proxy.scrollTo("log", anchor: .bottom)
                        }
                    }
                } label: {
                    Text("Show details").font(.system(size: 12.5))
                }

                Spacer()
                if model.installFailed {
                    HStack {
                        Button("Back") { model.installFailed = false; model.step = .access }
                        Spacer()
                        Button("Try again") { Task { await model.install() } }
                            .keyboardShortcut(.defaultAction)
                            .disabled(model.busy)
                    }
                }
            }
        }
    }

    private var agentAccess: some View {
        StepChrome(model: model,
                   heading: "One last permission",
                   blurb: "You gave that permission to this installer. Cory itself is a separate program, and Apple asks for it again — once — for Cory.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("1.  Press Show me the file — Finder opens with it highlighted.\n2.  Press Open Settings.\n3.  Drag the highlighted file into the list, and switch it on.")
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
                    Button("Show me the file") { model.revealAgentInFinder() }
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
                    Button("Finish setup") {
                        model.step = .installing
                        Task { await model.install() }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.busy || !model.agentHasAccess)
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
