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

test("the production disk image provides a verified drag-to-Applications install", () => {
  assert.match(source, /fs\.symlinkSync\("\/Applications"/);
  assert.match(source, /"\/usr\/bin\/hdiutil"/);
  assert.match(source, /"create"/);
  assert.match(source, /"-format", "UDZO"/);
  assert.match(source, /"-srcfolder", diskImageRoot/);
  assert.match(source, /"verify", artifact/);
  assert.match(source, /"attach"/);
  assert.match(source, /fs\.readlinkSync\(applicationsLink\) !== "\/Applications"/);
  assert.match(source, /"--type",\s*"open"/);
  assert.match(source, /"context:primary-signature"/);
  assert.doesNotMatch(source, /pkgbuild|productbuild|BundleIsRelocatable/);
});
