import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { run } from "../src/app.ts";

function createOutputCollector() {
  let output = "";

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    read: () => output,
  };
}

function createRepoRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openspec-cli-test-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, "openspec", "changes"), { recursive: true });
  fs.mkdirSync(path.join(root, "openspec", "specs"), { recursive: true });
  return root;
}

function writeSpec(repoRoot: string, target: "main" | "change", change: string, spec: string): void {
  const basePath =
    target === "main"
      ? path.join(repoRoot, "openspec", "specs")
      : path.join(repoRoot, "openspec", "changes", change, "specs");

  const specPath = path.join(basePath, spec, "spec.md");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, `# ${spec}\n`, "utf8");
}

test("run uses positional change and spec names without interactive prompts", async (t) => {
  const repoRoot = createRepoRoot(t);
  fs.mkdirSync(path.join(repoRoot, "openspec", "changes", "digital-wallet"), {
    recursive: true,
  });

  writeSpec(repoRoot, "main", "digital-wallet", "auth");
  writeSpec(repoRoot, "main", "digital-wallet", "transaction");
  writeSpec(repoRoot, "change", "digital-wallet", "auth");
  writeSpec(repoRoot, "change", "digital-wallet", "transaction");

  const output = createOutputCollector();
  const commands: string[][] = [];

  await run(
    Readable.from([]),
    output.stream,
    repoRoot,
    "digital-wallet",
    "auth",
    "openspec-difftool",
    async (_dir, name, ...args) => {
      commands.push([name, ...args]);
    },
  );

  assert.equal(output.read(), "Diffing auth/spec.md\n");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.[0], "openspec-difftool");
  assert.match(commands[0]?.[1] ?? "", /openspec\/specs\/auth\/spec\.md$/);
  assert.match(
    commands[0]?.[2] ?? "",
    /openspec\/changes\/digital-wallet\/specs\/auth\/spec\.md$/,
  );
});

test("run supports --specs=all behavior via all selection", async (t) => {
  const repoRoot = createRepoRoot(t);
  fs.mkdirSync(path.join(repoRoot, "openspec", "changes", "digital-wallet"), {
    recursive: true,
  });

  writeSpec(repoRoot, "main", "digital-wallet", "auth");
  writeSpec(repoRoot, "main", "digital-wallet", "transaction");
  writeSpec(repoRoot, "change", "digital-wallet", "auth");
  writeSpec(repoRoot, "change", "digital-wallet", "transaction");

  const output = createOutputCollector();
  const commands: string[][] = [];

  await run(
    Readable.from([]),
    output.stream,
    repoRoot,
    "digital-wallet",
    "all",
    "openspec-difftool",
    async (_dir, name, ...args) => {
      commands.push([name, ...args]);
    },
  );

  assert.equal(output.read(), "Diffing auth/spec.md\nDiffing transaction/spec.md\n");
  assert.equal(commands.length, 2);
});

test("run rejects unknown positional change names", async (t) => {
  const repoRoot = createRepoRoot(t);
  fs.mkdirSync(path.join(repoRoot, "openspec", "changes", "digital-wallet"), {
    recursive: true,
  });

  await assert.rejects(
    run(
      Readable.from([]),
      createOutputCollector().stream,
      repoRoot,
      "missing-change",
      "",
      "openspec-difftool",
      async () => {},
    ),
    /Change 'missing-change' not found\./,
  );
});

test("run rejects unknown positional spec names", async (t) => {
  const repoRoot = createRepoRoot(t);
  fs.mkdirSync(path.join(repoRoot, "openspec", "changes", "digital-wallet"), {
    recursive: true,
  });

  writeSpec(repoRoot, "main", "digital-wallet", "auth");
  writeSpec(repoRoot, "change", "digital-wallet", "auth");

  await assert.rejects(
    run(
      Readable.from([]),
      createOutputCollector().stream,
      repoRoot,
      "digital-wallet",
      "transaction",
      "openspec-difftool",
      async () => {},
    ),
    /Spec 'transaction' not found\./,
  );
});

test("run prints no-change empty state when no active changes exist", async (t) => {
  const repoRoot = createRepoRoot(t);
  const output = createOutputCollector();

  await run(
    Readable.from([]),
    output.stream,
    repoRoot,
    "",
    "",
    "openspec-difftool",
    async () => {
      throw new Error("unexpected runCommand");
    },
  );

  assert.equal(
    output.read(),
    "No active changes found.\nNo change selected. Aborting.\n",
  );
});

test("run prints no-spec empty state for selected change", async (t) => {
  const repoRoot = createRepoRoot(t);
  fs.mkdirSync(path.join(repoRoot, "openspec", "changes", "digital-wallet"), {
    recursive: true,
  });

  const output = createOutputCollector();

  await run(
    Readable.from([]),
    output.stream,
    repoRoot,
    "digital-wallet",
    "",
    "openspec-difftool",
    async () => {
      throw new Error("unexpected runCommand");
    },
  );

  assert.equal(
    output.read(),
    'No spec files found for change "digital-wallet".\n',
  );
});
