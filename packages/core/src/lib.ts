import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CHANGES_DIRECTORY,
  DELTA_MARKERS,
  getChangeSpecContext,
  getSynthesizedSpecPath,
  OPENSPEC_DIRECTORY,
  type ChangeSpecContext,
  SPEC_FILE_NAME,
  SPECS_DIRECTORY,
  TEMP_PROPOSAL_CONTENT,
  TEMP_TASKS_CONTENT,
} from "../ts/change-spec.ts";

const ABORTED_ARCHIVE_MARKER = "Aborted. No files were changed.";

export interface ArchiveCommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function diff(uri1: string, uri2: string): number {
  return diffWithOpenspecCommand(uri1, uri2, "openspec");
}

export function diffWithOpenspecCommand(
  uri1: string,
  uri2: string,
  openspecCommand: string,
): number {
  const prepared = prepareDiffInputs(uri1, uri2, openspecCommand);

  try {
    const result = spawnSync(
      "git",
      ["difftool", "--no-prompt", "--no-index", prepared.left, prepared.right],
      {
        stdio: "inherit",
      },
    );

    if (result.error) {
      throw new Error(`failed to run git difftool: ${result.error.message}`);
    }

    return normalizeDiffExitCode(result.status);
  } finally {
    cleanupTemporaryPaths(prepared.cleanupPaths);
  }
}

export function normalizeDiffExitCode(code: number | null): number {
  if (code === 1) {
    return 0;
  }
  if (code === null) {
    return 2;
  }
  return code;
}

export function archiveOutputAbortedWithoutWriting(
  output: Pick<ArchiveCommandOutput, "stdout" | "stderr">,
): boolean {
  return (
    output.stdout.includes(ABORTED_ARCHIVE_MARKER) ||
    output.stderr.includes(ABORTED_ARCHIVE_MARKER)
  );
}

export function archiveOutputDetails(
  output: Pick<ArchiveCommandOutput, "stdout" | "stderr">,
  fallback: string,
): string {
  if (output.stderr !== "") {
    return output.stderr;
  }
  if (output.stdout !== "") {
    return output.stdout;
  }
  return fallback;
}

interface PreparedDiff {
  left: string;
  right: string;
  cleanupPaths: string[];
}

function prepareDiffInputs(
  uri1: string,
  uri2: string,
  openspecCommand: string,
): PreparedDiff {
  const cleanupPaths: string[] = [];

  return {
    left: prepareDiffInput(uri1, openspecCommand, cleanupPaths),
    right: prepareDiffInput(uri2, openspecCommand, cleanupPaths),
    cleanupPaths,
  };
}

function prepareDiffInput(
  uri: string,
  openspecCommand: string,
  cleanupPaths: string[],
): string {
  const absolutePath = absolutePathFor(uri);
  const context = getChangeSpecContext(absolutePath);

  if (!context) {
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }

    return createEmptyPlaceholder(cleanupPaths);
  }

  if (!looksLikeDeltaSpecPath(context.changeSpecPath)) {
    return context.changeSpecPath;
  }

  return preprocessChangeSpec(context, openspecCommand, cleanupPaths);
}

function absolutePathFor(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.join(process.cwd(), filePath);
}

function looksLikeDeltaSpecPath(filePath: string): boolean {
  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `failed to read change spec ${filePath}: ${toErrorMessage(error)}`,
    );
  }

  return DELTA_MARKERS.some((marker) =>
    content.split(/\r?\n/).some((line) => line.trim() === marker),
  );
}

function preprocessChangeSpec(
  context: ChangeSpecContext,
  openspecCommand: string,
  cleanupPaths: string[],
): string {
  const tempRoot = createTempDirectory("openspec-difftool");
  const synthesizedSpecPath = getSynthesizedSpecPath(tempRoot, context);

  try {
    prepareTempChangeWorkspace(context, tempRoot);
    const archiveOutput = runArchiveCommand(context, openspecCommand, tempRoot);
    validateArchiveOutput(context.changeSpecPath, archiveOutput);
    ensureSynthesizedSpecExists(context.changeSpecPath, synthesizedSpecPath);
    cleanupPaths.push(tempRoot);
    return synthesizedSpecPath;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function prepareTempChangeWorkspace(
  context: ChangeSpecContext,
  tempRoot: string,
): void {
  copyFile(
    context.changeSpecPath,
    path.join(
      tempRoot,
      OPENSPEC_DIRECTORY,
      CHANGES_DIRECTORY,
      context.changeName,
      SPECS_DIRECTORY,
      context.relativeSpecPath,
    ),
  );

  if (fs.existsSync(context.mainSpecPath)) {
    copyFile(
      context.mainSpecPath,
      path.join(
        tempRoot,
        OPENSPEC_DIRECTORY,
        SPECS_DIRECTORY,
        context.relativeSpecPath,
      ),
    );
  }

  writeMinimalChangeFiles(
    path.join(
      tempRoot,
      OPENSPEC_DIRECTORY,
      CHANGES_DIRECTORY,
      context.changeName,
    ),
  );
}

function runArchiveCommand(
  context: ChangeSpecContext,
  openspecCommand: string,
  tempRoot: string,
): ArchiveCommandOutput {
  const completed = spawnSync(
    openspecCommand,
    ["archive", context.changeName, "--yes"],
    {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (completed.error) {
    const error = completed.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new Error(
        `failed to preprocess delta spec ${context.changeSpecPath}: openspec command not found`,
      );
    }

    throw new Error(
      `failed to preprocess delta spec ${context.changeSpecPath}: ${error.message}`,
    );
  }

  return {
    status: completed.status,
    stdout: (completed.stdout ?? "").trim(),
    stderr: (completed.stderr ?? "").trim(),
  };
}

function validateArchiveOutput(
  changeSpecPath: string,
  output: ArchiveCommandOutput,
): void {
  if (output.status !== 0) {
    throw new Error(
      `failed to preprocess delta spec ${changeSpecPath}: ${archiveOutputDetails(output, `openspec archive exited with status ${output.status}`)}`,
    );
  }

  if (archiveOutputAbortedWithoutWriting(output)) {
    throw new Error(
      `failed to preprocess delta spec ${changeSpecPath}: ${archiveOutputDetails(output, "openspec archive aborted: no files were changed")}`,
    );
  }
}

function ensureSynthesizedSpecExists(
  changeSpecPath: string,
  synthesizedSpecPath: string,
): void {
  if (!fs.existsSync(synthesizedSpecPath)) {
    throw new Error(
      `failed to preprocess delta spec ${changeSpecPath}: archive did not produce ${synthesizedSpecPath}`,
    );
  }
}

function copyFile(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });

  try {
    fs.copyFileSync(source, target);
  } catch (error) {
    throw new Error(
      `failed to copy ${source} to ${target}: ${toErrorMessage(error)}`,
    );
  }
}

function writeMinimalChangeFiles(changeRoot: string): void {
  fs.mkdirSync(changeRoot, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(changeRoot, "proposal.md"),
      TEMP_PROPOSAL_CONTENT,
    );
    fs.writeFileSync(path.join(changeRoot, "tasks.md"), TEMP_TASKS_CONTENT);
  } catch (error) {
    throw new Error(
      `failed to write change workspace: ${toErrorMessage(error)}`,
    );
  }
}

function createEmptyPlaceholder(cleanupPaths: string[]): string {
  const tempRoot = createTempDirectory("openspec-diff-empty");
  const placeholderPath = path.join(tempRoot, SPEC_FILE_NAME);

  try {
    fs.writeFileSync(placeholderPath, "");
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(
      `failed to create ${placeholderPath}: ${toErrorMessage(error)}`,
    );
  }

  cleanupPaths.push(tempRoot);
  return placeholderPath;
}

function createTempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanupTemporaryPaths(cleanupPaths: string[]): void {
  for (const cleanupPath of [...cleanupPaths].reverse()) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
