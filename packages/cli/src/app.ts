import fs from "node:fs";
import path from "node:path";

export const OPENSPEC_DIRECTORY = "openspec";
export const CHANGES_DIRECTORY = "changes";
export const SPECS_DIRECTORY = "specs";
export const SPEC_FILE_NAME = "spec.md";
const PROMPT_OVERHEAD = 3;

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

export type PromptInput =
  | { kind: "typed"; text: string }
  | { kind: "submit" }
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "toggle" }
  | { kind: "eof" };

export class StreamByteReader {
  private readonly buffers: Buffer[] = [];
  private ended = false;
  private error: Error | undefined;
  private readonly waiters: Array<{
    resolve: (value: number | null) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk) => {
      this.buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.flushWaiters();
    });
    stream.on("end", () => {
      this.ended = true;
      this.flushWaiters();
    });
    stream.on("error", (error) => {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.flushWaiters();
    });

    if (typeof (stream as { resume?: () => void }).resume === "function") {
      (stream as { resume: () => void }).resume();
    }
  }

  async readByte(): Promise<number | null> {
    if (this.error) {
      throw this.error;
    }

    const chunk = this.buffers[0];
    if (chunk && chunk.length > 0) {
      const value = chunk[0];
      if (chunk.length === 1) {
        this.buffers.shift();
      } else {
        this.buffers[0] = chunk.subarray(1);
      }
      return value;
    }

    if (this.ended) {
      return null;
    }

    return await new Promise<number | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0) {
      if (this.error) {
        this.waiters.shift()?.reject(this.error);
        continue;
      }

      const chunk = this.buffers[0];
      if (chunk && chunk.length > 0) {
        const waiter = this.waiters.shift();
        const value = chunk[0];
        if (chunk.length === 1) {
          this.buffers.shift();
        } else {
          this.buffers[0] = chunk.subarray(1);
        }
        waiter?.resolve(value);
        continue;
      }

      if (this.ended) {
        this.waiters.shift()?.resolve(null);
        continue;
      }

      break;
    }
  }
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

  return await withRawMode(stdin, async () =>
    selectChange(stdin, stdout, changes),
  );
}

async function selectChange(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  changes: string[],
): Promise<string> {
  const reader = new StreamByteReader(stdin);
  let selectedIndex = 0;
  let typedSelection = "";
  const rendered = { value: false };

  renderSingleSelectionPrompt(
    stdout,
    "Select a change to diff",
    changes,
    selectedIndex,
    "↑↓ navigate • ⏎ select",
    rendered,
  );

  while (true) {
    const input = await readPromptInput(reader);

    switch (input.kind) {
      case "eof":
        return resolveSelection(
          stdout,
          changes,
          selectedIndex,
          typedSelection,
          true,
        );
      case "submit":
        return resolveSelection(
          stdout,
          changes,
          selectedIndex,
          typedSelection,
          false,
        );
      case "toggle":
        typedSelection += " ";
        break;
      case "moveUp":
        if (selectedIndex > 0) {
          selectedIndex -= 1;
        }
        renderSingleSelectionPrompt(
          stdout,
          "Select a change to diff",
          changes,
          selectedIndex,
          "↑↓ navigate • ⏎ select",
          rendered,
        );
        break;
      case "moveDown":
        if (selectedIndex < changes.length - 1) {
          selectedIndex += 1;
        }
        renderSingleSelectionPrompt(
          stdout,
          "Select a change to diff",
          changes,
          selectedIndex,
          "↑↓ navigate • ⏎ select",
          rendered,
        );
        break;
      case "typed":
        typedSelection += input.text;
        break;
    }
  }
}

function resolveSelection(
  stdout: NodeJS.WritableStream,
  changes: string[],
  selectedIndex: number,
  rawSelection: string,
  eof: boolean,
): string {
  const selection = rawSelection.trim();
  if (selection === "") {
    if (eof) {
      throw new Error(ERR_NO_SELECTION);
    }

    const selected = changes[selectedIndex];
    stdout.write(`✔ Select a change to diff ${selected}\n\n`);
    return selected;
  }

  const change = resolveExactChange(changes, selection);
  stdout.write(`✔ Select a change to diff ${change}\n\n`);
  return change;
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
  return filterSpecPairs(specPairs, selectedSpecs);
}

async function selectSpecs(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  specs: string[],
): Promise<string[]> {
  const reader = new StreamByteReader(stdin);
  let selectedIndex = 0;
  let typedSelection = "";
  const selected = specs.map(() => false);
  const rendered = { value: false };

  renderMultiSelectionPrompt(
    stdout,
    "Select specs to diff",
    specs,
    selected,
    selectedIndex,
    "↑↓ navigate • space toggle • ⏎ submit",
    rendered,
  );

  while (true) {
    const input = await readPromptInput(reader);

    switch (input.kind) {
      case "eof":
        return resolveSpecSelections(
          stdout,
          specs,
          selected,
          typedSelection,
          true,
        );
      case "submit":
        return resolveSpecSelections(
          stdout,
          specs,
          selected,
          typedSelection,
          false,
        );
      case "toggle":
        selected[selectedIndex] = !selected[selectedIndex];
        renderMultiSelectionPrompt(
          stdout,
          "Select specs to diff",
          specs,
          selected,
          selectedIndex,
          "↑↓ navigate • space toggle • ⏎ submit",
          rendered,
        );
        break;
      case "moveUp":
        if (selectedIndex > 0) {
          selectedIndex -= 1;
        }
        renderMultiSelectionPrompt(
          stdout,
          "Select specs to diff",
          specs,
          selected,
          selectedIndex,
          "↑↓ navigate • space toggle • ⏎ submit",
          rendered,
        );
        break;
      case "moveDown":
        if (selectedIndex < specs.length - 1) {
          selectedIndex += 1;
        }
        renderMultiSelectionPrompt(
          stdout,
          "Select specs to diff",
          specs,
          selected,
          selectedIndex,
          "↑↓ navigate • space toggle • ⏎ submit",
          rendered,
        );
        break;
      case "typed":
        typedSelection += input.text;
        break;
    }
  }
}

export async function readPromptInput(
  reader: Pick<StreamByteReader, "readByte">,
): Promise<PromptInput> {
  const input = await reader.readByte();
  if (input === null) {
    return { kind: "eof" };
  }

  switch (input) {
    case 13:
    case 10:
      return { kind: "submit" };
    case 32:
      return { kind: "toggle" };
    case 0x1b:
      return await readPromptEscapeSequence(reader, input);
    default:
      return { kind: "typed", text: String.fromCharCode(input) };
  }
}

async function readPromptEscapeSequence(
  reader: Pick<StreamByteReader, "readByte">,
  start: number,
): Promise<PromptInput> {
  const next = await reader.readByte();
  if (next === null) {
    return { kind: "eof" };
  }
  if (next !== 0x5b) {
    return { kind: "typed", text: String.fromCharCode(start, next) };
  }

  const direction = await reader.readByte();
  if (direction === null) {
    return { kind: "eof" };
  }

  switch (direction) {
    case 0x41:
      return { kind: "moveUp" };
    case 0x42:
      return { kind: "moveDown" };
    default:
      return {
        kind: "typed",
        text: String.fromCharCode(start, next, direction),
      };
  }
}

function renderSingleSelectionPrompt(
  stdout: NodeJS.WritableStream,
  question: string,
  options: string[],
  selectedIndex: number,
  hint: string,
  rendered: { value: boolean },
): void {
  beginPromptRender(stdout, options.length, rendered);
  stdout.write(`? ${question}\n`);
  for (const [index, option] of options.entries()) {
    const prefix = index === selectedIndex ? "❯" : " ";
    stdout.write(`${prefix} ${option}\n`);
  }
  endPromptRender(stdout, hint, rendered);
}

function renderMultiSelectionPrompt(
  stdout: NodeJS.WritableStream,
  question: string,
  options: string[],
  selected: boolean[],
  selectedIndex: number,
  hint: string,
  rendered: { value: boolean },
): void {
  beginPromptRender(stdout, options.length, rendered);
  stdout.write(`? ${question}\n`);
  for (const [index, option] of options.entries()) {
    const prefix = index === selectedIndex ? "❯" : " ";
    const marker = selected[index] ? "◉" : "◯";
    stdout.write(`${prefix} ${marker} ${option}\n`);
  }
  endPromptRender(stdout, hint, rendered);
}

function beginPromptRender(
  stdout: NodeJS.WritableStream,
  optionCount: number,
  rendered: { value: boolean },
): void {
  if (rendered.value) {
    stdout.write(`\x1b[${optionCount + PROMPT_OVERHEAD}A\x1b[J`);
  }
}

function endPromptRender(
  stdout: NodeJS.WritableStream,
  hint: string,
  rendered: { value: boolean },
): void {
  stdout.write("\n");
  stdout.write(`${hint}\n`);
  rendered.value = true;
}

function resolveSpecSelections(
  stdout: NodeJS.WritableStream,
  specs: string[],
  selected: boolean[],
  rawSelection: string,
  _eof: boolean,
): string[] {
  const selection = parseSpecSelections(rawSelection);
  if (selection.length === 0) {
    const selectedSpecs = selectedSpecNames(specs, selected);
    if (selectedSpecs.length === 0) {
      return [];
    }
    stdout.write(`✔ Select specs to diff ${selectedSpecs.join(", ")}\n\n`);
    return selectedSpecs;
  }

  const selectedSpecs = validateSpecSelections(specs, selection);
  stdout.write(`✔ Select specs to diff ${selectedSpecs.join(", ")}\n\n`);
  return selectedSpecs;
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

function selectedSpecNames(specs: string[], selected: boolean[]): string[] {
  return specs.filter((_, index) => selected[index]);
}

function specSelectors(specPairs: SpecPair[]): string[] {
  return specPairs.map((pair) => pair.selector);
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
