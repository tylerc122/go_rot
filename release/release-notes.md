# Go Rot 0.1.2

Go Rot opens your short-form feed while Codex or Claude works, returns you when
the agent needs attention, and closes the feed when every tracked task is done.

This release switches Mac installation to the familiar drag-to-Applications
disk image, makes uninstalling visible from the Ready screen, and keeps agent
selection in the Mac app instead of duplicating it in the Chrome panel.

## Install

1. Download and open `go-rot-macos-v0.1.2.dmg`.
2. Drag **Go Rot** onto the **Applications** shortcut, then open Go Rot from
   Applications.
3. Choose **Set up Go Rot**, then select Codex, Claude, or both. Only the
   selected agent settings receive Go Rot hooks.
4. Choose **Install selected**. The app installs the local companion and opens
   Chrome automatically.
5. Choose **Add to Chrome** in the Chrome Web Store. The Mac app confirms when
   both pieces are connected.
6. Approve the Go Rot hooks if Codex or Claude asks the first time you use it.

To change the selected agents later, reopen Go Rot and choose **Change
agents…**, or use **Go Rot → Change Agents…** from the app menu.

The macOS disk image contains universal Apple silicon and Intel executables and a
pinned runtime. No separate Node.js installation or Go Rot account is required.

## Privacy

Go Rot runs locally. It has no analytics, telemetry, remote service, ads, or
developer-operated account system. It does not read prompts, answers, source
code, browser history, cookies, messages, likes, comments, or feed content.

## Known boundary

Codex Desktop's UI Stop action may not emit a usable lifecycle event. If Go Rot
still shows activity after a stopped task, use **Clear stuck** in the Chrome
toolbar panel.
