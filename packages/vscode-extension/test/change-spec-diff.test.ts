import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDiffDocumentUri,
  isChangeSpecPath,
  loadDiffSnapshot,
} from "../src/change-spec-diff.ts";
import {
  getChangeSpecContext,
  writeArchiveWorkspaceFiles,
} from "../../core/ts/change-spec.ts";

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

test("writeArchiveWorkspaceFiles creates the temporary archive workspace", async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "openspec-diff-core-ts-"),
  );
  const context = {
    repoRoot: "/repo",
    changeName: "single-sign-on",
    relativeSpecPath: path.join("auth", "spec.md"),
    changeSpecPath: "/repo/openspec/changes/single-sign-on/specs/auth/spec.md",
    mainSpecPath: "/repo/openspec/specs/auth/spec.md",
  };
  try {
    await writeArchiveWorkspaceFiles({
      tempRoot,
      context,
      changeSpecContent: "# Change spec\n",
      mainContent: "# Main spec\n",
    });

    assert.equal(
      await readFile(
        path.join(
          tempRoot,
          "openspec",
          "changes",
          "single-sign-on",
          "specs",
          "auth",
          "spec.md",
        ),
        "utf8",
      ),
      "# Change spec\n",
    );
    assert.equal(
      await readFile(
        path.join(tempRoot, "openspec", "specs", "auth", "spec.md"),
        "utf8",
      ),
      "# Main spec\n",
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
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createDiffDocumentUri encodes the source document and side", () => {
  const source = "file:///repo/openspec/changes/test/specs/auth/spec.md";
  const uri = createDiffDocumentUri(source, "change");
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, "openspec-diff:");
  assert.equal(parsed.searchParams.get("source"), source);
  assert.equal(parsed.searchParams.get("side"), "change");
});

test("loadDiffSnapshot always archives change specs, even without delta markers", async () => {
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
  const unsavedChange = "# Not marked as delta\n";
  await writeFile(mainSpecPath, mainContent, "utf8");
  await writeFile(changeSpecPath, unsavedChange, "utf8");

  let archiveInvoked = false;
  const snapshot = await loadDiffSnapshot(changeSpecPath, {
    changeSpecContent: unsavedChange,
    archiveRunner: async ({ tempRoot, changeName, synthesizedSpecPath }) => {
      archiveInvoked = true;
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
      await mkdir(path.dirname(synthesizedSpecPath), { recursive: true });
      await writeFile(synthesizedSpecPath, "# Synthesized spec\n", "utf8");
      return { stdout: "Archived", stderr: "" };
    },
  });

  assert.equal(archiveInvoked, true);
  assert.equal(snapshot.mainContent, mainContent);
  assert.equal(snapshot.changeContent, "# Synthesized spec\n");
});

test("loadDiffSnapshot uses unsaved main spec content when provided", async () => {
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
  await writeFile(mainSpecPath, "# On-disk main spec\n", "utf8");
  await writeFile(changeSpecPath, "## MODIFIED Requirements\n", "utf8");

  const snapshot = await loadDiffSnapshot(changeSpecPath, {
    mainSpecContent: "# Unsaved main spec\n",
    archiveRunner: async ({ synthesizedSpecPath }) => {
      await mkdir(path.dirname(synthesizedSpecPath), { recursive: true });
      await writeFile(synthesizedSpecPath, "# Synthesized spec\n", "utf8");
      return { stdout: "Archived", stderr: "" };
    },
  });

  assert.equal(snapshot.mainContent, "# Unsaved main spec\n");
  assert.equal(snapshot.changeContent, "# Synthesized spec\n");
});

test("loadDiffSnapshot supports new specs without a main spec", async () => {
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
  const unsavedChange = "## ADDED Requirements\n### Requirement: SSO\n";
  await writeFile(changeSpecPath, unsavedChange, "utf8");

  const snapshot = await loadDiffSnapshot(changeSpecPath, {
    archiveRunner: async ({ tempRoot, synthesizedSpecPath }) => {
      await assert.rejects(
        readFile(
          path.join(tempRoot, "openspec", "specs", "auth", "spec.md"),
          "utf8",
        ),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      await mkdir(path.dirname(synthesizedSpecPath), { recursive: true });
      await writeFile(synthesizedSpecPath, "# New synthesized spec\n", "utf8");
      return { stdout: "Archived", stderr: "" };
    },
  });

  assert.equal(snapshot.mainContent, "");
  assert.equal(snapshot.changeContent, "# New synthesized spec\n");
});

test("loadDiffSnapshot reports archive preprocessing errors for malformed change specs", async () => {
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
  await writeFile(changeSpecPath, "# malformed\n", "utf8");

  await assert.rejects(
    loadDiffSnapshot(changeSpecPath, {
      archiveRunner: async ({ changeSpecPath: failingPath }) => {
        throw new Error(
          `failed to preprocess delta spec ${failingPath}: parse error: expected delta heading`,
        );
      },
    }),
    /failed to preprocess delta spec .*parse error: expected delta heading/,
  );
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

test("isChangeSpecPath only matches files in the change-spec directory", () => {
  const validPath = path.join(
    "/repo",
    "openspec",
    "changes",
    "single-sign-on",
    "specs",
    "auth",
    "spec.md",
  );
  const outsidePath = path.join(
    "/repo",
    "openspec",
    "specs",
    "auth",
    "spec.md",
  );

  assert.equal(isChangeSpecPath(validPath), true);
  assert.equal(isChangeSpecPath(outsidePath), false);
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
