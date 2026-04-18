import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";

export const OPENSPEC_DIRECTORY = "openspec";
export const CHANGES_DIRECTORY = "changes";
export const SPECS_DIRECTORY = "specs";
export const SPEC_FILE_NAME = "spec.md";

const ERR_NO_CHANGES = "no active changes found";
const ERR_NO_SELECTION = "no change selected";
const ERR_NO_SPEC_SELECTION = "no spec selected";

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
    stdout.write(`Diffing ${pair.name}\n`);
    await runCommand(
      repoRoot,
      coreDiffExecutable,
      pair.mainPath,
      pair.changePath,
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

  const prompt = inquirer.createPromptModule({
    input: stdin,
    output: stdout,
  });

  const response = await prompt<{ change: string }>([
    {
      type: "list",
      name: "change",
      message: "Select a change to diff",
      choices: changes,
    },
  ]);

  if (response.change === "") {
    throw new Error(ERR_NO_SELECTION);
  }

  return response.change;
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
  const prompt = inquirer.createPromptModule({
    input: stdin,
    output: stdout,
  });
  const response = await prompt<{ specs: string[] }>([
    {
      type: "checkbox",
      name: "specs",
      message: "Select specs to diff",
      choices: specs,
    },
  ]);

  return filterSpecPairs(specPairs, response.specs);
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

function isMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}
