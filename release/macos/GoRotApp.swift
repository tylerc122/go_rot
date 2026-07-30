import Cocoa
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var statusLabel: NSTextField!
  private var progress: NSProgressIndicator!
  private var actionButtons: [NSButton] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound]
    ) { _, _ in }

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 620, height: 520),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Go Rot Setup"
    window.center()
    window.isReleasedWhenClosed = false
    self.window = window

    let title = label(
      "Go Rot",
      font: .systemFont(ofSize: 30, weight: .bold),
      color: .labelColor
    )
    let subtitle = label(
      "Prompt your agent. Go rot. Come back when it’s cooked.",
      font: .systemFont(ofSize: 15, weight: .regular),
      color: .secondaryLabelColor
    )
    subtitle.maximumNumberOfLines = 2

    let explanation = label(
      "Set up the local companion and merge Go Rot’s lifecycle hooks into Codex and Claude. Existing settings are preserved.",
      font: .systemFont(ofSize: 13),
      color: .labelColor
    )
    explanation.maximumNumberOfLines = 3

    let setup = button("Install or repair setup", action: #selector(setupPressed))
    let check = button("Check readiness", action: #selector(checkPressed))
    let chrome = button("Add to Chrome", action: #selector(chromePressed))
    let remove = button("Remove Go Rot setup", action: #selector(removePressed))
    remove.bezelColor = .systemRed
    actionButtons = [setup, check, chrome, remove]

    let actions = NSStackView(views: [setup, check, chrome, remove])
    actions.orientation = .vertical
    actions.alignment = .leading
    actions.spacing = 10

    progress = NSProgressIndicator()
    progress.style = .spinning
    progress.controlSize = .small
    progress.isDisplayedWhenStopped = false

    statusLabel = label(
      "Choose Install or repair setup to begin.",
      font: .monospacedSystemFont(ofSize: 12, weight: .regular),
      color: .secondaryLabelColor
    )
    statusLabel.maximumNumberOfLines = 12
    statusLabel.lineBreakMode = .byWordWrapping

    let statusBox = NSBox()
    statusBox.title = "Status"
    statusBox.contentViewMargins = NSSize(width: 14, height: 12)
    statusBox.contentView = statusLabel
    statusBox.heightAnchor.constraint(greaterThanOrEqualToConstant: 150).isActive = true

    let stack = NSStackView(views: [title, subtitle, explanation, actions, progress, statusBox])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    window.contentView?.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 30),
      stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -30),
      stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 28),
      statusBox.widthAnchor.constraint(equalTo: stack.widthAnchor)
    ])

    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  @objc private func setupPressed() {
    run(script: "scripts/install.mjs", arguments: ["install", "--all"])
  }

  @objc private func checkPressed() {
    run(script: "scripts/doctor.mjs", arguments: [])
  }

  @objc private func removePressed() {
    let alert = NSAlert()
    alert.messageText = "Remove Go Rot setup?"
    alert.informativeText = "This removes Go Rot’s agent hooks, Chrome companion manifest, and local receiver configuration. It preserves unrelated Codex and Claude settings."
    alert.addButton(withTitle: "Remove setup")
    alert.addButton(withTitle: "Cancel")
    alert.alertStyle = .warning
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    run(
      script: "scripts/install.mjs",
      arguments: ["uninstall", "--all"],
      trashAppOnSuccess: true
    )
  }

  @objc private func chromePressed() {
    guard let id = chromeExtensionID() else {
      statusLabel.stringValue = "The Chrome Web Store link is missing from this build."
      return
    }
    let url = URL(string: "https://chromewebstore.google.com/detail/\(id)")!
    NSWorkspace.shared.open(url)
  }

  private func chromeExtensionID() -> String? {
    let contractURL = appResourcesURL()
      .appendingPathComponent("release/release-contract.json")
    guard
      let data = try? Data(contentsOf: contractURL),
      let contract = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let identifiers = contract["identifiers"] as? [String: Any],
      let id = identifiers["chromeExtension"] as? String,
      id.range(of: "^[a-p]{32}$", options: .regularExpression) != nil
    else {
      return nil
    }
    return id
  }

  private func run(
    script: String,
    arguments: [String],
    trashAppOnSuccess: Bool = false
  ) {
    setBusy(true)
    statusLabel.stringValue = "Working…"

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
        let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        DispatchQueue.main.async {
          self.statusLabel.stringValue = output.isEmpty
            ? (process.terminationStatus == 0 ? "Done." : "The operation failed.")
            : output
          self.setBusy(false)
          if trashAppOnSuccess && process.terminationStatus == 0 {
            self.recycleApplication()
          }
        }
      } catch {
        DispatchQueue.main.async {
          self.statusLabel.stringValue = "Could not run Go Rot setup: \(error.localizedDescription)"
          self.setBusy(false)
        }
      }
    }
  }

  private func recycleApplication() {
    NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { _, error in
      DispatchQueue.main.async {
        if let error {
          self.statusLabel.stringValue += "\n\nSetup was removed. Move Go Rot.app to Trash to finish: \(error.localizedDescription)"
        } else {
          NSApp.terminate(nil)
        }
      }
    }
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

  private func setBusy(_ busy: Bool) {
    for button in actionButtons { button.isEnabled = !busy }
    busy ? progress.startAnimation(nil) : progress.stopAnimation(nil)
  }

  private func label(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = font
    field.textColor = color
    return field
  }

  private func button(_ title: String, action: Selector) -> NSButton {
    let button = NSButton(title: title, target: self, action: action)
    button.bezelStyle = .rounded
    button.controlSize = .large
    return button
  }
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

if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--notify" {
  deliverNotification(CommandLine.arguments.dropFirst(2).joined(separator: " "))
} else {
  let application = NSApplication.shared
  let delegate = AppDelegate()
  application.delegate = delegate
  application.run()
}
