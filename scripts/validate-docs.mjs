#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = collectMarkdown(root).filter(
  (filePath) => !filePath.includes(`${path.sep}dist${path.sep}`)
);
const errors = [];

for (const filePath of markdownFiles) {
  const content = fs.readFileSync(filePath, "utf8");
  const fences = content.match(/^```/gm)?.length ?? 0;
  if (fences % 2 !== 0) {
    errors.push(`${relative(filePath)} has an unclosed code fence`);
  }

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (
      !target ||
      /^(?:https?:|mailto:)/.test(target) ||
      target.startsWith("/")
    ) {
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!fs.existsSync(resolved)) {
      errors.push(`${relative(filePath)} links to missing ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Documentation validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Documentation validation passed: ${markdownFiles.length} files`);

function collectMarkdown(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(absolute));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function relative(filePath) {
  return path.relative(root, filePath);
}
