# Go Rot

Prompt your agent. Go rot.

Go Rot opens your real YouTube Shorts, TikTok, or Instagram Reels feed while
Codex or Claude works. When the agent needs you, your feed gets out of the way.
When the work is done, it closes.

It runs locally on your Mac, uses your normal Chrome profile, and never reads
your prompts, answers, source code, cookies, or feed content.

## Install

Get Go Rot from [gorot.dev](https://gorot.dev):

1. Install the Mac app.
2. Open **Go Rot** and choose **Install or repair setup**.
3. Add the Chrome extension.

Go Rot supports macOS 13 or newer, Google Chrome, Codex, and Claude Code.
The Mac app includes everything it needs. If something does not connect, see
[setup and support](https://gorot.dev/support.html).

## Develop locally

You need Node.js 20 or newer.

```sh
npm test
npm run setup
```

Then open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select the `extension` folder.

Remove the local setup with:

```sh
npm run remove
```

## Privacy

No account. No analytics. No remote service. Go Rot exchanges content-free
lifecycle signals between your agent, its local Mac companion, and Chrome.
