import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDiffDocumentUri,
  getChangeSpecContext,
  loadDiffSnapshot,
  looksLikeDeltaSpec,
} from "../src/change-spec-diff.ts";

test("getChangeSpecContext resolves change and main spec paths", () => {
  const specPath = path.join(
    "/repo",
    "openspec",
    "changes",
    "single-sign-on",
    "specs",
    "auth",
    "spec.md",
  );

  assert.deepEqual(getChangeSpecContext(specPath), {
    repoRoot: "/repo",
    changeName: "single-sign-on",
    relativeSpecPath: path.join("auth", "spec.md"),
    changeSpecPath: specPath,
    mainSpecPath: path.join("/repo", "openspec", "specs", "auth", "spec.md"),
  });
});

test("looksLikeDeltaSpec detects OpenSpec delta markers", () => {
  assert.equal(looksLikeDeltaSpec("## MODIFIED Requirements\n"), true);
  assert.equal(looksLikeDeltaSpec("# Plain spec\n"), false);
});

test("createDiffDocumentUri encodes the source document and side", () => {
  const source = "file:///repo/openspec/changes/test/specs/auth/spec.md";
  const uri = createDiffDocumentUri(source, "change");
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, "openspec-diff:");
  assert.equal(parsed.searchParams.get("source"), source);
  assert.equal(parsed.searchParams.get("side"), "change");
});

test("loadDiffSnapshot uses unsaved change content for non-delta specs", async () => {
  const repoRoot = await createTempRepo();
  const mainSpecPath = path.join(
    repoRoot,
    "openspec",
    "specs",
    "auth",
    "spec.md",
  );
  const changeSpecPath = path.join(
    repoRoot,
    "openspec",
    "changes",
    "single-sign-on",
    "specs",
    "auth",
    "spec.md",
  );
  await writeFile(mainSpecPath, "# Main spec\n", "utf8");
  await writeFile(changeSpecPath, "# On-disk change spec\n", "utf8");

  const snapshot = await loadDiffSnapshot(changeSpecPath, {
    changeSpecContent: "# Unsaved change spec\n",
  });

  assert.equal(snapshot.mainContent, "# Main spec\n");
  assert.equal(snapshot.changeContent, "# Unsaved change spec\n");
});

test("loadDiffSnapshot archives delta specs in a temporary workspace", async () => {
  const repoRoot = await createTempRepo();
  const mainSpecPath = path.join(
    repoRoot,
    "openspec",
    "specs",
    "auth",
    "spec.md",
  );
  const changeSpecPath = path.join(
    repoRoot,
    "openspec",
    "changes",
    "single-sign-on",
    "specs",
    "auth",
    "spec.md",
  );
  const mainContent = "# Main spec\n";
  const unsavedChange = "## MODIFIED Requirements\n### Requirement: Login\n";
  await writeFile(mainSpecPath, mainContent, "utf8");
  await writeFile(changeSpecPath, unsavedChange, "utf8");

  const snapshot = await loadDiffSnapshot(changeSpecPath, {
    changeSpecContent: unsavedChange,
    archiveRunner: async ({ tempRoot, changeName, synthesizedSpecPath }) => {
      assert.equal(changeName, "single-sign-on");
      const tempChangeSpecPath = path.join(
        tempRoot,
        "openspec",
        "changes",
        "single-sign-on",
        "specs",
        "auth",
        "spec.md",
      );
      assert.equal(await readFile(tempChangeSpecPath, "utf8"), unsavedChange);
      assert.equal(
        await readFile(
          path.join(tempRoot, "openspec", "specs", "auth", "spec.md"),
          "utf8",
        ),
        mainContent,
      );
      assert.equal(
        await readFile(
          path.join(
            tempRoot,
            "openspec",
            "changes",
            "single-sign-on",
            "proposal.md",
          ),
          "utf8",
        ),
        "# Temporary diff change\n",
      );
      await mkdir(path.dirname(synthesizedSpecPath), { recursive: true });
      await writeFile(synthesizedSpecPath, "# Synthesized spec\n", "utf8");
      return { stdout: "Archived", stderr: "" };
    },
  });

  assert.equal(snapshot.mainContent, mainContent);
  assert.equal(snapshot.changeContent, "# Synthesized spec\n");
});

test("loadDiffSnapshot reports archive output files that were not produced", async () => {
  const repoRoot = await createTempRepo();
  const changeSpecPath = path.join(
    repoRoot,
    "openspec",
    "changes",
    "single-sign-on",
    "specs",
    "auth",
    "spec.md",
  );
  await writeFile(
    changeSpecPath,
    "## MODIFIED Requirements\n### Requirement: Login\n",
    "utf8",
  );

  await assert.rejects(
    loadDiffSnapshot(changeSpecPath, {
      archiveRunner: async () => ({ stdout: "Archived", stderr: "" }),
    }),
    /archive did not produce/,
  );
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(
    path.join(os.tmpdir(), "openspec-diff-vscode-test-"),
  );
  await mkdir(path.join(repoRoot, "openspec", "specs", "auth"), {
    recursive: true,
  });
  await mkdir(
    path.join(
      repoRoot,
      "openspec",
      "changes",
      "single-sign-on",
      "specs",
      "auth",
    ),
    { recursive: true },
  );
  return repoRoot;
}
