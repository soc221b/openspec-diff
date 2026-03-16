import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveOutputAbortedWithoutWriting,
  archiveOutputDetails,
  defaultConfigPath,
  loadConfiguredDiffToolCommand,
  normalizeDiffExitCode,
  resolveConfiguredDiffToolCommand,
  resolveDiffCommand,
  splitCommand,
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

test("resolveDiffCommand defaults to diff when no custom difftool is set", () => {
  assert.deepEqual(resolveDiffCommand("", "left.md", "right.md"), {
    name: "diff",
    args: ["left.md", "right.md"],
  });
});

test("resolveDiffCommand appends compared file paths by default", () => {
  assert.deepEqual(
    resolveDiffCommand(
      "git --no-pager diff --no-index --no-color",
      "left.md",
      "right.md",
    ),
    {
      name: "git",
      args: [
        "--no-pager",
        "diff",
        "--no-index",
        "--no-color",
        "left.md",
        "right.md",
      ],
    },
  );
});

test("resolveDiffCommand substitutes $LOCAL and $REMOTE placeholders", () => {
  assert.deepEqual(
    resolveDiffCommand('custom-tool "$LOCAL" --to "$REMOTE"', "left.md", "right.md"),
    {
      name: "custom-tool",
      args: ["left.md", "--to", "right.md"],
    },
  );
});

test("splitCommand respects shell-style quotes", () => {
  assert.deepEqual(splitCommand('git diff --flag "two words" \'three words\''), [
    "git",
    "diff",
    "--flag",
    "two words",
    "three words",
  ]);
});

test("defaultConfigPath points to the openspec-diff config file", () => {
  assert.equal(
    defaultConfigPath("/tmp/test-home"),
    path.join("/tmp/test-home", ".config", "openspec-diff", "config.json"),
  );
});

test("loadConfiguredDiffToolCommand returns empty when config is missing", () => {
  assert.equal(loadConfiguredDiffToolCommand("/tmp/missing-config.json"), "");
});

test("resolveConfiguredDiffToolCommand falls back to config when CLI difftool is empty", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openspec-diff-cfg-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        difftool: "git --no-pager diff --no-index --no-color",
      }),
      "utf8",
    );

    assert.equal(
      resolveConfiguredDiffToolCommand("", configPath),
      "git --no-pager diff --no-index --no-color",
    );
    assert.equal(
      resolveConfiguredDiffToolCommand("delta", configPath),
      "delta",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadConfiguredDiffToolCommand rejects non-string difftool values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openspec-diff-cfg-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({ difftool: 42 }), "utf8");

    assert.throws(
      () => loadConfiguredDiffToolCommand(configPath),
      /"difftool" must be a string/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
