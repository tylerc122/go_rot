import Cocoa
import Darwin
import UserNotifications

private enum SetupStage: Int {
  case welcome
  case agents
  case installing
  case chrome
  case ready
  case failure
}

private enum Brand {
  static let canvas = NSColor(hex: 0xE9E1F3)
  static let paper = NSColor(hex: 0xF9F6FC)
  static let graphite = NSColor(hex: 0x29252F)
  static let graphiteRaised = NSColor(hex: 0x3A3441)
  static let muted = NSColor(hex: 0x6B6373)
  static let rule = NSColor(hex: 0xC4B8D2)
  static let ruleStrong = NSColor(hex: 0xAAA0B6)
  static let lilac = NSColor(hex: 0x8969CF)
  static let lilacSoft = NSColor(hex: 0xD8C9EE)
  static let mint = NSColor(hex: 0x58A982)
  static let danger = NSColor(hex: 0xB64050)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var eyebrowLabel: NSTextField!
  private var headlineLabel: NSTextField!
  private var bodyLabel: NSTextField!
  private var stateLabel: NSTextField!
  private var footerLabel: NSTextField!
  private var heroImage: NSImageView!
  private var agentPicker: AgentSelectionView!
  private var primaryButton: BrandButton!
  private var progressView: SetupProgressView!
  private var readinessTimer: Timer?
  private var primaryAction: (() -> Void)?
  private var lastProgressStage = SetupStage.welcome
  private var currentStage = SetupStage.welcome
  private var isPreview = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.appearance = NSAppearance(named: .aqua)
    buildMenu()
    buildWindow()

    if let preview = ProcessInfo.processInfo.environment["GO_ROT_ONBOARDING_PREVIEW"] {
      isPreview = true
      showPreview(named: preview)
    } else if setupIsReady() {
      showReady(requestNotifications: false)
    } else {
      showWelcome()
    }

    if ProcessInfo.processInfo.environment["GO_ROT_ONBOARDING_CAPTURE_DIR"] == nil {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    schedulePreviewCapturesIfRequested()
  }

  func applicationWillTerminate(_ notification: Notification) {
    readinessTimer?.invalidate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 560),
      styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Go Rot"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.backgroundColor = Brand.canvas
    window.appearance = NSAppearance(named: .aqua)
    window.center()
    self.window = window

    let canvas = CanvasView(color: Brand.canvas)
    window.contentView = canvas

    progressView = SetupProgressView()
    progressView.translatesAutoresizingMaskIntoConstraints = false

    eyebrowLabel = textLabel(
      "",
      font: .systemFont(ofSize: 12, weight: .bold),
      color: Brand.lilac
    )
    eyebrowLabel.setAccessibilityRole(.staticText)

    headlineLabel = textLabel(
      "",
      font: .systemFont(ofSize: 44, weight: .heavy),
      color: Brand.graphite
    )
    headlineLabel.maximumNumberOfLines = 3
    headlineLabel.lineBreakMode = .byWordWrapping
    headlineLabel.preferredMaxLayoutWidth = 410
    headlineLabel.setAccessibilityRole(.staticText)

    bodyLabel = textLabel(
      "",
      font: .systemFont(ofSize: 17, weight: .medium),
      color: Brand.muted
    )
    bodyLabel.maximumNumberOfLines = 5
    bodyLabel.lineBreakMode = .byWordWrapping
    bodyLabel.preferredMaxLayoutWidth = 420

    stateLabel = textLabel(
      "",
      font: .systemFont(ofSize: 13, weight: .semibold),
      color: Brand.muted
    )
    stateLabel.maximumNumberOfLines = 2
    stateLabel.lineBreakMode = .byWordWrapping
    stateLabel.preferredMaxLayoutWidth = 420

    primaryButton = BrandButton(title: "", target: self, action: #selector(primaryPressed))
    primaryButton.translatesAutoresizingMaskIntoConstraints = false

    let copyStack = NSStackView(views: [eyebrowLabel, headlineLabel, bodyLabel, stateLabel, primaryButton])
    copyStack.orientation = .vertical
    copyStack.alignment = .leading
    copyStack.spacing = 0
    copyStack.setCustomSpacing(19, after: eyebrowLabel)
    copyStack.setCustomSpacing(26, after: headlineLabel)
    copyStack.setCustomSpacing(19, after: bodyLabel)
    copyStack.setCustomSpacing(27, after: stateLabel)
    copyStack.translatesAutoresizingMaskIntoConstraints = false

    heroImage = NSImageView(image: spiralImage())
    heroImage.imageScaling = .scaleProportionallyUpOrDown
    heroImage.alphaValue = 0.92
    heroImage.translatesAutoresizingMaskIntoConstraints = false

    agentPicker = AgentSelectionView(
      target: self,
      action: #selector(agentSelectionChanged)
    )
    agentPicker.translatesAutoresizingMaskIntoConstraints = false
    agentPicker.isHidden = true

    let heroContainer = NSView()
    heroContainer.translatesAutoresizingMaskIntoConstraints = false
    heroContainer.addSubview(heroImage)
    heroContainer.addSubview(agentPicker)

    let mainRow = NSStackView(views: [copyStack, heroContainer])
    mainRow.orientation = .horizontal
    mainRow.alignment = .centerY
    mainRow.distribution = .fill
    mainRow.spacing = 30
    mainRow.translatesAutoresizingMaskIntoConstraints = false

    footerLabel = textLabel(
      "Local only  ·  No account  ·  Nothing leaves your Mac",
      font: .systemFont(ofSize: 12, weight: .semibold),
      color: Brand.muted
    )
    footerLabel.setAccessibilityRole(.staticText)

    let footerLock = NSImageView(
      image: NSImage(
        systemSymbolName: "lock.fill",
        accessibilityDescription: nil
      ) ?? NSImage()
    )
    footerLock.contentTintColor = Brand.muted
    footerLock.imageScaling = .scaleProportionallyDown
    footerLock.translatesAutoresizingMaskIntoConstraints = false
    footerLock.setAccessibilityElement(false)

    let footerRow = NSStackView(views: [footerLock, footerLabel])
    footerRow.orientation = .horizontal
    footerRow.alignment = .centerY
    footerRow.spacing = 8
    footerRow.translatesAutoresizingMaskIntoConstraints = false

    canvas.addSubview(progressView)
    canvas.addSubview(mainRow)
    canvas.addSubview(footerRow)

    NSLayoutConstraint.activate([
      progressView.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 42),
      progressView.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -42),
      progressView.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 66),
      progressView.heightAnchor.constraint(equalToConstant: 46),

      mainRow.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 42),
      mainRow.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -42),
      mainRow.centerYAnchor.constraint(equalTo: canvas.centerYAnchor, constant: -14),
      mainRow.topAnchor.constraint(greaterThanOrEqualTo: progressView.bottomAnchor, constant: 40),
      mainRow.bottomAnchor.constraint(lessThanOrEqualTo: footerRow.topAnchor, constant: -40),

      copyStack.widthAnchor.constraint(equalToConstant: 424),
      heroContainer.widthAnchor.constraint(equalToConstant: 176),
      heroContainer.heightAnchor.constraint(equalToConstant: 176),
      heroImage.widthAnchor.constraint(equalToConstant: 176),
      heroImage.heightAnchor.constraint(equalToConstant: 176),
      heroImage.leadingAnchor.constraint(equalTo: heroContainer.leadingAnchor),
      heroImage.topAnchor.constraint(equalTo: heroContainer.topAnchor),
      agentPicker.leadingAnchor.constraint(equalTo: heroContainer.leadingAnchor),
      agentPicker.trailingAnchor.constraint(equalTo: heroContainer.trailingAnchor),
      agentPicker.topAnchor.constraint(equalTo: heroContainer.topAnchor),
      agentPicker.bottomAnchor.constraint(equalTo: heroContainer.bottomAnchor),

      primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 190),
      primaryButton.heightAnchor.constraint(equalToConstant: 54),

      footerRow.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 42),
      footerRow.trailingAnchor.constraint(lessThanOrEqualTo: canvas.trailingAnchor, constant: -42),
      footerRow.bottomAnchor.constraint(equalTo: canvas.safeAreaLayoutGuide.bottomAnchor, constant: -28),
      footerLock.widthAnchor.constraint(equalToConstant: 13),
      footerLock.heightAnchor.constraint(equalToConstant: 13)
    ])
  }

  private func buildMenu() {
    let mainMenu = NSMenu()
    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)

    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "About Go Rot",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Repair Setup…",
      action: #selector(repairSetupPressed),
      keyEquivalent: ""
    ).target = self
    appMenu.addItem(
      withTitle: "Remove Go Rot Setup…",
      action: #selector(removeSetupPressed),
      keyEquivalent: ""
    ).target = self
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit Go Rot",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )
    appItem.submenu = appMenu

    let helpItem = NSMenuItem()
    let helpMenu = NSMenu(title: "Help")
    helpMenu.addItem(
      withTitle: "Go Rot Support",
      action: #selector(openSupportPressed),
      keyEquivalent: ""
    ).target = self
    helpItem.submenu = helpMenu
    mainMenu.addItem(helpItem)
    NSApp.mainMenu = mainMenu
  }

  private func showWelcome() {
    render(
      stage: .welcome,
      eyebrow: "ONE QUICK SETUP",
      headline: "Prompt your agent.\nGo rot.",
      body: "Go Rot needs two local pieces: the Mac companion and the Chrome extension. This takes about a minute.",
      state: "",
      button: "Set up Go Rot",
      buttonEnabled: true,
      footer: "Local only  ·  No account  ·  Nothing leaves your Mac",
      action: { [weak self] in self?.showAgentChoice(reset: true) }
    )
  }

  private func showAgentChoice(reset: Bool) {
    if reset { agentPicker.setSelection(codex: false, claude: false) }
    render(
      stage: .agents,
      eyebrow: "CHOOSE YOUR AGENTS",
      headline: "Where should\nGo Rot listen?",
      body: "Choose where Go Rot can watch agent status. We’ll add local hooks only to the tools you select and preserve every other setting.",
      state: selectionStatusText(),
      button: "Install selected",
      buttonEnabled: !agentPicker.selectedTargets.isEmpty,
      footer: "Nothing changes until you choose and continue",
      action: { [weak self] in self?.startSelectedSetup() }
    )
  }

  private func showInstalling(selectedAgents: [String]) {
    let agents = selectedAgents.map { $0 == "codex" ? "Codex" : "Claude" }
    let agentList = agents.count == 2 ? agents.joined(separator: " and ") : agents[0]
    render(
      stage: .installing,
      eyebrow: "SETTING UP YOUR MAC",
      headline: "Installing Go Rot.",
      body: "Adding Go Rot to \(agentList) and creating a private bridge to Chrome. Every unrelated setting stays intact.",
      state: "Installing… this usually takes a few seconds.",
      button: "",
      buttonEnabled: false,
      footer: "Your agent keeps working even if Go Rot is closed",
      action: nil
    )
  }

  private func showChrome() {
    render(
      stage: .chrome,
      eyebrow: "ONE QUICK STEP",
      headline: "Finish in Chrome.",
      body: "Chrome is open to Go Rot. Choose Add to Chrome there—we’ll notice as soon as it connects.",
      state: "Waiting for the Chrome extension…",
      button: "Open in Chrome",
      buttonEnabled: true,
      footer: "The extension uses your ordinary signed-in Chrome profile",
      action: { [weak self] in self?.openChromeStore() }
    )
    startReadinessPolling()
  }

  private func showReady(requestNotifications: Bool = true) {
    readinessTimer?.invalidate()
    render(
      stage: .ready,
      eyebrow: "YOU’RE ALL SET",
      headline: "Ready to rot.",
      body: "Prompt Codex or Claude. Your feed will open while it works and disappear when it needs you. Codex may ask you to trust Go Rot once.",
      state: "Mac companion and Chrome extension connected.",
      button: "Done",
      buttonEnabled: true,
      footer: "Local only  ·  No account  ·  Nothing leaves your Mac",
      action: { NSApp.terminate(nil) }
    )
    if requestNotifications && !isPreview {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        UNUserNotificationCenter.current().requestAuthorization(
          options: [.alert, .sound]
        ) { _, _ in }
      }
    }
  }

  private func showFailure(_ message: String, retry: @escaping () -> Void) {
    readinessTimer?.invalidate()
    render(
      stage: .failure,
      eyebrow: "SETUP NEEDS ATTENTION",
      headline: "That didn’t finish.",
      body: message,
      state: "Nothing was removed. You can safely try again.",
      button: "Try again",
      buttonEnabled: true,
      footer: "Need a hand? Choose Go Rot Support from the Help menu",
      action: retry
    )
  }

  private func render(
    stage: SetupStage,
    eyebrow: String,
    headline: String,
    body: String,
    state: String,
    button: String,
    buttonEnabled: Bool,
    footer: String,
    action: (() -> Void)?
  ) {
    if stage != .failure { lastProgressStage = stage }
    currentStage = stage
    primaryAction = action
    progressView.stage = stage == .failure ? lastProgressStage : stage
    eyebrowLabel.stringValue = eyebrow
    headlineLabel.stringValue = headline
    bodyLabel.stringValue = body
    stateLabel.stringValue = state
    stateLabel.textColor = stage == .failure ? Brand.danger : (stage == .ready ? Brand.mint : Brand.muted)
    stateLabel.isHidden = state.isEmpty
    primaryButton.setTitle(button)
    primaryButton.isEnabled = buttonEnabled
    primaryButton.isHidden = button.isEmpty
    footerLabel.stringValue = footer
    heroImage.image = stage == .failure ? failureImage() : spiralImage()
    heroImage.contentTintColor = stage == .failure ? Brand.danger : nil
    heroImage.alphaValue = stage == .installing ? 0.55 : 0.92
    heroImage.isHidden = stage == .agents
    agentPicker.isHidden = stage != .agents

    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    guard !reduceMotion else { return }
    heroImage.animator().alphaValue = stage == .installing ? 0.55 : 0.92
  }

  @objc private func primaryPressed() {
    if isPreview {
      advanceInteractivePreview()
      return
    }
    primaryAction?()
  }

  @objc private func agentSelectionChanged() {
    let hasSelection = !agentPicker.selectedTargets.isEmpty
    primaryButton.isEnabled = hasSelection
    stateLabel.stringValue = selectionStatusText()
    stateLabel.isHidden = false
  }

  private func selectionStatusText() -> String {
    let selected = agentPicker.selectedTargets
    if selected.isEmpty { return "Choose Codex, Claude, or both." }
    if selected.count == 2 { return "Codex and Claude selected." }
    return selected[0] == "codex" ? "Codex selected." : "Claude selected."
  }

  private func advanceInteractivePreview() {
    switch currentStage {
    case .welcome:
      showAgentChoice(reset: true)
    case .agents:
      let selected = agentPicker.selectedTargets
      guard !selected.isEmpty else { return }
      showInstalling(selectedAgents: selected)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
        guard self?.currentStage == .installing else { return }
        self?.showChrome()
        self?.openChromeStore()
      }
    case .chrome:
      openChromeStore()
    case .ready:
      NSApp.terminate(nil)
    case .failure:
      showWelcome()
    case .installing:
      break
    }
  }

  @objc private func repairSetupPressed() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    let installed = goRotInstalledAgentTargets()
    agentPicker.setSelection(
      codex: installed.contains("codex"),
      claude: installed.contains("claude")
    )
    showAgentChoice(reset: false)
  }

  @objc private func removeSetupPressed() {
    let alert = NSAlert()
    alert.messageText = "Remove Go Rot setup?"
    alert.informativeText = "This removes Go Rot’s agent hooks and local Chrome companion. Unrelated Codex and Claude settings stay intact."
    alert.addButton(withTitle: "Remove setup")
    alert.addButton(withTitle: "Keep Go Rot")
    alert.alertStyle = .warning
    guard alert.runModal() == .alertFirstButtonReturn else { return }

    runBundledScript("scripts/install.mjs", arguments: ["uninstall", "--all"]) { [weak self] status, _ in
      DispatchQueue.main.async {
        if status == 0 {
          self?.recycleApplication()
        } else {
          self?.showFailure(
            "Go Rot couldn’t remove its local setup. Restart your Mac and try again.",
            retry: { [weak self] in self?.removeSetupPressed() }
          )
        }
      }
    }
  }

  @objc private func openSupportPressed() {
    NSWorkspace.shared.open(URL(string: "https://gorot.dev/support.html")!)
  }

  private func startSelectedSetup() {
    let selected = agentPicker.selectedTargets
    guard !selected.isEmpty else { return }
    showInstalling(selectedAgents: selected)
    let arguments = ["configure"] + selected.map { "--\($0)" }
    runBundledScript("scripts/install.mjs", arguments: arguments) { [weak self] status, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        guard status == 0 else {
          self.showFailure(
            "Go Rot couldn’t install its Mac companion. Check that the app is in Applications, then try again.",
            retry: { [weak self] in self?.startSelectedSetup() }
          )
          return
        }

        if setupIsReady() {
          self.showReady()
        } else {
          self.showChrome()
          self.openChromeStore()
        }
      }
    }
  }

  private func openChromeStore() {
    guard let id = expectedChromeExtensionID() else {
      showFailure(
        "This build is missing its Chrome extension ID. Download the latest Go Rot installer and try again.",
        retry: { [weak self] in self?.openChromeStore() }
      )
      return
    }
    guard let chrome = NSWorkspace.shared.urlForApplication(
      withBundleIdentifier: "com.google.Chrome"
    ) else {
      showFailure(
        "Google Chrome isn’t installed. Install Chrome, then try again.",
        retry: { [weak self] in self?.openChromeStore() }
      )
      return
    }

    let url = URL(string: "https://chromewebstore.google.com/detail/\(id)")!
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.open(
      [url],
      withApplicationAt: chrome,
      configuration: configuration
    ) { [weak self] _, error in
      guard error != nil else { return }
      DispatchQueue.main.async {
        self?.showFailure(
          "Chrome couldn’t open the Go Rot listing. Make sure Chrome can launch, then try again.",
          retry: { [weak self] in self?.openChromeStore() }
        )
      }
    }
  }

  private func startReadinessPolling() {
    readinessTimer?.invalidate()
    readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      if setupIsReady() {
        timer.invalidate()
        self.showReady()
      }
    }
  }

  private func runBundledScript(
    _ script: String,
    arguments: [String],
    completion: @escaping (Int32, String) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      process.executableURL = self.runtimeURL()
      process.arguments = [self.appResourcesURL().appendingPathComponent(script).path] + arguments
      var environment = ProcessInfo.processInfo.environment
      environment["GO_ROT_APP_BUNDLE"] = Bundle.main.bundlePath
      environment["GO_ROT_NODE"] = self.runtimeURL().path
      process.environment = environment

      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      do {
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        completion(process.terminationStatus, output)
      } catch {
        completion(1, error.localizedDescription)
      }
    }
  }

  private func showPreview(named name: String) {
    switch name {
    case "agents":
      showAgentChoice(reset: true)
    case "installing":
      showInstalling(selectedAgents: ["codex", "claude"])
    case "chrome":
      showChrome()
      readinessTimer?.invalidate()
    case "ready":
      showReady(requestNotifications: false)
    case "failure":
      showFailure(
        "Go Rot couldn’t install its Mac companion. Check that the app is in Applications, then try again.",
        retry: {}
      )
    default:
      showWelcome()
    }
  }

  private func schedulePreviewCapturesIfRequested() {
    guard
      isPreview,
      let directory = ProcessInfo.processInfo.environment["GO_ROT_ONBOARDING_CAPTURE_DIR"]
    else { return }

    let states = ["welcome", "agents", "installing", "chrome", "ready", "failure"]
    for (index, state) in states.enumerated() {
      let presentationDelay = 0.2 + Double(index) * 0.8
      DispatchQueue.main.asyncAfter(deadline: .now() + presentationDelay) { [weak self] in
        guard let self else { return }
        self.showPreview(named: state)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
          guard let self else { return }
          self.window.contentView?.layoutSubtreeIfNeeded()
          self.capturePreview(
            at: URL(fileURLWithPath: directory, isDirectory: true)
              .appendingPathComponent("\(state).png")
          )
          if index == states.count - 1 {
            NSApp.terminate(nil)
          }
        }
      }
    }
  }

  private func capturePreview(at url: URL) {
    guard
      let view = window.contentView,
      let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)
    else { return }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { return }
    try? data.write(to: url, options: .atomic)
  }

  private func spiralImage() -> NSImage {
    let bundled = appResourcesURL()
      .appendingPathComponent("extension/assets/icon.svg")
    return NSImage(contentsOf: bundled)
      ?? NSImage(named: NSImage.applicationIconName)
      ?? NSImage(size: NSSize(width: 128, height: 128))
  }

  private func failureImage() -> NSImage {
    NSImage(
      systemSymbolName: "exclamationmark.circle",
      accessibilityDescription: "Setup needs attention"
    ) ?? spiralImage()
  }

  private func textLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = font
    field.textColor = color
    field.backgroundColor = .clear
    field.isSelectable = false
    return field
  }

  private func appResourcesURL() -> URL {
    Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
  }

  private func runtimeURL() -> URL {
    #if arch(arm64)
      let architecture = "arm64"
    #else
      let architecture = "x86_64"
    #endif
    return Bundle.main.bundleURL
      .appendingPathComponent("Contents/Frameworks/node/\(architecture)/bin/node")
  }

  private func recycleApplication() {
    NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { [weak self] _, error in
      DispatchQueue.main.async {
        if let error {
          self?.showFailure(
            "The local setup was removed, but Go Rot.app couldn’t be moved to Trash: \(error.localizedDescription)",
            retry: { NSApp.terminate(nil) }
          )
        } else {
          NSApp.terminate(nil)
        }
      }
    }
  }
}

private final class CanvasView: NSView {
  private let color: NSColor

  init(color: NSColor) {
    self.color = color
    super.init(frame: .zero)
  }

  required init?(coder: NSCoder) {
    nil
  }

  override func draw(_ dirtyRect: NSRect) {
    color.setFill()
    dirtyRect.fill()
  }
}

private final class AgentSelectionView: NSView {
  private let codexButton: NSButton
  private let claudeButton: NSButton

  var selectedTargets: [String] {
    var targets: [String] = []
    if codexButton.state == .on { targets.append("codex") }
    if claudeButton.state == .on { targets.append("claude") }
    return targets
  }

  init(target: AnyObject?, action: Selector?) {
    codexButton = NSButton(
      checkboxWithTitle: "Codex",
      target: target,
      action: action
    )
    claudeButton = NSButton(
      checkboxWithTitle: "Claude",
      target: target,
      action: action
    )
    super.init(frame: .zero)

    let heading = NSTextField(labelWithString: "INSTALL FOR")
    heading.font = .systemFont(ofSize: 11, weight: .bold)
    heading.textColor = Brand.muted
    heading.setAccessibilityRole(.staticText)

    configure(
      codexButton,
      help: "Adds Go Rot lifecycle hooks to Codex CLI and the Codex desktop app."
    )
    configure(
      claudeButton,
      help: "Adds Go Rot lifecycle hooks to Claude Code and compatible Claude desktop sessions."
    )

    let stack = NSStackView(views: [heading, codexButton, claudeButton])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.setCustomSpacing(17, after: heading)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      codexButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
      claudeButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 40)
    ])
  }

  required init?(coder: NSCoder) {
    nil
  }

  func setSelection(codex: Bool, claude: Bool) {
    codexButton.state = codex ? .on : .off
    claudeButton.state = claude ? .on : .off
  }

  private func configure(_ button: NSButton, help: String) {
    button.font = .systemFont(ofSize: 16, weight: .semibold)
    button.contentTintColor = Brand.lilac
    button.setAccessibilityHelp(help)
    button.focusRingType = .default
  }
}

private final class BrandButton: NSButton {
  private var trackingArea: NSTrackingArea?
  private var pointerInside = false
  private var displayTitle = ""

  init(title: String, target: AnyObject?, action: Selector?) {
    super.init(frame: .zero)
    self.target = target
    self.action = action
    isBordered = false
    wantsLayer = true
    layer?.cornerRadius = 11
    focusRingType = .exterior
    setButtonType(.momentaryChange)
    setTitle(title)
    updateAppearance()
  }

  required init?(coder: NSCoder) {
    nil
  }

  override var isHighlighted: Bool {
    didSet { updateAppearance() }
  }

  override var isEnabled: Bool {
    didSet {
      updateAppearance()
      window?.invalidateCursorRects(for: self)
    }
  }

  func setTitle(_ value: String) {
    displayTitle = value
    updateTitleAppearance()
    setAccessibilityLabel(value)
  }

  private func updateTitleAppearance() {
    attributedTitle = NSAttributedString(
      string: displayTitle,
      attributes: [
        .font: NSFont.systemFont(ofSize: 16, weight: .bold),
        .foregroundColor: isEnabled ? Brand.paper : Brand.muted
      ]
    )
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea { removeTrackingArea(trackingArea) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .activeInKeyWindow],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) {
    pointerInside = true
    updateAppearance()
  }

  override func mouseExited(with event: NSEvent) {
    pointerInside = false
    updateAppearance()
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(bounds, cursor: .pointingHand) }
  }

  private func updateAppearance() {
    alphaValue = 1
    updateTitleAppearance()
    if !isEnabled {
      layer?.backgroundColor = Brand.lilacSoft.cgColor
    } else if isHighlighted {
      layer?.backgroundColor = Brand.lilac.cgColor
    } else if pointerInside && isEnabled {
      layer?.backgroundColor = Brand.graphiteRaised.cgColor
    } else {
      layer?.backgroundColor = Brand.graphite.cgColor
    }
  }
}

private final class SetupProgressView: NSView {
  var stage = SetupStage.welcome {
    didSet {
      needsDisplay = true
      setAccessibilityValue(accessibilityValueText())
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    setAccessibilityElement(true)
    setAccessibilityRole(.progressIndicator)
    setAccessibilityLabel("Setup progress")
    setAccessibilityValue(accessibilityValueText())
  }

  required init?(coder: NSCoder) {
    nil
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let labels = ["MAC", "CHROME", "READY"]
    let active = activeIndex()
    let centerY: CGFloat = bounds.height - 13
    let left: CGFloat = 13
    let right = bounds.width - 13
    let positions = [left, bounds.midX, right]

    for index in 0..<2 {
      let segment = NSBezierPath(
        roundedRect: NSRect(
          x: positions[index] + 11,
          y: centerY - 1.25,
          width: positions[index + 1] - positions[index] - 22,
          height: 2.5
        ),
        xRadius: 1.25,
        yRadius: 1.25
      )
      (active > index ? Brand.mint : Brand.ruleStrong).setFill()
      segment.fill()
    }

    for index in 0..<3 {
      let completed = active > index || (stage == .ready && index == active)
      let current = active == index
      let circle = NSBezierPath(
        ovalIn: NSRect(
          x: positions[index] - 10,
          y: centerY - 10,
          width: 20,
          height: 20
        )
      )
      (completed ? Brand.mint : current ? Brand.lilac : Brand.canvas).setFill()
      circle.fill()
      (completed ? Brand.mint : current ? Brand.lilac : Brand.rule).setStroke()
      circle.lineWidth = 2
      circle.stroke()

      let number = completed ? "✓" : "\(index + 1)"
      let numberColor = completed || current ? Brand.paper : Brand.muted
      let numberAttributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 10, weight: .bold),
        .foregroundColor: numberColor
      ]
      let numberSize = number.size(withAttributes: numberAttributes)
      number.draw(
        at: NSPoint(
          x: positions[index] - numberSize.width / 2,
          y: centerY - numberSize.height / 2 - 1
        ),
        withAttributes: numberAttributes
      )

      let labelColor = current || completed ? Brand.graphite : Brand.muted
      let labelAttributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 10, weight: .bold),
        .foregroundColor: labelColor,
        .kern: 0.8
      ]
      let labelSize = labels[index].size(withAttributes: labelAttributes)
      labels[index].draw(
        at: NSPoint(x: positions[index] - labelSize.width / 2, y: 0),
        withAttributes: labelAttributes
      )
    }
  }

  private func activeIndex() -> Int {
    switch stage {
    case .welcome, .agents, .installing, .failure:
      return 0
    case .chrome:
      return 1
    case .ready:
      return 2
    }
  }

  private func accessibilityValueText() -> String {
    switch activeIndex() {
    case 1:
      return "Step 2 of 3, Chrome"
    case 2:
      return "Step 3 of 3, ready"
    default:
      return "Step 1 of 3, Mac"
    }
  }
}

private extension NSColor {
  convenience init(hex: Int) {
    self.init(
      calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
      green: CGFloat((hex >> 8) & 0xff) / 255,
      blue: CGFloat(hex & 0xff) / 255,
      alpha: 1
    )
  }
}

private let goRotNativeHostName = "dev.gorot.companion"

private func goRotHomeDirectory() -> URL {
  if let configured = ProcessInfo.processInfo.environment["GO_ROT_HOME"],
     !configured.isEmpty {
    return URL(fileURLWithPath: configured, isDirectory: true)
  }
  return FileManager.default.homeDirectoryForCurrentUser
}

private func goRotInstalledAgentTargets() -> Set<String> {
  let home = goRotHomeDirectory()
  let configs = [
    "codex": home.appendingPathComponent(".codex/hooks.json"),
    "claude": home.appendingPathComponent(".claude/settings.json")
  ]
  return Set(configs.compactMap { agent, url in
    guard
      let data = try? Data(contentsOf: url),
      let source = String(data: data, encoding: .utf8),
      source.contains("GO_ROT_HOOK")
    else {
      return nil
    }
    return agent
  })
}

private func setupIsReady() -> Bool {
  !goRotInstalledAgentTargets().isEmpty && companionSocketIsReachable()
}

private func companionRuntimeDirectory() -> URL {
  if let configured = ProcessInfo.processInfo.environment["GO_ROT_RUNTIME_DIR"],
     !configured.isEmpty {
    return URL(fileURLWithPath: configured, isDirectory: true)
      .standardizedFileURL
  }
  return URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .appendingPathComponent("go-rot-\(getuid())", isDirectory: true)
}

private func companionSocketPath() -> String {
  companionRuntimeDirectory()
    .appendingPathComponent("companion.sock")
    .path
}

private func companionSocketIsReachable() -> Bool {
  guard companionIdentityMatchesProductionExtension() else { return false }
  let socket = companionSocketPath()
  guard socket.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else { return false }

  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { return false }
  defer { Darwin.close(descriptor) }

  var address = sockaddr_un()
  address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  address.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &address.sun_path) { destination in
    socket.withCString { source in
      _ = memcpy(
        destination.baseAddress,
        source,
        min(destination.count, Int(strlen(source)) + 1)
      )
    }
  }

  return withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
      Darwin.connect(
        descriptor,
        socketAddress,
        socklen_t(MemoryLayout<sockaddr_un>.size)
      ) == 0
    }
  }
}

private func companionIdentityMatchesProductionExtension() -> Bool {
  guard let expectedID = expectedChromeExtensionID() else { return false }
  let identityURL = companionRuntimeDirectory().appendingPathComponent("companion.json")
  guard
    let data = try? Data(contentsOf: identityURL),
    let identity = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    identity["host"] as? String == goRotNativeHostName,
    (identity["protocolVersion"] as? NSNumber)?.intValue == 1,
    identity["extensionId"] as? String == expectedID
  else {
    return false
  }
  return true
}

private func expectedChromeExtensionID() -> String? {
  if let configured = ProcessInfo.processInfo.environment["GO_ROT_EXPECTED_EXTENSION_ID"],
     configured.range(of: "^[a-p]{32}$", options: .regularExpression) != nil {
    return configured
  }
  guard
    let resources = Bundle.main.resourceURL,
    let data = try? Data(
      contentsOf: resources
        .appendingPathComponent("app", isDirectory: true)
        .appendingPathComponent("release/release-contract.json")
    ),
    let contract = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let identifiers = contract["identifiers"] as? [String: Any],
    let id = identifiers["chromeExtension"] as? String,
    id.range(of: "^[a-p]{32}$", options: .regularExpression) != nil
  else {
    return nil
  }
  return id
}

private func deliverNotification(_ body: String) {
  let application = NSApplication.shared
  application.setActivationPolicy(.prohibited)
  let center = UNUserNotificationCenter.current()
  let completed = DispatchSemaphore(value: 0)

  center.getNotificationSettings { settings in
    guard [.authorized, .provisional].contains(settings.authorizationStatus) else {
      completed.signal()
      return
    }

    let content = UNMutableNotificationContent()
    content.title = "Go Rot"
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(
      identifier: UUID().uuidString,
      content: content,
      trigger: nil
    )
    center.add(request) { _ in completed.signal() }
  }

  _ = completed.wait(timeout: .now() + 2)
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--check-readiness" {
  let ready = setupIsReady()
  print(ready ? "ready" : "waiting")
  Darwin.exit(ready ? EXIT_SUCCESS : EXIT_FAILURE)
} else if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--notify" {
  deliverNotification(CommandLine.arguments.dropFirst(2).joined(separator: " "))
} else {
  let application = NSApplication.shared
  let delegate = AppDelegate()
  application.delegate = delegate
  application.run()
}
