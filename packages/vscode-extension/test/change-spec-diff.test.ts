import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isChangeSpecPath,
  writeBufferWorkspace,
} from "../src/change-spec-diff.ts";
import {
  getChangeSpecContext,
  looksLikeDeltaSpec,
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

test("looksLikeDeltaSpec detects OpenSpec delta markers", () => {
  assert.equal(looksLikeDeltaSpec("## MODIFIED Requirements\n"), true);
  assert.equal(looksLikeDeltaSpec("# Plain spec\n"), false);
});

test("isChangeSpecPath returns true for change spec paths", () => {
  const specPath = path.join(
    "/repo",
    "openspec",
    "changes",
    "test",
    "specs",
    "auth",
    "spec.md",
  );
  assert.equal(isChangeSpecPath(specPath), true);
  assert.equal(isChangeSpecPath("/repo/openspec/specs/auth/spec.md"), false);
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

test("writeBufferWorkspace creates workspace with buffer content and correct paths", async () => {
  const context = {
    repoRoot: "/repo",
    changeName: "single-sign-on",
    relativeSpecPath: path.join("auth", "spec.md"),
    changeSpecPath: "/repo/openspec/changes/single-sign-on/specs/auth/spec.md",
    mainSpecPath: "/repo/openspec/specs/auth/spec.md",
  };

  const result = await writeBufferWorkspace({
    context,
    changeSpecContent: "# Unsaved change\n",
    mainSpecContent: "# Main spec\n",
  });

  try {
    assert.equal(
      await readFile(result.changeSpecPath, "utf8"),
      "# Unsaved change\n",
    );
    assert.equal(
      await readFile(result.mainSpecPath, "utf8"),
      "# Main spec\n",
    );

    const changeContext = getChangeSpecContext(result.changeSpecPath);
    assert.ok(changeContext, "change spec path should be recognized as a change spec");
    assert.equal(changeContext.changeName, "single-sign-on");
    assert.equal(changeContext.relativeSpecPath, path.join("auth", "spec.md"));
  } finally {
    await rm(result.tempRoot, { recursive: true, force: true });
  }
});

test("writeBufferWorkspace creates workspace even when main spec content is empty", async () => {
  const context = {
    repoRoot: "/repo",
    changeName: "new-feature",
    relativeSpecPath: path.join("api", "spec.md"),
    changeSpecPath: "/repo/openspec/changes/new-feature/specs/api/spec.md",
    mainSpecPath: "/repo/openspec/specs/api/spec.md",
  };

  const result = await writeBufferWorkspace({
    context,
    changeSpecContent: "## ADDED Requirements\n### Requirement: New API\n",
    mainSpecContent: "",
  });

  try {
    assert.equal(
      await readFile(result.changeSpecPath, "utf8"),
      "## ADDED Requirements\n### Requirement: New API\n",
    );
  } finally {
    await rm(result.tempRoot, { recursive: true, force: true });
  }
});
