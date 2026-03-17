import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getChangeSpecContext,
  getSynthesizedSpecPath,
  looksLikeDeltaSpec,
  type ChangeSpecContext,
  writeArchiveWorkspaceFiles,
} from "../../core/ts/change-spec.ts";

export { getChangeSpecContext, looksLikeDeltaSpec };

const PREPARE_TIMEOUT_MS = 10_000;

export interface PreparedDiff {
  left: string;
  right: string;
}

export function isChangeSpecPath(specPath: string): boolean {
  return getChangeSpecContext(specPath) !== undefined;
}

export async function prepareDiff(input: {
  difftoolBin: string;
  openspecBin: string;
  mainSpecPath: string;
  changeSpecPath: string;
}): Promise<PreparedDiff> {
  return await new Promise<PreparedDiff>((resolve, reject) => {
    execFile(
      input.difftoolBin,
      ["--prepare-only", input.mainSpecPath, input.changeSpecPath],
      {
        env: {
          ...process.env,
          OPENSPEC_DIFF_OPENSPEC_BIN: input.openspecBin,
        },
        timeout: PREPARE_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            stderr.trim() ||
            (isMissingFileError(error)
              ? "openspec-difftool binary not found"
              : String(error.message || error));
          reject(new Error(message));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim()) as PreparedDiff;
          resolve(result);
        } catch {
          reject(
            new Error(`failed to parse openspec-difftool output: ${stdout}`),
          );
        }
      },
    );
  });
}

export interface BufferWorkspace {
  tempRoot: string;
  mainSpecPath: string;
  changeSpecPath: string;
}

export async function writeBufferWorkspace(input: {
  context: ChangeSpecContext;
  changeSpecContent: string;
  mainSpecContent: string;
}): Promise<BufferWorkspace> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "openspec-diff-buffer-"),
  );

  await writeArchiveWorkspaceFiles({
    tempRoot,
    context: input.context,
    changeSpecContent: input.changeSpecContent,
    mainContent: input.mainSpecContent,
  });

  const mainSpecPath = getSynthesizedSpecPath(tempRoot, input.context);
  const changeSpecPath = path.join(
    tempRoot,
    "openspec",
    "changes",
    input.context.changeName,
    "specs",
    input.context.relativeSpecPath,
  );

  return { tempRoot, mainSpecPath, changeSpecPath };
}

export async function readSynthesizedContent(
  prepared: PreparedDiff,
): Promise<string> {
  return await readFile(prepared.right, "utf8");
}

export async function writeManagedTempFile(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content, "utf8");
}

export async function cleanupPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    await rm(p, { recursive: true, force: true });
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
