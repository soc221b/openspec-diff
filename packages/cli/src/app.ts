import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { checkbox, select } from "@inquirer/prompts";

export const OPENSPEC_DIRECTORY = "openspec";
export const CHANGES_DIRECTORY = "changes";
export const SPECS_DIRECTORY = "specs";
export const SPEC_FILE_NAME = "spec.md";

const ERR_NO_CHANGES = "no active changes found";
const ERR_NO_SELECTION = "no change selected";
const ERR_NO_SPEC_SELECTION = "no spec selected";
const CHANGE_PROMPT_MESSAGE = "Select a change to diff";
const SPEC_PROMPT_MESSAGE = "Select specs to diff";

export type CommandRunner = (
  dir: string,
  name: string,
  ...args: string[]
) => Promise<void>;

interface SpecPair {
  name: string;
  selector: string;
  changePath: string;
  mainPath: string;
}

export async function run(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  workDir: string,
  changeName: string,
  specName: string,
  diffToolCommand: string,
  coreDiffExecutable: string,
  runCommand: CommandRunner,
): Promise<void> {
  const repoRoot = findRepoRoot(workDir);
  let changes: string[];
  try {
    changes = listChanges(repoRoot);
  } catch (error) {
    if (isMessage(error, ERR_NO_CHANGES)) {
      stdout.write("No active changes found.\n");
      stdout.write("No change selected. Aborting.\n");
      return;
    }
    throw error;
  }

  let selectedChange: string;
  try {
    selectedChange = await selectRequestedChange(
      stdin,
      stdout,
      changes,
      changeName,
    );
    await flushOutput(stdout);
  } catch (error) {
    if (isMessage(error, ERR_NO_SELECTION)) {
      stdout.write("No change selected. Aborting.\n");
      return;
    }
    throw error;
  }

  const specPairs = collectSpecPairs(repoRoot, selectedChange);
  if (specPairs.length === 0) {
    stdout.write(
      `No spec files found for change ${JSON.stringify(selectedChange)}.\n`,
    );
    return;
  }

  let selectedSpecPairs: SpecPair[];
  try {
    selectedSpecPairs = await selectRequestedSpec(
      stdin,
      stdout,
      specPairs,
      specName,
    );
    await flushOutput(stdout);
  } catch (error) {
    if (isMessage(error, ERR_NO_SPEC_SELECTION)) {
      return;
    }
    throw error;
  }

  if (selectedSpecPairs.length === 0) {
    return;
  }

  for (const pair of selectedSpecPairs) {
    const commandArgs =
      diffToolCommand.trim() === ""
        ? [path.relative(repoRoot, pair.mainPath), path.relative(repoRoot, pair.changePath)]
        : [
            "--difftool",
            diffToolCommand,
            path.relative(repoRoot, pair.mainPath),
            path.relative(repoRoot, pair.changePath),
          ];
    await runCommand(
      repoRoot,
      coreDiffExecutable,
      ...commandArgs,
    );
  }
}

function findRepoRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const changesPath = path.join(
      currentDir,
      OPENSPEC_DIRECTORY,
      CHANGES_DIRECTORY,
    );
    const specsPath = path.join(
      currentDir,
      OPENSPEC_DIRECTORY,
      SPECS_DIRECTORY,
    );
    if (isDirectory(changesPath) && isDirectory(specsPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        "could not find openspec/changes and openspec/specs directories in the current path or any parent directory",
      );
    }
    currentDir = parentDir;
  }
}

function listChanges(repoRoot: string): string[] {
  const changesPath = path.join(
    repoRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
  );
  const entries = fs.readdirSync(changesPath, { withFileTypes: true });
  const changes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "archive" && !name.startsWith("."))
    .sort((left, right) => left.localeCompare(right));

  if (changes.length === 0) {
    throw new Error(ERR_NO_CHANGES);
  }

  return changes;
}

async function selectRequestedChange(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  changes: string[],
  changeName: string,
): Promise<string> {
  if (changeName.trim() !== "") {
    return resolveExactChange(changes, changeName);
  }

  const selectedChange = await withRawMode(stdin, async () =>
    selectChange(stdin, stdout, changes),
  );
  stdout.write("\n");
  return selectedChange;
}

async function selectChange(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  changes: string[],
): Promise<string> {
  const promptInput = createPromptInputStream(stdin);
  const promptAbort = new AbortController();
  const handleSigint = () => {
    promptAbort.abort();
  };
  const handleData = (chunk: Buffer | string) => {
    promptInput.write(chunk);
  };
  const handleEnd = () => {
    promptInput.end();
  };
  const handleError = (error: Error) => {
    promptInput.destroy(error);
  };

  process.on("SIGINT", handleSigint);
  stdin.on("data", handleData);
  stdin.once("end", handleEnd);
  stdin.once("error", handleError);

  if (typeof (stdin as { resume?: () => void }).resume === "function") {
    (stdin as { resume: () => void }).resume();
  }

  try {
    return await select(
      {
        message: CHANGE_PROMPT_MESSAGE,
        choices: changes.map((change) => ({
          name: change,
          short: change,
          value: change,
        })),
      },
      {
        input: promptInput,
        output: stdout,
        signal: promptAbort.signal,
      },
    );
  } catch (error) {
    if (isInquirerAbort(error)) {
      throw new Error(ERR_NO_SELECTION);
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSigint);
    stdin.removeListener("data", handleData);
    stdin.removeListener("end", handleEnd);
    stdin.removeListener("error", handleError);
    pauseStream(stdin);
    promptInput.end();
  }
}

function resolveExactChange(changes: string[], rawSelection: string): string {
  const selection = rawSelection.trim();
  for (const change of changes) {
    if (change === selection) {
      return change;
    }
  }

  throw new Error(`Change '${selection}' not found.`);
}

async function selectRequestedSpec(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  specPairs: SpecPair[],
  specName: string,
): Promise<SpecPair[]> {
  const selections = parseSpecSelections(specName);
  if (selections.length > 0) {
    return filterSpecPairs(specPairs, selections);
  }
  if (specPairs.length <= 1) {
    return specPairs;
  }

  const specs = specPairs.map((pair) => pair.selector);
  const selectedSpecs = await withRawMode(stdin, async () =>
    selectSpecs(stdin, stdout, specs),
  );
  if (selectedSpecs.length > 0) {
    stdout.write("\n");
  }
  return filterSpecPairs(specPairs, selectedSpecs);
}

async function selectSpecs(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  specs: string[],
): Promise<string[]> {
  const promptInput = createPromptInputStream(stdin);
  const promptAbort = new AbortController();
  const handleSigint = () => {
    promptAbort.abort();
  };
  const handleData = (chunk: Buffer | string) => {
    promptInput.write(chunk);
  };
  const handleEnd = () => {
    promptInput.end();
  };
  const handleError = (error: Error) => {
    promptInput.destroy(error);
  };
  process.on("SIGINT", handleSigint);

  stdin.on("data", handleData);
  stdin.once("end", handleEnd);
  stdin.once("error", handleError);

  if (typeof (stdin as { resume?: () => void }).resume === "function") {
    (stdin as { resume: () => void }).resume();
  }

  try {
    return await checkbox(
      {
        message: SPEC_PROMPT_MESSAGE,
        choices: specs.map((spec) => ({
          name: spec,
          short: spec,
          value: spec,
        })),
      },
      {
        input: promptInput,
        output: stdout,
        signal: promptAbort.signal,
      },
    );
  } catch (error) {
    if (isInquirerAbort(error)) {
      return [];
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSigint);
    stdin.removeListener("data", handleData);
    stdin.removeListener("end", handleEnd);
    stdin.removeListener("error", handleError);
    pauseStream(stdin);
    promptInput.end();
  }
}

function createPromptInputStream(stdin: NodeJS.ReadableStream): PassThrough {
  const rawInput = new PassThrough();
  (
    rawInput as PassThrough & {
      isTTY?: boolean;
    }
  ).isTTY = Boolean(
    (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY,
  );
  return new Proxy(rawInput, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      if (property === "readableFlowing") {
        return false;
      }
      return property in target;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as PassThrough;
}

function isInquirerAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortPromptError" || error.name === "ExitPromptError")
  );
}

function filterSpecPairs(
  specPairs: SpecPair[],
  selections: string[],
): SpecPair[] {
  const selectedSpecs = validateSpecSelections(
    specSelectors(specPairs),
    selections,
  );
  if (selectedSpecs.length === specPairs.length) {
    return specPairs;
  }

  const selectedSet = new Set(selectedSpecs);
  return specPairs.filter((pair) => selectedSet.has(pair.selector));
}

function collectSpecPairs(repoRoot: string, change: string): SpecPair[] {
  const changeSpecsPath = path.join(
    repoRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
    change,
    SPECS_DIRECTORY,
  );
  if (!isDirectory(changeSpecsPath)) {
    return [];
  }

  const pairs: SpecPair[] = [];
  walkDirectory(changeSpecsPath, (filePath) => {
    if (path.basename(filePath) !== SPEC_FILE_NAME) {
      return;
    }

    const relativePath = path.relative(changeSpecsPath, filePath);
    pairs.push({
      name: relativePath.split(path.sep).join("/"),
      selector: specSelectorName(relativePath),
      changePath: filePath,
      mainPath: path.join(
        repoRoot,
        OPENSPEC_DIRECTORY,
        SPECS_DIRECTORY,
        relativePath,
      ),
    });
  });

  pairs.sort((left, right) => left.name.localeCompare(right.name));
  return pairs;
}

function walkDirectory(
  directoryPath: string,
  visit: (filePath: string) => void,
): void {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(entryPath, visit);
      continue;
    }
    visit(entryPath);
  }
}

function isDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function specSelectorName(relativePath: string): string {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const selector = normalizedPath.endsWith(`/${SPEC_FILE_NAME}`)
    ? normalizedPath.slice(0, -`/${SPEC_FILE_NAME}`.length)
    : normalizedPath;
  if (selector === normalizedPath && normalizedPath === SPEC_FILE_NAME) {
    return "spec";
  }
  return selector;
}

function parseSpecSelections(rawSelection: string): string[] {
  const selection = rawSelection.trim();
  if (selection === "") {
    return [];
  }

  const selections: string[] = [];
  const seen = new Set<string>();
  for (const part of selection.split(",")) {
    const spec = part.trim();
    if (spec === "") {
      continue;
    }
    if (spec === "all") {
      return ["all"];
    }
    if (seen.has(spec)) {
      continue;
    }
    seen.add(spec);
    selections.push(spec);
  }

  return selections;
}

function validateSpecSelections(
  specs: string[],
  selections: string[],
): string[] {
  if (selections.length === 0) {
    throw new Error(ERR_NO_SPEC_SELECTION);
  }
  if (selections.length === 1 && selections[0] === "all") {
    return specs;
  }

  const available = new Set(specs);
  for (const selection of selections) {
    if (!available.has(selection)) {
      throw new Error(`Spec '${selection}' not found.`);
    }
  }

  return selections;
}

function specSelectors(specPairs: SpecPair[]): string[] {
  return specPairs.map((pair) => pair.selector);
}

function pauseStream(stream: NodeJS.ReadableStream): void {
  if (typeof (stream as { pause?: () => void }).pause === "function") {
    (stream as { pause: () => void }).pause();
  }
}

function flushOutput(stdout: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write("", (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withRawMode<T>(
  stdin: NodeJS.ReadableStream,
  action: () => Promise<T>,
): Promise<T> {
  const rawModeStream = stdin as NodeJS.ReadStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };

  if (!rawModeStream.isTTY || typeof rawModeStream.setRawMode !== "function") {
    return await action();
  }

  rawModeStream.setRawMode(true);
  try {
    return await action();
  } finally {
    rawModeStream.setRawMode(false);
  }
}

function isMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}
