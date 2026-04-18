import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getChangeSpecContext,
  getSynthesizedSpecPath,
  type ChangeSpecContext,
  writeArchiveWorkspaceFiles,
} from "../../core/ts/change-spec.ts";
const ABORTED_ARCHIVE_MARKER = "Aborted. No files were changed.";

export const DIFF_SCHEME = "openspec-diff";
export { getChangeSpecContext };

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
  mainSpecContent?: string;
  archiveRunner?: ArchiveRunner;
}

export function isChangeSpecPath(specPath: string): boolean {
  return getChangeSpecContext(specPath) !== undefined;
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

  const mainContent =
    options.mainSpecContent ?? (await readTextIfExists(context.mainSpecPath));
  const changeSpecContent =
    options.changeSpecContent ??
    (await readFile(context.changeSpecPath, "utf8"));

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
  const synthesizedSpecPath = getSynthesizedSpecPath(tempRoot, context);

  try {
    await writeArchiveWorkspaceFiles({
      tempRoot,
      context,
      changeSpecContent,
      mainContent,
    });
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
