import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveOutputAbortedWithoutWriting,
  archiveOutputDetails,
  normalizeDiffExitCode,
} from "../src/lib.ts";

test("archiveOutputDetails prefers stderr details", () => {
  assert.equal(
    archiveOutputDetails(
      { stdout: "stdout detail", stderr: "stderr detail" },
      "fallback",
    ),
    "stderr detail",
  );
});

test("archiveOutputAbortedWithoutWriting detects aborted archive marker", () => {
  assert.equal(
    archiveOutputAbortedWithoutWriting({
      stdout: "Aborted. No files were changed.",
      stderr: "",
    }),
    true,
  );
});

test("normalizeDiffExitCode treats git diff exit code 1 as success", () => {
  assert.equal(normalizeDiffExitCode(1), 0);
  assert.equal(normalizeDiffExitCode(0), 0);
  assert.equal(normalizeDiffExitCode(null), 2);
});
