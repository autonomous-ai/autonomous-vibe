import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VIEWER_GITHUB_URL,
  normalizeViewerDefaultFile,
  normalizeViewerGithubUrl
} from "./viewerConfig.mjs";

test("normalizeViewerDefaultFile keeps scan-relative file paths", () => {
  assert.equal(normalizeViewerDefaultFile("/STEP/sample_part.step/"), "STEP/sample_part.step");
  assert.equal(normalizeViewerDefaultFile("STEP\\sample_part.step"), "STEP/sample_part.step");
});

test("normalizeViewerGithubUrl defaults to no repository link", () => {
  assert.equal(normalizeViewerGithubUrl(""), DEFAULT_VIEWER_GITHUB_URL);
});

test("normalizeViewerGithubUrl accepts configured GitHub URLs", () => {
  assert.equal(
    normalizeViewerGithubUrl("github.com/example/repo"),
    "https://github.com/example/repo"
  );
  assert.equal(
    normalizeViewerGithubUrl("https://github.com/example/repo/tree/main"),
    "https://github.com/example/repo/tree/main"
  );
});

test("normalizeViewerGithubUrl falls back to a configured default", () => {
  assert.equal(
    normalizeViewerGithubUrl("", "github.com/example/default"),
    "https://github.com/example/default"
  );
});
