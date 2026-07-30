# Chrome Web Store Submission: Go Rot 0.1.0

## Store listing

**Name:** Go Rot

**Category:** Productivity

**Visibility:** Public

**Publishing:** Deferred (stage after review, then publish with the signed Mac
installer and website)

**Summary:** Open your short-form feed while Codex or Claude works, then return
when the agent needs you.

### Detailed description

Go Rot opens your real, signed-in short-form feed while Codex or Claude works,
then parks that same feed and brings your agent back when permission or input
is needed. After you respond, the same video resumes. When every tracked task is
ready, the feed closes.

What it does:

- Works with Codex and Claude lifecycle hooks on macOS.
- Opens YouTube Shorts, TikTok, or Instagram Reels in a dedicated Chrome
  window using your existing browser session.
- Returns immediately for permission and input, then resumes the exact feed.
- Handles concurrent agent tasks without opening extra feed windows.
- Offers optional local video pause and finish-current-clip behavior.
- Keeps settings and lifecycle state on your Mac.

Go Rot requires the companion installed by **Download for Mac** on the Go Rot
website. The extension cannot install a native companion by itself.

Privacy is intentionally boring: no account, analytics, telemetry, remote
service, ads, or developer-operated server. Go Rot does not read prompts,
answers, source code, browser history, cookies, messages, likes, comments, or
feed content.

Known boundary: Codex Desktop's UI Stop action may not emit a usable lifecycle
event. If activity remains after the agent stops, use **Clear stuck** in the Go
Rot panel.

## Privacy tab

**Single purpose:** Go Rot hands attention between a supported coding agent and
the user's chosen short-form feed.

**Remote code:** No. All executable extension code is included in the uploaded
Manifest V3 package.

**Data disclosure selections:** Do not select any collected-data category. Go
Rot stores settings and content-free operating state locally, but does not
transmit or collect user data for the developer. Use the permission
justifications in [`listing.json`](listing.json) verbatim where the dashboard
asks for them.

**Privacy policy URL:** `https://gorot.dev/privacy.html`

**Support URL:** `https://gorot.dev/support.html`

**Support fallback:** `https://github.com/tylerc122/go_rot/issues`

## Submission sequence

1. Register and verify the Chrome Web Store publisher account.
2. Upload `dist/go-rot-chrome-v0.1.0.zip` as a new item.
3. Copy the assigned item ID into
   `release/release-contract.json` as `identifiers.chromeExtension`. The local
   development ID remains separate.
4. Add the listing copy, privacy declarations, permission justifications, and
   images from `release/chrome-store/assets/`.
5. Use public visibility and deferred publishing.
6. Submit for review. Do not publish until the signed/notarized Mac package and
   live website URLs pass the release-candidate check.
