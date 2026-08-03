import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "scripts", "package-release.mjs"),
  "utf8"
);
const backgroundSource = fs.readFileSync(
  path.join(root, "release", "macos", "DmgBackground.swift"),
  "utf8"
);

test("the production disk image provides a verified drag-to-Applications install", () => {
  assert.match(source, /fs\.symlinkSync\("\/Applications"/);
  assert.match(source, /"\/usr\/bin\/hdiutil"/);
  assert.match(source, /"create"/);
  assert.match(source, /"-format", "UDRW"/);
  assert.match(source, /"-srcfolder", diskImageRoot/);
  assert.match(source, /DmgBackground\.swift/);
  assert.match(source, /install-background\.png/);
  assert.match(source, /pixelWidth: 5120/);
  assert.match(source, /pixelHeight: 3200/);
  assert.match(source, /set background picture of viewOptions/);
  assert.match(source, /\.app" to \{205, 243\}/);
  assert.match(source, /"Applications" to \{515, 243\}/);
  assert.match(source, /"convert"/);
  assert.match(source, /"-format", "UDZO"/);
  assert.match(source, /"verify", artifact/);
  assert.match(source, /"attach"/);
  assert.match(source, /fs\.readlinkSync\(applicationsLink\) !== "\/Applications"/);
  assert.match(source, /Disk image is missing its Finder window layout/);
  assert.match(source, /"--type",\s*"open"/);
  assert.match(source, /"context:primary-signature"/);
  assert.doesNotMatch(source, /pkgbuild|productbuild|BundleIsRelocatable/);
  assert.doesNotMatch(backgroundSource, /NSAttributedString|drawText/);
  assert.match(backgroundSource, /logicalWidth: CGFloat = 2560/);
  assert.match(backgroundSource, /logicalHeight: CGFloat = 1600/);
});
