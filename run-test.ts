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
const SUCCESS_EXIT_CODES = new Set([0, 1]);

main().catch(handleFatalError);

async function main() {
  const testsPath = getTestsPath(process.argv);
  const workspaceRoot = __dirname;
  const context = createContext(workspaceRoot, testsPath);

  ensurePathExists(testsPath);

  for (const fixtureDir of getFixtureDirectories(testsPath)) {
    await runFixture(context, fixtureDir);
  }
}

async function runFixture(context, fixtureDir) {
  ensureFixtureInputs(fixtureDir);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-diff-test-'));

  try {
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

    writeCommandOutputs(outputPaths, result);
    validateCommandResult(result, commandPlan, fixtureDir, context.interactive);
    assertFixtureOutputs(fixtureDir, outputPaths);
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
  const child = spawn(commandPlan.command[0], commandPlan.command.slice(1), {
    cwd: outputPaths.workspaceDir,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let aborted = false;
  let timedOut = false;

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  for (const instruction of commandPlan.instructions) {
    if (instruction.value === '^C') {
      aborted = true;
      await waitForOutputToSettle(child, () => stdout.length);
      interruptProcessGroup(child.pid);
      break;
    }

    child.stdin.write(decodeInstruction(instruction.value, commandPlan.stdinPath, instruction.lineNumber));
    await waitForOutputToSettle(child, () => stdout.length);

    if (child.exitCode !== null) {
      break;
    }
  }

  if (!aborted && child.exitCode === null) {
    child.stdin.end();

    if (!(await waitForProcessExit(child, PROCESS_EXIT_TIMEOUT_MS))) {
      timedOut = true;
      interruptProcessGroup(child.pid);
    }
  }

  const closeDetails = await waitForChildClose(child);

  return {
    stdout,
    stderr,
    exitCode: closeDetails.code,
    signalCode: closeDetails.signal,
    aborted,
    timedOut,
  };
}

function validateCommandResult(result, commandPlan, fixtureDir, interactive) {
  if (interactive && result.timedOut) {
    const lastInstruction = commandPlan.instructions.at(-1);
    const lineNumber = lastInstruction?.lineNumber ?? 1;

    throw new Error(
      `${commandPlan.stdinPath}:${lineNumber}: process did not exit after scripted input; add ^C or explicit submit input such as \\n`
    );
  }

  if (SUCCESS_EXIT_CODES.has(result.exitCode ?? -1)) {
    return;
  }

  if (interactive && result.aborted && (result.signalCode === 'SIGINT' || result.exitCode === 130)) {
    return;
  }

  throw new Error(formatCommandFailure(fixtureDir, result));
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
  const testsDir = path.basename(testsPath) === 'tests' ? testsPath : path.dirname(testsPath);
  const packageDir = path.dirname(testsDir);

  if (path.basename(packageDir) === 'cli') {
    return {
      interactive: true,
      commandName: 'openspec-diff',
      workspaceRoot,
      packageDir,
    };
  }

  if (path.basename(packageDir) === 'core') {
    return {
      interactive: false,
      commandName: 'openspec-difftool',
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
    stdinPath,
    command,
    instructions,
  };
}

function writeCommandOutputs(outputPaths, result) {
  fs.writeFileSync(outputPaths.stdoutPath, normalizeOutput(result.stdout), 'utf8');
  fs.writeFileSync(outputPaths.stderrPath, result.stderr, 'utf8');
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
  if (context.interactive) {
    return path.join(context.packageDir, 'bin', 'openspec-diff');
  }

  return path.join(context.workspaceRoot, 'dist', 'target', 'core', 'debug', 'openspec-difftool');
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
  let escaped = false;
  let quote = null;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
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
  let escaped = false;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '#') {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trim();
}

function decodeInstruction(value, stdinPath, lineNumber) {
  try {
    return value.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\\'"abfnrtv]))/g,
      (match, unicodeHex, asciiHex, escapedChar) => decodeEscape(match, unicodeHex, asciiHex, escapedChar)
    );
  } catch (error) {
    throw new Error(`${stdinPath}:${lineNumber}: invalid escape sequence in stdin instruction: ${error.message}`);
  }
}

function decodeEscape(match, unicodeHex, asciiHex, escapedChar) {
  if (unicodeHex) {
    return String.fromCharCode(Number.parseInt(unicodeHex, 16));
  }

  if (asciiHex) {
    return String.fromCharCode(Number.parseInt(asciiHex, 16));
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
  const withoutRedrawHistory = value.includes('\u001b[J') ? value.split('\u001b[J').at(-1) : value;
  return withoutRedrawHistory.replace(/\u001b\[\d+A/g, '');
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

function formatCommandFailure(fixtureDir, result) {
  const code = result.exitCode === null ? 'null' : String(result.exitCode);
  const signal = result.signalCode ? `, signal ${result.signalCode}` : '';
  return `Command failed for ${fixtureDir} with exit code ${code}${signal}`;
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
