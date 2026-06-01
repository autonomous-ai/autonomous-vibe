import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveWorkspaceRoot } from "./pathUtils.mjs";

test("resolveWorkspaceRoot uses the local filesystem workspace env var", () => {
  assert.equal(
    resolveWorkspaceRoot({
      env: { VIEWER_LOCAL_WORKSPACE_ROOT: "models-workspace" },
      cwd: "/tmp",
    }),
    path.resolve("/tmp/models-workspace")
  );
});
