#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUTPUT_IDLE_TIMEOUT_MS = 200;
const OUTPUT_POLL_INTERVAL_MS = 10;
const MAX_OUTPUT_SETTLE_MS = 1000;
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const SIGNAL_EXIT_CODE_OFFSET = 128;
const TESTS_DIRECTORY_NAME = 'tests';
const FIXTURE_CONCURRENCY_ENV = 'OPENSPEC_DIFF_TEST_CONCURRENCY';
const DEFAULT_FIXTURE_CONCURRENCY =
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
type FixtureFailure = { fixtureDir: string; message: string };
type FixtureInstruction = { lineNumber: number; value: string };
type CommandRunnerInput = { stdin: string; path: string };
type CommandResult = { path: string };
type FixtureAssertionInput = { expectedPath: string; actualPath: string };
type FixtureAssertionResult = { exitCode: number };
type DetailedCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
};
type PackageContext = {
  interactive: boolean;
  commandName: string;
  resolveCommandPath: (context: { workspaceRoot: string; packageDir: string }) => string;
};
type FixtureContext = PackageContext & { workspaceRoot: string; packageDir: string };
type CommandPlan = {
  fixtureDir: string;
  stdinPath: string;
  command: string[];
  instructions: FixtureInstruction[];
  interactive: boolean;
};
type OutputPaths = {
  actualDir: string;
  workspaceDir: string;
  stdoutPath: string;
  stderrPath: string;
  exitCodePath: string;
  commandPath: string;
  environment: NodeJS.ProcessEnv;
};

const PACKAGE_CONTEXTS: Record<string, PackageContext> = {
  cli: {
    interactive: true,
    commandName: 'openspec-diff',
    resolveCommandPath: ({ packageDir }) => path.join(packageDir, 'bin', 'openspec-diff'),
  },
  core: {
    interactive: false,
    commandName: 'openspec-difftool',
    resolveCommandPath: ({ workspaceRoot }) =>
      path.join(workspaceRoot, 'dist', 'target', 'core', 'debug', 'openspec-difftool'),
  },
};

async function main(argv = process.argv) {
  const testsPath = getTestsPath(argv);
  const fixtureFailures = await runFixtureSuite({
    workspaceRoot: getWorkspaceRoot(import.meta.url),
    testsPath,
    onFixtureComplete: (failure) => {
      process.stdout.write(failure ? 'F' : '.');
    },
  });

  process.stdout.write('\n');

  if (fixtureFailures.length > 0) {
    process.stdout.write(`${formatFailureList(fixtureFailures)}\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

async function runFixtureSuite({
  workspaceRoot,
  testsPath,
  onFixtureComplete = () => {},
}: {
  workspaceRoot: string;
  testsPath: string;
  onFixtureComplete?: (failure: FixtureFailure | null) => void;
}): Promise<FixtureFailure[]> {
  ensurePathExists(testsPath);

  const context = createContext(workspaceRoot, testsPath);
  return runFixturesInParallel({
    fixtureDirs: getFixtureDirectories(testsPath),
    onFixtureComplete,
    execute: (fixtureDir) => executeFixture(context, fixtureDir),
  });
}

async function executeFixture(context: FixtureContext, fixtureDir: string): Promise<FixtureFailure | null> {
  try {
    const result = await runFixtureCommandInWorkspace({
      stdin: fs.readFileSync(path.join(fixtureDir, 'stdin.txt'), 'utf8'),
      fixtureDir,
      workspaceRoot: context.workspaceRoot,
    });

    try {
      const assertion = assertFixtureResult({
        expectedPath: fixtureDir,
        actualPath: result.path,
      });

      if (assertion.exitCode !== 0) {
        throw new Error(`Fixture assertion failed for ${fixtureDir}`);
      }
    } finally {
      fs.rmSync(result.path, { recursive: true, force: true });
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fixtureDir, message };
  }
}

async function runFixturesInParallel({
  fixtureDirs,
  onFixtureComplete,
  execute,
}: {
  fixtureDirs: string[];
  onFixtureComplete: (failure: FixtureFailure | null) => void;
  execute: (fixtureDir: string) => Promise<FixtureFailure | null>;
}): Promise<FixtureFailure[]> {
  if (fixtureDirs.length === 0) {
    return [];
  }

  const failures: Array<FixtureFailure | null | undefined> = Array.from({ length: fixtureDirs.length });
  const progressState = { nextIndexToReport: 0 };
  let nextIndexToExecute = 0;

  const runWorker = async () => {
    while (nextIndexToExecute < fixtureDirs.length) {
      const fixtureIndex = nextIndexToExecute;
      nextIndexToExecute += 1;
      failures[fixtureIndex] = await execute(fixtureDirs[fixtureIndex]);
      flushCompletedFixtures(failures, progressState, onFixtureComplete);
    }
  };

  const concurrency = getFixtureConcurrency(fixtureDirs.length);
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return failures.filter((failure): failure is FixtureFailure => failure !== null && failure !== undefined);
}

function flushCompletedFixtures(
  failures: Array<FixtureFailure | null | undefined>,
  progressState: { nextIndexToReport: number },
  onFixtureComplete: (failure: FixtureFailure | null) => void
) {
  while (progressState.nextIndexToReport < failures.length) {
    const failure = failures[progressState.nextIndexToReport];

    if (failure === undefined) {
      return;
    }

    onFixtureComplete(failure);
    progressState.nextIndexToReport += 1;
  }
}

function getFixtureConcurrency(fixtureCount: number) {
  const rawValue = process.env[FIXTURE_CONCURRENCY_ENV];
  const requestedConcurrency =
    rawValue === undefined ? DEFAULT_FIXTURE_CONCURRENCY : parseFixtureConcurrency(rawValue);

  return Math.max(1, Math.min(fixtureCount, requestedConcurrency));
}

function parseFixtureConcurrency(value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Invalid ${FIXTURE_CONCURRENCY_ENV}: expected a positive integer, received ${value}`);
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${FIXTURE_CONCURRENCY_ENV}: expected a positive integer, received ${value}`);
  }

  return parsed;
}

export async function runFixtureCommand({
  stdin,
  path: fixtureDir,
}: CommandRunnerInput): Promise<CommandResult> {
  return runFixtureCommandInWorkspace({
    stdin,
    fixtureDir,
    workspaceRoot: getWorkspaceRoot(import.meta.url),
  });
}

async function runFixtureCommandInWorkspace({
  stdin,
  fixtureDir,
  workspaceRoot,
}: {
  stdin: string;
  fixtureDir: string;
  workspaceRoot: string;
}): Promise<CommandResult> {
  const context = createContext(workspaceRoot, fixtureDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-diff-test-'));
  let keepTempDir = false;

  try {
    ensureFixtureInputs(fixtureDir);

    const outputPaths = prepareFixtureWorkspace(context, fixtureDir, tempDir);
    const commandPlan = parseFixturePlan(
      fixtureDir,
      stdin,
      outputPaths.commandPath,
      context.commandName,
      context.interactive
    );
    const result = await runPlannedFixtureCommand(
      commandPlan,
      outputPaths.workspaceDir,
      outputPaths.environment
    );
    writeCommandOutputs(outputPaths, result);
    keepTempDir = true;

    return {
      path: outputPaths.actualDir,
    };
  } finally {
    if (!keepTempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function runPlannedFixtureCommand(
  commandPlan: CommandPlan,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv
): Promise<DetailedCommandResult> {
  if (!commandPlan.interactive) {
    return Promise.resolve(runCommand(commandPlan.command, workingDirectory, environment));
  }

  return runInteractiveFixtureCommand(commandPlan, workingDirectory, environment);
}

export function assertFixtureResult({
  expectedPath,
  actualPath,
}: FixtureAssertionInput): FixtureAssertionResult {
  for (const fileName of ['stdout.txt', 'stderr.txt', 'exit-code.txt'] as const) {
    const expectedFilePath = path.join(expectedPath, fileName);
    const actualFilePath = path.join(actualPath, fileName);
    const expectedExists = fs.existsSync(expectedFilePath);
    const actualExists = fs.existsSync(actualFilePath);

    if (!expectedExists && !actualExists) {
      continue;
    }

    if (expectedExists !== actualExists) {
      process.stderr.write(
        `Fixture file presence mismatch for ${fileName}: expected ${expectedExists ? 'present' : 'missing'}, actual ${
          actualExists ? 'present' : 'missing'
        }\n`
      );
      return { exitCode: 2 };
    }

    const completed = spawnSync('diff', ['-u', expectedFilePath, actualFilePath], {
      encoding: 'utf8',
      stdio: 'inherit',
    });

    if (completed.status === null) {
      throw new Error(
        `diff command did not exit normally: ${formatCompletedCommand(
          'diff',
          ['-u', expectedFilePath, actualFilePath],
          completed
        )}`
      );
    }

    if (completed.status !== 0) {
      return { exitCode: completed.status };
    }
  }

  return { exitCode: 0 };
}

function runCommand(
  commands: string[],
  workingDirectory: string,
  environment: NodeJS.ProcessEnv
): DetailedCommandResult {
  const completed = spawnSync(commands[0], commands.slice(1), {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: environment,
  });

  return {
    stdout: completed.stdout ?? '',
    stderr: completed.stderr ?? '',
    exitCode: completed.status,
    signalCode: completed.signal,
    aborted: false,
    timedOut: false,
  };
}

async function runInteractiveFixtureCommand(
  commandPlan: CommandPlan,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv
): Promise<DetailedCommandResult> {
  const detailedResult = await runInteractiveCommand(commandPlan, workingDirectory, environment);
  assertProcessDidExit(commandPlan, detailedResult);
  return detailedResult;
}

async function runInteractiveCommand(
  commandPlan: CommandPlan,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv
): Promise<DetailedCommandResult> {
  const child = spawnInteractiveProcess(commandPlan, workingDirectory, environment);
  const closePromise = waitForChildClose(child);
  const output = collectChildOutput(child);
  const aborted = await applyInteractiveInstructions(child, commandPlan, output);
  const timedOut = await finishInteractiveProcess(child, aborted);
  const closeDetails = await closePromise;

  return {
    stdout: renderTerminalOutput(output.stdout),
    stderr: renderTerminalOutput(output.stderr),
    exitCode: closeDetails.code,
    signalCode: closeDetails.signal,
    aborted,
    timedOut,
  };
}

function assertProcessDidExit(commandPlan: CommandPlan, result: DetailedCommandResult) {
  if (result.timedOut) {
    const lastInstruction = commandPlan.instructions.at(-1);
    const lineNumber = lastInstruction?.lineNumber ?? 1;

    throw new Error(
      `${commandPlan.stdinPath}:${lineNumber}: process did not exit after scripted input; add ^C or explicit submit input such as \\n`
    );
  }
}

function createContext(workspaceRoot: string, testsPath: string): FixtureContext {
  const testsDir = path.basename(testsPath) === TESTS_DIRECTORY_NAME ? testsPath : path.dirname(testsPath);
  const packageDir = path.dirname(testsDir);
  const packageContext = PACKAGE_CONTEXTS[path.basename(packageDir)];

  if (packageContext) {
    return {
      ...packageContext,
      workspaceRoot,
      packageDir,
    };
  }

  throw new Error(`Unsupported tests directory: ${testsPath}`);
}

function prepareFixtureWorkspace(context: FixtureContext, fixtureDir: string, tempDir: string): OutputPaths {
  const actualDir = tempDir;
  const workspaceDir = path.join(tempDir, 'workspace');
  const homeDir = path.join(tempDir, 'home');
  const tempOpenSpecDir = path.join(workspaceDir, 'openspec');
  const stdoutPath = path.join(actualDir, 'stdout.txt');
  const stderrPath = path.join(actualDir, 'stderr.txt');
  const exitCodePath = path.join(actualDir, 'exit-code.txt');

  fs.cpSync(path.join(fixtureDir, 'openspec'), tempOpenSpecDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  installFixtureConfig(fixtureDir, homeDir);
  initializeGitWorkspace(workspaceDir);

  return {
    actualDir,
    workspaceDir,
    stdoutPath,
    stderrPath,
    exitCodePath,
    commandPath: getCommandPath(context),
    environment: createFixtureEnvironment(homeDir),
  };
}

function spawnInteractiveProcess(
  commandPlan: CommandPlan,
  workspaceDir: string,
  environment: NodeJS.ProcessEnv
) {
  return spawn(commandPlan.command[0], commandPlan.command.slice(1), {
    cwd: workspaceDir,
    detached: true,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseFixturePlan(
  fixtureDir: string,
  stdin: string,
  commandPath: string,
  commandName: string,
  interactive: boolean
): CommandPlan {
  const stdinPath = path.join(fixtureDir, 'stdin.txt');
  const instructions: FixtureInstruction[] = [];
  let command: string[] | null = null;

  for (const entry of getInstructionLines(stdin, stdinPath)) {
    if (command === null) {
      const invocation = parseInvocation(entry.value, stdinPath, entry.lineNumber);

      if (path.basename(invocation[0] ?? '') !== commandName) {
        throw new Error(`${stdinPath}:${entry.lineNumber}: expected invocation starting with ${commandName}`);
      }

      command = [commandPath, ...invocation.slice(1)];
      continue;
    }

    instructions.push(entry);
  }

  if (command === null) {
    throw new Error(`${stdinPath}: missing ${commandName} invocation`);
  }

  if (!interactive && instructions.length > 0) {
    const firstInstruction = instructions[0];
    throw new Error(`${stdinPath}:${firstInstruction.lineNumber}: unexpected scripted input for ${commandName}`);
  }

  return {
    fixtureDir,
    stdinPath,
    command,
    instructions,
    interactive,
  };
}

function writeCommandOutputs(
  outputPaths: Pick<OutputPaths, 'stdoutPath' | 'stderrPath' | 'exitCodePath'>,
  result: DetailedCommandResult
) {
  const exitCode = getActualExitCode(result);

  fs.writeFileSync(outputPaths.stdoutPath, result.stdout, 'utf8');

  if (exitCode !== 0) {
    fs.writeFileSync(outputPaths.stderrPath, result.stderr, 'utf8');
    fs.writeFileSync(outputPaths.exitCodePath, `${exitCode}`, 'utf8');
  }
}

function getWorkspaceRoot(moduleUrl: string) {
  return path.dirname(fileURLToPath(moduleUrl));
}

function getTestsPath(argv: string[]) {
  const targetPath = argv[2];

  if (!targetPath) {
    throw new Error('Usage: node run-test.ts path/to/tests/folder');
  }

  return path.resolve(targetPath);
}

function getFixtureDirectories(testsPath: string) {
  if (isFixtureDirectory(testsPath)) {
    return [testsPath];
  }

  return fs
    .readdirSync(testsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(testsPath, entry.name))
    .filter(isFixtureDirectory)
    .sort((left, right) => left.localeCompare(right));
}

function isFixtureDirectory(candidatePath: string) {
  return fs.existsSync(path.join(candidatePath, 'openspec')) && fs.existsSync(path.join(candidatePath, 'stdin.txt'));
}

function ensurePathExists(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
}

function ensureFixtureInputs(fixtureDir: string) {
  const stdinPath = path.join(fixtureDir, 'stdin.txt');

  if (!fs.existsSync(stdinPath)) {
    throw new Error(`Missing required stdin fixture: ${stdinPath}`);
  }
}

function installFixtureConfig(fixtureDir: string, homeDir: string) {
  const configPath = path.join(fixtureDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return;
  }

  const targetPath = path.join(homeDir, '.config', 'openspec-diff', 'config.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(configPath, targetPath);
}

function createFixtureEnvironment(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
}

function initializeGitWorkspace(workspaceDir: string) {
  runCheckedCommand('git', ['-C', workspaceDir, 'init', '-q']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'diff.tool', 'terminaldiff']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'difftool.prompt', 'false']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'difftool.terminaldiff.cmd', 'diff "$LOCAL" "$REMOTE"']);
}

function getCommandPath(context: FixtureContext) {
  return context.resolveCommandPath(context);
}

function getInstructionLines(stdin: string, stdinPath: string): FixtureInstruction[] {
  const lines = stdin.split(/\r?\n/);
  const instructions: FixtureInstruction[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const value = stripInlineComment(rawLine);

    if (value) {
      instructions.push({ lineNumber: index + 1, value });
    }
  }

  return instructions;
}

function parseInvocation(value: string, stdinPath: string, lineNumber: number) {
  const tokens: string[] = [];
  let current = '';
  const scanner = createShellScanner();

  for (const char of value) {
    const scanned = scanShellCharacter(scanner, char);

    if (scanned.char === null) {
      continue;
    }

    if (!scanned.protected && /\s/.test(scanned.char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += scanned.char;
  }

  if (hasOpenShellToken(scanner)) {
    throw new Error(`${stdinPath}:${lineNumber}: invalid CLI invocation in stdin.txt`);
  }

  if (current) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error(`${stdinPath}:${lineNumber}: invalid CLI invocation in stdin.txt`);
  }

  return tokens;
}

function stripInlineComment(value: string) {
  const scanner = createShellScanner();

  for (let index = 0; index < value.length; index += 1) {
    const scanned = scanShellCharacter(scanner, value[index]);

    if (!scanned.protected && scanned.char === '#') {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trim();
}

function createShellScanner(): { escaped: boolean; quote: '"' | "'" | null } {
  return { escaped: false, quote: null };
}

function scanShellCharacter(scanner: { escaped: boolean; quote: '"' | "'" | null }, char: string) {
  if (scanner.escaped) {
    scanner.escaped = false;
    return { char, protected: true };
  }

  if (char === '\\' && scanner.quote !== "'") {
    scanner.escaped = true;
    return { char: null, protected: scanner.quote !== null };
  }

  if (scanner.quote) {
    if (char === scanner.quote) {
      scanner.quote = null;
      return { char: null, protected: true };
    }

    return { char, protected: true };
  }

  if (char === '"' || char === "'") {
    scanner.quote = char;
    return { char: null, protected: false };
  }

  return { char, protected: false };
}

function hasOpenShellToken(scanner: { escaped: boolean; quote: '"' | "'" | null }) {
  return scanner.escaped || scanner.quote !== null;
}

function decodeInstruction(value: string, stdinPath: string, lineNumber: number) {
  try {
    return value.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([\\'"abfnrtv]))/g,
      (match, unicodeHex, asciiHex, octalDigits, escapedChar) =>
        decodeEscape(match, unicodeHex, asciiHex, octalDigits, escapedChar)
    );
  } catch (error) {
    throw new Error(`${stdinPath}:${lineNumber}: invalid escape sequence in stdin instruction: ${error.message}`);
  }
}

function decodeEscape(
  match: string,
  unicodeHex?: string,
  asciiHex?: string,
  octalDigits?: string,
  escapedChar?: string
) {
  if (unicodeHex) {
    return String.fromCharCode(Number.parseInt(unicodeHex, 16));
  }

  if (asciiHex) {
    return String.fromCharCode(Number.parseInt(asciiHex, 16));
  }

  if (octalDigits) {
    return String.fromCharCode(Number.parseInt(octalDigits, 8));
  }

  return getSimpleEscapeMap()[escapedChar] ?? match;
}

function getSimpleEscapeMap(): Record<string, string> {
  return {
    '\\': '\\',
    '"': '"',
    "'": "'",
    a: '\u0007',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\u000b',
  };
}

function collectChildOutput(child: ReturnType<typeof spawn>) {
  const output = { stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });

  return output;
}

function renderTerminalOutput(raw: string) {
  if (!raw.includes('\u001b[') && !raw.includes('\r')) {
    return raw;
  }

  const lines = [''];
  const cursor = { row: 0, column: 0 };
  let index = 0;

  while (index < raw.length) {
    const controlSequence = matchControlSequence(raw, index);

    if (controlSequence) {
      applyControlSequence(lines, cursor, controlSequence);
      index = controlSequence.nextIndex;
      continue;
    }

    const char = raw[index];

    if (char === '\n') {
      cursor.row += 1;
      cursor.column = 0;
      ensureScreenLine(lines, cursor.row);
      index += 1;
      continue;
    }

    if (char === '\r') {
      cursor.column = 0;
      index += 1;
      continue;
    }

    writeScreenCharacter(lines, cursor, char);
    index += 1;
  }

  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }

  return lines.map((line) => line.replace(/[ \t]+$/g, '')).join('\n');
}

function matchControlSequence(raw: string, index: number) {
  const match = raw.slice(index).match(/^\u001b\[([0-9;?]*)([A-Za-z])/);

  if (!match) {
    return null;
  }

  return {
    command: match[2],
    params: match[1],
    nextIndex: index + match[0].length,
  };
}

function applyControlSequence(
  lines: string[],
  cursor: { row: number; column: number },
  controlSequence: { command: string; params: string; nextIndex: number }
) {
  const params = parseControlSequenceParams(controlSequence.params);

  switch (controlSequence.command) {
    case 'A':
      cursor.row = Math.max(0, cursor.row - getControlSequenceCount(params));
      break;
    case 'B':
      cursor.row += getControlSequenceCount(params);
      ensureScreenLine(lines, cursor.row);
      break;
    case 'C':
      cursor.column += getControlSequenceCount(params);
      break;
    case 'D':
      cursor.column = Math.max(0, cursor.column - getControlSequenceCount(params));
      break;
    case 'H':
    case 'f':
      cursor.row = Math.max(0, (params[0] ?? 1) - 1);
      cursor.column = Math.max(0, (params[1] ?? 1) - 1);
      ensureScreenLine(lines, cursor.row);
      break;
    case 'J':
      eraseDisplay(lines, cursor, params[0] ?? 0);
      break;
    case 'K':
      eraseLine(lines, cursor, params[0] ?? 0);
      break;
    case 'm':
      break;
    default:
      break;
  }
}

function parseControlSequenceParams(params: string) {
  if (params === '') {
    return [];
  }

  return params.split(';').map((value) => {
    const parsed = Number.parseInt(value.replace(/\?/g, ''), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

function getControlSequenceCount(params: number[]) {
  const value = params[0] ?? 0;
  return value === 0 ? 1 : value;
}

function eraseDisplay(lines: string[], cursor: { row: number; column: number }, mode: number) {
  ensureScreenLine(lines, cursor.row);

  if (mode === 1) {
    for (let index = 0; index < cursor.row; index += 1) {
      lines[index] = '';
    }

    lines[cursor.row] = `${' '.repeat(cursor.column)}${lines[cursor.row].slice(cursor.column)}`;
    return;
  }

  if (mode === 2) {
    lines.splice(0, lines.length, '');
    cursor.row = 0;
    cursor.column = 0;
    return;
  }

  lines[cursor.row] = lines[cursor.row].slice(0, cursor.column);
  lines.splice(cursor.row + 1);
}

function eraseLine(lines: string[], cursor: { row: number; column: number }, mode: number) {
  ensureScreenLine(lines, cursor.row);

  if (mode === 1) {
    lines[cursor.row] = `${' '.repeat(cursor.column)}${lines[cursor.row].slice(cursor.column)}`;
    return;
  }

  if (mode === 2) {
    lines[cursor.row] = '';
    cursor.column = 0;
    return;
  }

  lines[cursor.row] = lines[cursor.row].slice(0, cursor.column);
}

function writeScreenCharacter(lines: string[], cursor: { row: number; column: number }, char: string) {
  ensureScreenLine(lines, cursor.row);
  const line = lines[cursor.row];
  const padding = line.length < cursor.column ? ' '.repeat(cursor.column - line.length) : '';
  const paddedLine = `${line}${padding}`;

  if (cursor.column < paddedLine.length) {
    lines[cursor.row] = `${paddedLine.slice(0, cursor.column)}${char}${paddedLine.slice(cursor.column + 1)}`;
  } else {
    lines[cursor.row] = `${paddedLine}${char}`;
  }

  cursor.column += 1;
}

function ensureScreenLine(lines: string[], row: number) {
  while (lines.length <= row) {
    lines.push('');
  }
}

async function applyInteractiveInstructions(
  child: ReturnType<typeof spawn>,
  commandPlan: CommandPlan,
  output: { stdout: string; stderr: string }
) {
  for (const instruction of commandPlan.instructions) {
    if (instruction.value === '^C') {
      await waitForOutputToSettle(child, () => output.stdout.length);
      interruptProcessGroup(child.pid);
      return true;
    }

    child.stdin.write(decodeInstruction(instruction.value, commandPlan.stdinPath, instruction.lineNumber));
    await waitForOutputToSettle(child, () => output.stdout.length);

    if (child.exitCode !== null) {
      break;
    }
  }

  return false;
}

async function finishInteractiveProcess(child: ReturnType<typeof spawn>, aborted: boolean) {
  if (aborted || child.exitCode !== null) {
    return false;
  }

  child.stdin.end();
  if (await waitForProcessExit(child, PROCESS_EXIT_TIMEOUT_MS)) {
    return false;
  }

  interruptProcessGroup(child.pid);
  return true;
}

async function waitForOutputToSettle(child: ReturnType<typeof spawn>, getLength: () => number) {
  let previousLength = getLength();
  let idleDeadline = Date.now() + OUTPUT_IDLE_TIMEOUT_MS;
  const overallDeadline = Date.now() + MAX_OUTPUT_SETTLE_MS;
  let exitDeadline = null;

  while (Date.now() < overallDeadline) {
    const currentLength = getLength();

    if (currentLength !== previousLength) {
      previousLength = currentLength;
      idleDeadline = Date.now() + OUTPUT_IDLE_TIMEOUT_MS;
    }

    if (child.exitCode === null) {
      if (Date.now() >= idleDeadline) {
        return;
      }

      await sleep(OUTPUT_POLL_INTERVAL_MS);
      continue;
    }

    if (exitDeadline === null) {
      exitDeadline = Math.min(Date.now() + OUTPUT_IDLE_TIMEOUT_MS, overallDeadline);
    }

    if (Date.now() >= exitDeadline) {
      return;
    }

    await sleep(OUTPUT_POLL_INTERVAL_MS);
  }
}

function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function waitForChildClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function interruptProcessGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGINT');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function runCheckedCommand(command: string, args: string[]) {
  const completed = spawnSync(command, args, { encoding: 'utf8' });

  if (completed.status === 0) {
    return;
  }

  throw new Error(formatCompletedCommand(command, args, completed));
}

function getActualExitCode(result: Pick<DetailedCommandResult, 'exitCode' | 'signalCode'>) {
  if (typeof result.exitCode === 'number') {
    return result.exitCode;
  }

  if (result.signalCode) {
    return SIGNAL_EXIT_CODE_OFFSET + getSignalNumber(result.signalCode);
  }

  throw new Error('Command exited without an exit code or signal');
}

function getSignalNumber(signalCode: NodeJS.Signals) {
  const signalNumber = os.constants.signals[signalCode];

  if (signalNumber === undefined) {
    throw new Error(`Signal code not found in os.constants.signals: ${signalCode}`);
  }

  return signalNumber;
}

function formatFailureList(failures: FixtureFailure[]) {
  return failures.map((failure, index) => `- x ${index + 1}) ${failure.fixtureDir}`).join('\n');
}

function formatCompletedCommand(command: string, args: string[], completed: ReturnType<typeof spawnSync>) {
  const stderr = completed.stderr ? `\n${completed.stderr}` : '';
  return `Command failed: ${command} ${args.join(' ')}${stderr}`;
}

function handleFatalError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

if (import.meta.main) {
  main().catch(handleFatalError);
}
