# Go Rot 0.1.1

Go Rot opens your short-form feed while Codex or Claude works, returns you when
the agent needs attention, and closes the feed when every tracked task is done.

## Install

1. Download `go-rot-macos-v0.1.1.pkg` and run it.
2. Open **Go Rot** from Applications.
3. Choose **Set up Go Rot**, then select Codex, Claude, or both. Only the
   selected agent settings receive Go Rot hooks.
4. Choose **Install selected**. The app installs the local companion and opens
   Chrome automatically.
5. Choose **Add to Chrome** in the Chrome Web Store. The Mac app confirms when
   both pieces are connected.
6. Approve the Go Rot hooks if Codex or Claude asks the first time you use it.

The macOS package contains universal Apple silicon and Intel executables and a
pinned runtime. No separate Node.js installation or Go Rot account is required.

## Privacy

Go Rot runs locally. It has no analytics, telemetry, remote service, ads, or
developer-operated account system. It does not read prompts, answers, source
code, browser history, cookies, messages, likes, comments, or feed content.

## Known boundary

Codex Desktop's UI Stop action may not emit a usable lifecycle event. If Go Rot
still shows activity after a stopped task, use **Clear stuck** in the Chrome
toolbar panel.
