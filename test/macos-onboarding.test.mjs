import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "release", "macos", "GoRotApp.swift"),
  "utf8"
);

test("macOS onboarding presents one guided primary action", () => {
  assert.equal((source.match(/BrandButton\(title:/g) ?? []).length, 1);
  assert.match(source, /button: "Set up Go Rot"/);
  assert.match(source, /button: "Open in Chrome"/);
  assert.match(source, /button: "Done"/);
  assert.doesNotMatch(source, /button\("Check readiness"/);
  assert.doesNotMatch(source, /button\("Add to Chrome"/);
  assert.doesNotMatch(source, /NSBox\(\)/);
});

test("macOS onboarding explains both required product pieces", () => {
  assert.match(source, /Mac companion and the Chrome extension/);
  assert.match(source, /Choose Add to Chrome there/);
  assert.match(source, /Mac companion and Chrome extension connected/);
  assert.match(source, /ONE QUICK SETUP/);
  assert.match(source, /Ready to rot/);
});

test("macOS onboarding asks which agents may receive local hooks", () => {
  assert.match(source, /CHOOSE YOUR AGENTS/);
  assert.match(source, /checkboxWithTitle: "Codex"/);
  assert.match(source, /checkboxWithTitle: "Claude"/);
  assert.match(source, /button: "Install selected"/);
  assert.match(source, /buttonEnabled: !agentPicker\.selectedTargets\.isEmpty/);
  assert.match(source, /agentPicker\.setSelection\(codex: false, claude: false\)/);
  assert.match(source, /let arguments = \["configure"\]/);
  assert.match(source, /preserve every other setting/);
});

test("agent choices have a real hit area and disabled actions do not suggest clicks", () => {
  assert.match(source, /agentPicker\.topAnchor\.constraint\(equalTo: heroContainer\.topAnchor\)/);
  assert.match(source, /agentPicker\.bottomAnchor\.constraint\(equalTo: heroContainer\.bottomAnchor\)/);
  assert.match(source, /if isEnabled \{ addCursorRect\(bounds, cursor: \.pointingHand\) \}/);
  assert.match(source, /if !isEnabled \{\s*layer\?\.backgroundColor = Brand\.lilacSoft\.cgColor/);
  assert.doesNotMatch(source, /NSCursor\.pointingHand\.push/);
});

test("macOS onboarding opens Chrome and detects readiness automatically", () => {
  assert.match(source, /withBundleIdentifier: "com\.google\.Chrome"/);
  assert.match(source, /chromewebstore\.google\.com\/detail/);
  assert.match(source, /Timer\.scheduledTimer\(withTimeInterval: 0\.8/);
  assert.match(source, /companion\.sock/);
  assert.match(source, /companion\.json/);
  assert.match(source, /companionIdentityMatchesProductionExtension/);
  assert.match(source, /GO_ROT_RUNTIME_DIR/);
  assert.match(source, /--check-readiness/);
  assert.match(source, /goRotInstalledAgentTargets/);
  assert.match(source, /setupIsReady/);
  assert.match(source, /Darwin\.connect/);
  assert.doesNotMatch(source, /FileAttributeType == \.typeSocket/);
  assert.match(source, /showReady\(\)/);
});

test("interactive preview never fakes Chrome readiness", () => {
  const previewChromeCase = source.match(
    /case \.chrome:\s*([\s\S]*?)\s*case \.ready:/
  )?.[1] ?? "";
  assert.match(previewChromeCase, /openChromeStore\(\)/);
  assert.doesNotMatch(previewChromeCase, /showReady/);
});

test("repair and removal stay out of the first-run path", () => {
  assert.match(source, /withTitle: "Repair Setup…"/);
  assert.match(source, /withTitle: "Remove Go Rot Setup…"/);
  assert.match(source, /let mainMenu = NSMenu\(\)/);
  assert.doesNotMatch(source, /let statusBox = NSBox/);
});

test("accepted welcome composition keeps its progress rail, centered hero, and inset privacy footer", () => {
  assert.match(source, /progressView\.topAnchor\.constraint\(equalTo: canvas\.topAnchor, constant: 66\)/);
  assert.match(source, /mainRow\.alignment = \.centerY/);
  assert.match(source, /mainRow\.centerYAnchor\.constraint\(equalTo: canvas\.centerYAnchor, constant: -14\)/);
  assert.match(source, /systemSymbolName: "lock\.fill"/);
  assert.match(source, /footerRow\.bottomAnchor\.constraint\(equalTo: canvas\.safeAreaLayoutGuide\.bottomAnchor, constant: -28\)/);
  assert.match(source, /for index in 0\.\.<2/);
});
