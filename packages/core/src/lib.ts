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
const ARCHIVE_COMMAND_TIMEOUT_MS = 500;
const CONFIG_DIRECTORY_NAME = "openspec-diff";
const CONFIG_FILE_NAME = "config.json";
const LOCAL_PLACEHOLDER = "$LOCAL";
const REMOTE_PLACEHOLDER = "$REMOTE";

export interface ArchiveCommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function diff(uri1: string, uri2: string): number {
  return diffWithOpenspecCommand(uri1, uri2, "openspec");
}

export function diffWithOpenspecCommand(
  uri1: string,
  uri2: string,
  openspecCommand: string,
  diffToolCommand = "",
): number {
  const prepared = prepareDiffInputs(uri1, uri2, openspecCommand);
  const resolvedDiffToolCommand = resolveConfiguredDiffToolCommand(
    diffToolCommand,
  );
  const diffCommand = resolveDiffCommand(
    resolvedDiffToolCommand,
    diffToolPathFor(prepared.left),
    diffToolPathFor(prepared.right),
  );

  try {
    const result = spawnSync(diffCommand.name, diffCommand.args, {
      stdio: "inherit",
    });

    if (result.error) {
      throw new Error(
        `failed to run ${diffCommand.name}: ${result.error.message}`,
      );
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

export interface DiffCommand {
  name: string;
  args: string[];
}

export function defaultConfigPath(homeDirectory = os.homedir()): string {
  return path.join(
    homeDirectory,
    ".config",
    CONFIG_DIRECTORY_NAME,
    CONFIG_FILE_NAME,
  );
}

export function loadConfiguredDiffToolCommand(configPath: string): string {
  if (!fs.existsSync(configPath)) {
    return "";
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `failed to parse config ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  if (
    parsedConfig === null ||
    typeof parsedConfig !== "object" ||
    Array.isArray(parsedConfig)
  ) {
    throw new Error(`failed to parse config ${configPath}: expected an object`);
  }

  const diffToolCommand = (parsedConfig as { difftool?: unknown }).difftool;
  if (diffToolCommand === undefined) {
    return "";
  }

  if (typeof diffToolCommand !== "string") {
    throw new Error(
      `failed to parse config ${configPath}: "difftool" must be a string`,
    );
  }

  return diffToolCommand;
}

export function resolveConfiguredDiffToolCommand(
  diffToolCommand: string,
  configPath = defaultConfigPath(),
): string {
  if (diffToolCommand.trim() !== "") {
    return diffToolCommand;
  }

  return loadConfiguredDiffToolCommand(configPath);
}

export function resolveDiffCommand(
  diffToolCommand: string,
  leftPath: string,
  rightPath: string,
): DiffCommand {
  const trimmedCommand = diffToolCommand.trim();
  if (trimmedCommand === "") {
    return {
      name: "diff",
      args: [leftPath, rightPath],
    };
  }

  const tokens = splitCommand(trimmedCommand);
  if (tokens.length === 0) {
    throw new Error("difftool command cannot be empty");
  }

  const usesLocalPlaceholder = tokens.some((token) =>
    token.includes(LOCAL_PLACEHOLDER),
  );
  const usesRemotePlaceholder = tokens.some((token) =>
    token.includes(REMOTE_PLACEHOLDER),
  );
  const resolvedTokens = tokens.map((token) =>
    token
      .replaceAll(LOCAL_PLACEHOLDER, leftPath)
      .replaceAll(REMOTE_PLACEHOLDER, rightPath),
  );
  const [name, ...args] = resolvedTokens;

  if (!usesLocalPlaceholder) {
    args.push(leftPath);
  }
  if (!usesRemotePlaceholder) {
    args.push(rightPath);
  }

  return { name, args };
}

export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    throw new Error("difftool command has an unterminated quote");
  }
  if (escaping) {
    throw new Error("difftool command ends with an incomplete escape");
  }
  if (current !== "") {
    tokens.push(current);
  }

  return tokens;
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

function diffToolPathFor(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  if (
    relativePath !== "" &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".."
  ) {
    return relativePath;
  }

  return filePath;
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
      timeout: ARCHIVE_COMMAND_TIMEOUT_MS,
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
  }

  return {
    status: completed.status,
    stdout: (completed.stdout ?? "").trim(),
    stderr: (completed.stderr ?? "").trim(),
    timedOut: isProcessTimeout(completed.error),
  };
}

function validateArchiveOutput(
  changeSpecPath: string,
  output: ArchiveCommandOutput,
): void {
  if (output.status !== 0 && !output.timedOut) {
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

function isProcessTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
  );
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
