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

test("the production package cannot relocate Go Rot onto a loose build", () => {
  assert.match(source, /BundleIsRelocatable<\/key><false\/>/);
  assert.match(source, /"\/usr\/bin\/pkgbuild"/);
  assert.match(source, /"--component-plist", componentPlist/);
  assert.match(source, /"--install-location", "\/Applications"/);
  assert.match(source, /relocatable=\"false\"/);
  assert.doesNotMatch(source, /"--component", application/);
});
