import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OPENSPEC_DIRECTORY = "openspec";
const CHANGES_DIRECTORY = "changes";
const SPECS_DIRECTORY = "specs";
const SPEC_FILE_NAME = "spec.md";
const TEMP_PROPOSAL_CONTENT = "# Temporary diff change\n";
const TEMP_TASKS_CONTENT =
  "## Tasks\n- [x] Prepare a synthesized spec for diffing\n";
const ABORTED_ARCHIVE_MARKER = "Aborted. No files were changed.";

export const DIFF_SCHEME = "openspec-diff";
export const DELTA_MARKERS = [
  "## ADDED Requirements",
  "## MODIFIED Requirements",
  "## REMOVED Requirements",
  "## RENAMED Requirements",
] as const;

export interface ChangeSpecContext {
  repoRoot: string;
  changeName: string;
  relativeSpecPath: string;
  changeSpecPath: string;
  mainSpecPath: string;
}

export interface DiffSnapshot {
  title: string;
  mainContent: string;
  changeContent: string;
  context: ChangeSpecContext;
}

export interface ArchiveRunnerInput {
  tempRoot: string;
  changeName: string;
  changeSpecPath: string;
  synthesizedSpecPath: string;
}

export interface ArchiveRunnerResult {
  stdout: string;
  stderr: string;
}

export type ArchiveRunner = (
  input: ArchiveRunnerInput,
) => Promise<ArchiveRunnerResult>;

export interface LoadDiffSnapshotOptions {
  changeSpecContent?: string;
  archiveRunner?: ArchiveRunner;
}

export function getChangeSpecContext(
  specPath: string,
): ChangeSpecContext | undefined {
  const absolutePath = path.resolve(specPath);
  if (path.basename(absolutePath) !== SPEC_FILE_NAME) {
    return undefined;
  }

  let current = path.dirname(absolutePath);
  while (true) {
    if (path.basename(current) === SPECS_DIRECTORY) {
      const changeRoot = path.dirname(current);
      const changesRoot = path.dirname(changeRoot);
      const openspecRoot = path.dirname(changesRoot);
      const repoRoot = path.dirname(openspecRoot);

      if (
        path.basename(changesRoot) === CHANGES_DIRECTORY &&
        path.basename(openspecRoot) === OPENSPEC_DIRECTORY
      ) {
        const relativeSpecPath = path.relative(current, absolutePath);
        return {
          repoRoot,
          changeName: path.basename(changeRoot),
          relativeSpecPath,
          changeSpecPath: absolutePath,
          mainSpecPath: path.join(
            repoRoot,
            OPENSPEC_DIRECTORY,
            SPECS_DIRECTORY,
            relativeSpecPath,
          ),
        };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function isChangeSpecPath(specPath: string): boolean {
  return getChangeSpecContext(specPath) !== undefined;
}

export function looksLikeDeltaSpec(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return DELTA_MARKERS.some((marker) =>
    lines.some((line) => line.trim() === marker),
  );
}

export function createDiffDocumentUri(
  sourceUri: string,
  side: "main" | "change",
): string {
  const params = new URLSearchParams({ source: sourceUri, side });
  return `${DIFF_SCHEME}:/${side}/spec.md?${params.toString()}`;
}

export async function loadDiffSnapshot(
  changeSpecPath: string,
  options: LoadDiffSnapshotOptions = {},
): Promise<DiffSnapshot> {
  const context = getChangeSpecContext(changeSpecPath);
  if (!context) {
    throw new Error("Diff is only available for OpenSpec change spec files.");
  }

  const mainContent = await readTextIfExists(context.mainSpecPath);
  const changeSpecContent =
    options.changeSpecContent ??
    (await readFile(context.changeSpecPath, "utf8"));

  if (!looksLikeDeltaSpec(changeSpecContent)) {
    return {
      title: diffTitle(context),
      mainContent,
      changeContent: changeSpecContent,
      context,
    };
  }

  const changeContent = await archiveChangeSpec(
    context,
    changeSpecContent,
    mainContent,
    options.archiveRunner ?? runOpenSpecArchive,
  );

  return {
    title: diffTitle(context),
    mainContent,
    changeContent,
    context,
  };
}

async function archiveChangeSpec(
  context: ChangeSpecContext,
  changeSpecContent: string,
  mainContent: string,
  archiveRunner: ArchiveRunner,
): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openspec-diff-"));
  const synthesizedSpecPath = path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    SPECS_DIRECTORY,
    context.relativeSpecPath,
  );

  try {
    await writeWorkspaceFiles(
      tempRoot,
      context,
      changeSpecContent,
      mainContent,
    );
    const result = await archiveRunner({
      tempRoot,
      changeName: context.changeName,
      changeSpecPath: context.changeSpecPath,
      synthesizedSpecPath,
    });
    validateArchiveResult(context.changeSpecPath, result);
    try {
      return await readFile(synthesizedSpecPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(
          `failed to preprocess delta spec ${context.changeSpecPath}: archive did not produce ${synthesizedSpecPath}`,
        );
      }
      throw error;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeWorkspaceFiles(
  tempRoot: string,
  context: ChangeSpecContext,
  changeSpecContent: string,
  mainContent: string,
): Promise<void> {
  const tempChangeSpecPath = path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
    context.changeName,
    SPECS_DIRECTORY,
    context.relativeSpecPath,
  );
  await mkdir(path.dirname(tempChangeSpecPath), { recursive: true });
  await writeFile(tempChangeSpecPath, changeSpecContent, "utf8");

  if (mainContent.length > 0) {
    const tempMainSpecPath = path.join(
      tempRoot,
      OPENSPEC_DIRECTORY,
      SPECS_DIRECTORY,
      context.relativeSpecPath,
    );
    await mkdir(path.dirname(tempMainSpecPath), { recursive: true });
    await writeFile(tempMainSpecPath, mainContent, "utf8");
  }

  const tempChangeRoot = path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
    context.changeName,
  );
  await mkdir(tempChangeRoot, { recursive: true });
  await writeFile(
    path.join(tempChangeRoot, "proposal.md"),
    TEMP_PROPOSAL_CONTENT,
    "utf8",
  );
  await writeFile(
    path.join(tempChangeRoot, "tasks.md"),
    TEMP_TASKS_CONTENT,
    "utf8",
  );
}

function validateArchiveResult(
  changeSpecPath: string,
  result: ArchiveRunnerResult,
): void {
  const detail = result.stderr || result.stdout;
  if (detail.includes(ABORTED_ARCHIVE_MARKER)) {
    throw new Error(
      `failed to preprocess delta spec ${changeSpecPath}: openspec archive aborted: no files were changed`,
    );
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return "";
    }
    throw error;
  }
}

async function runOpenSpecArchive(
  input: ArchiveRunnerInput,
): Promise<ArchiveRunnerResult> {
  return await new Promise<ArchiveRunnerResult>((resolve, reject) => {
    execFile(
      "openspec",
      ["archive", input.changeName, "--yes"],
      { cwd: input.tempRoot },
      (error, stdout, stderr) => {
        const result = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        };

        if (!error) {
          resolve(result);
          return;
        }

        const message =
          result.stderr ||
          result.stdout ||
          (isMissingFileError(error)
            ? "openspec command not found"
            : String(error.message || error));
        reject(
          new Error(
            `failed to preprocess delta spec ${input.changeSpecPath}: ${message}`,
          ),
        );
      },
    );
  });
}

function diffTitle(context: ChangeSpecContext): string {
  return `OpenSpec Diff: ${context.changeName} — ${context.relativeSpecPath}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
