#!/usr/bin/env node
// @ts-check

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const OUTPUT_IDLE_TIMEOUT_MS = 200;
const OUTPUT_POLL_INTERVAL_MS = 10;
const MAX_OUTPUT_SETTLE_MS = 1000;
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const SIGNAL_EXIT_CODE_OFFSET = 128;
const TESTS_DIRECTORY_NAME = 'tests';
const PACKAGE_CONTEXTS = {
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

if (require.main === module) {
  main().catch(handleFatalError);
}

async function main() {
  const testsPath = getTestsPath(process.argv);
  const workspaceRoot = __dirname;
  const context = createContext(workspaceRoot, testsPath);
  const fixtureFailures = /** @type {Array<{ fixtureDir: string; message: string }>} */ ([]);

  ensurePathExists(testsPath);

  for (const fixtureDir of getFixtureDirectories(testsPath)) {
    const failure = await runFixture(context, fixtureDir);
    process.stdout.write(failure ? 'x' : '.');

    if (failure) {
      fixtureFailures.push(failure);
    }
  }

  process.stdout.write('\n');

  if (fixtureFailures.length > 0) {
    throw new Error(formatFailures(fixtureFailures));
  }
}

async function runFixture(context, fixtureDir) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-diff-test-'));

  try {
    ensureFixtureInputs(fixtureDir);
    const outputPaths = prepareFixtureWorkspace(context, fixtureDir, tempDir);
    const commandPlan = parseFixturePlan(
      fixtureDir,
      outputPaths.commandPath,
      context.commandName,
      context.interactive
    );
    const result = context.interactive
      ? await runInteractiveCommand(commandPlan, outputPaths)
      : runNonInteractiveCommand(commandPlan, outputPaths);

    writeCommandOutputs(fixtureDir, outputPaths, result);
    validateCommandResult(result, commandPlan);
    assertFixtureOutputs(fixtureDir, outputPaths);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fixtureDir, message };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runNonInteractiveCommand(commandPlan, outputPaths) {
  const completed = spawnSync(commandPlan.command[0], commandPlan.command.slice(1), {
    cwd: outputPaths.workspaceDir,
    encoding: 'utf8',
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

async function runInteractiveCommand(commandPlan, outputPaths) {
  const child = spawnInteractiveProcess(commandPlan, outputPaths.workspaceDir);
  const closePromise = waitForChildClose(child);
  const output = collectChildOutput(child);
  const aborted = await applyInteractiveInstructions(child, commandPlan, output);
  const timedOut = await finishInteractiveProcess(child, aborted);
  const closeDetails = await closePromise;

  return createInteractiveResult(output, closeDetails, aborted, timedOut);
}

function validateCommandResult(result, commandPlan) {
  if (result.timedOut) {
    const lastInstruction = commandPlan.instructions.at(-1);
    const lineNumber = lastInstruction?.lineNumber ?? 1;

    throw new Error(
      `${commandPlan.stdinPath}:${lineNumber}: process did not exit after scripted input; add ^C or explicit submit input such as \\n`
    );
  }

  const expectedExitCode = readExpectedExitCode(commandPlan.fixtureDir);
  const actualExitCode = getActualExitCode(result);

  if (actualExitCode !== expectedExitCode) {
    throw new Error(
      `${commandPlan.fixtureDir}/exit-code.txt: expected ${expectedExitCode}, received ${actualExitCode}`
    );
  }
}

function assertFixtureOutputs(fixtureDir, outputPaths) {
  runDiff(path.join(fixtureDir, 'stdout.txt'), outputPaths.stdoutPath);

  const expectedStderrPath = path.join(fixtureDir, 'stderr.txt');
  const actualStderr = fs.readFileSync(outputPaths.stderrPath, 'utf8');

  if (fs.existsSync(expectedStderrPath)) {
    runDiff(expectedStderrPath, outputPaths.stderrPath);
    return;
  }

  if (actualStderr.length > 0) {
    throw new Error(`Unexpected stderr output for ${fixtureDir}\n${actualStderr}`);
  }
}

function createContext(workspaceRoot, testsPath) {
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

function prepareFixtureWorkspace(context, fixtureDir, tempDir) {
  const workspaceDir = tempDir;
  const tempOpenSpecDir = path.join(tempDir, 'openspec');
  const stdoutPath = path.join(tempDir, 'stdout.txt');
  const stderrPath = path.join(tempDir, 'stderr.txt');

  fs.cpSync(path.join(fixtureDir, 'openspec'), tempOpenSpecDir, { recursive: true });
  initializeGitWorkspace(workspaceDir);

  return {
    workspaceDir,
    stdoutPath,
    stderrPath,
    commandPath: getCommandPath(context),
  };
}

function spawnInteractiveProcess(commandPlan, workspaceDir) {
  return spawn(commandPlan.command[0], commandPlan.command.slice(1), {
    cwd: workspaceDir,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseFixturePlan(fixtureDir, commandPath, commandName, interactive) {
  const stdinPath = path.join(fixtureDir, 'stdin.txt');
  const instructions = [];
  let command = null;

  for (const entry of getInstructionLines(stdinPath)) {
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
  };
}

function writeCommandOutputs(fixtureDir, outputPaths, result) {
  fs.writeFileSync(outputPaths.stdoutPath, normalizeOutput(result.stdout), 'utf8');
  fs.writeFileSync(outputPaths.stderrPath, normalizeFixturePaths(result.stderr, outputPaths.workspaceDir, fixtureDir), 'utf8');
}

function normalizeFixturePaths(value, workspaceDir, fixtureDir) {
  return value.split(workspaceDir).join(fixtureDir);
}

function getTestsPath(argv) {
  const targetPath = argv[2];

  if (!targetPath) {
    throw new Error('Usage: node run-test.ts path/to/tests/folder');
  }

  return path.resolve(targetPath);
}

function getFixtureDirectories(testsPath) {
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

function isFixtureDirectory(candidatePath) {
  return fs.existsSync(path.join(candidatePath, 'openspec')) && fs.existsSync(path.join(candidatePath, 'stdin.txt'));
}

function ensurePathExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
}

function ensureFixtureInputs(fixtureDir) {
  const stdinPath = path.join(fixtureDir, 'stdin.txt');

  if (!fs.existsSync(stdinPath)) {
    throw new Error(`Missing required stdin fixture: ${stdinPath}`);
  }
}

function initializeGitWorkspace(workspaceDir) {
  runCheckedCommand('git', ['-C', workspaceDir, 'init', '-q']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'diff.tool', 'terminaldiff']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'difftool.prompt', 'false']);
  runCheckedCommand('git', ['-C', workspaceDir, 'config', 'difftool.terminaldiff.cmd', 'diff "$LOCAL" "$REMOTE"']);
}

function getCommandPath(context) {
  return context.resolveCommandPath(context);
}

function getInstructionLines(stdinPath) {
  const lines = fs.readFileSync(stdinPath, 'utf8').split(/\r?\n/);
  const instructions = [];

  for (const [index, rawLine] of lines.entries()) {
    const value = stripInlineComment(rawLine);

    if (value) {
      instructions.push({ lineNumber: index + 1, value });
    }
  }

  return instructions;
}

function parseInvocation(value, stdinPath, lineNumber) {
  const tokens = [];
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

function stripInlineComment(value) {
  const scanner = createShellScanner();

  for (let index = 0; index < value.length; index += 1) {
    const scanned = scanShellCharacter(scanner, value[index]);

    if (!scanned.protected && scanned.char === '#') {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trim();
}

function createShellScanner() {
  return { escaped: false, quote: null };
}

function scanShellCharacter(scanner, char) {
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

function hasOpenShellToken(scanner) {
  return scanner.escaped || scanner.quote !== null;
}

function decodeInstruction(value, stdinPath, lineNumber) {
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

function decodeEscape(match, unicodeHex, asciiHex, octalDigits, escapedChar) {
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

function getSimpleEscapeMap() {
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

function normalizeOutput(value) {
  const lastScreenState = value.includes('\u001b[J') ? value.split('\u001b[J').at(-1) : value;
  return lastScreenState.replace(/\u001b\[\d+A/g, '');
}

function collectChildOutput(child) {
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

async function applyInteractiveInstructions(child, commandPlan, output) {
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

async function finishInteractiveProcess(child, aborted) {
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

function createInteractiveResult(output, closeDetails, aborted, timedOut) {
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: closeDetails.code,
    signalCode: closeDetails.signal,
    aborted,
    timedOut,
  };
}

async function waitForOutputToSettle(child, getLength) {
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

function waitForProcessExit(child, timeoutMs) {
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

function waitForChildClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function interruptProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGINT');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function runCheckedCommand(command, args) {
  const completed = spawnSync(command, args, { encoding: 'utf8' });

  if (completed.status === 0) {
    return;
  }

  throw new Error(formatCompletedCommand(command, args, completed));
}

function runDiff(expectedPath, actualPath) {
  const completed = spawnSync('diff', ['-u', expectedPath, actualPath], {
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (completed.status === 0) {
    return;
  }

  throw new Error(`Output mismatch: ${expectedPath} vs ${actualPath}`);
}

function readExpectedExitCode(fixtureDir) {
  const exitCodePath = path.join(fixtureDir, 'exit-code.txt');

  if (!fs.existsSync(exitCodePath)) {
    return 0;
  }

  const value = fs.readFileSync(exitCodePath, 'utf8').trim();

  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${exitCodePath}: expected a single non-negative integer exit code`);
  }

  return Number.parseInt(value, 10);
}

function getActualExitCode(result) {
  if (typeof result.exitCode === 'number') {
    return result.exitCode;
  }

  if (result.signalCode) {
    return SIGNAL_EXIT_CODE_OFFSET + getSignalNumber(result.signalCode);
  }

  throw new Error('Command exited without an exit code or signal');
}

function getSignalNumber(signalCode) {
  const signalNumber = os.constants.signals[signalCode];

  if (signalNumber === undefined) {
    throw new Error(`Signal code not found in os.constants.signals: ${signalCode}`);
  }

  return signalNumber;
}

function formatFailures(failures) {
  return failures.map((failure) => `${failure.fixtureDir}\n${failure.message}`).join('\n\n');
}

function formatCompletedCommand(command, args, completed) {
  const stderr = completed.stderr ? `\n${completed.stderr}` : '';
  return `Command failed: ${command} ${args.join(' ')}${stderr}`;
}

function handleFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

module.exports = {
  __test: {
    createContext,
    getActualExitCode,
    getCommandPath,
    parseInvocation,
    readExpectedExitCode,
    stripInlineComment,
  },
};
