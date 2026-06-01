#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTestRoots = [
  path.join(packageRoot, "src"),
  path.join(packageRoot, "scripts"),
];

// Test discovery pattern. Accepts:
//   - `.test.js`, `.test.mjs`, `.test.cjs`
//   - `.test.ts`, `.test.tsx` (handled via Node `--experimental-strip-types`)
const TEST_FILE_RE = /\.test\.([cm]?js|tsx?)$/u;

function collectTests(dir, tests = []) {
  if (!fs.existsSync(dir)) {
    return tests;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and tooling caches when sweeping recursively.
      if (entry.name === "node_modules" || entry.name === ".cache") continue;
      collectTests(entryPath, tests);
    } else if (TEST_FILE_RE.test(entry.name)) {
      tests.push(entryPath);
    }
  }
  return tests;
}

function expandRequestedPath(rawArg) {
  const resolved = path.resolve(packageRoot, rawArg);
  if (fs.existsSync(resolved)) {
    return fs.statSync(resolved).isDirectory() ? collectTests(resolved) : [resolved];
  }
  // Substring filter against the default roots, matched on the path RELATIVE
  // to packageRoot — supports `npm test -- chat` without accidentally
  // matching characters that appear in the absolute working directory.
  const all = defaultTestRoots.flatMap((root) => collectTests(root));
  const lowered = String(rawArg).toLowerCase();
  return all.filter((testPath) => {
    const rel = path.relative(packageRoot, testPath).toLowerCase();
    return rel.includes(lowered);
  });
}

const requestedTests = process.argv.slice(2).flatMap((testPath) => expandRequestedPath(testPath));
const tests = (requestedTests.length ? requestedTests : defaultTestRoots.flatMap((root) => collectTests(root)))
  .sort();

if (!tests.length) {
  console.error("No CAD Viewer tests found.");
  process.exit(1);
}

// Node 22+ supports `--experimental-strip-types` for plain `.ts` files
// (no decorators, no `enum`, no `namespace`). Our transport.test.ts
// stays inside that subset.
const nodeFlags = [
  "--test",
  "--experimental-default-type=module",
  "--experimental-strip-types",
  "--no-warnings=ExperimentalWarning",
];

const result = spawnSync(process.execPath, [...nodeFlags, ...tests], {
  cwd: packageRoot,
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
