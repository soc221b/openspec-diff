import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertFixtureResult, runFixtureCommand } from './run-test.ts';

const RUN_TEST_PATH = fileURLToPath(new URL('./run-test.ts', import.meta.url));

function createCliFixtureWorkspace({
  prefix,
  fixtureName,
  runnerLines,
  stdin,
  stdout = '',
  stderr,
  exitCode,
}: {
  prefix: string;
  fixtureName: string;
  runnerLines: string[];
  stdin: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const packageDir = path.join(workspaceRoot, 'packages', 'cli');
  const testsDir = path.join(packageDir, 'tests');
  const fixtureDir = path.join(testsDir, fixtureName);
  const openspecDir = path.join(fixtureDir, 'openspec');
  const binDir = path.join(packageDir, 'bin');
  const runnerPath = path.join(binDir, 'openspec-diff');

  fs.mkdirSync(openspecDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(runnerPath, runnerLines.join('\n'), 'utf8');
  fs.chmodSync(runnerPath, 0o755);
  fs.writeFileSync(path.join(fixtureDir, 'stdin.txt'), stdin, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'stdout.txt'), stdout, 'utf8');

  if (stderr !== undefined) {
    fs.writeFileSync(path.join(fixtureDir, 'stderr.txt'), stderr, 'utf8');
  }

  if (exitCode !== undefined) {
    fs.writeFileSync(path.join(fixtureDir, 'exit-code.txt'), `${exitCode}\n`, 'utf8');
  }

  return { workspaceRoot, testsDir, fixtureDir };
}

test('runFixtureCommand captures stdout, stderr, and exit code from { stdin, path }', async () => {
  const { workspaceRoot, fixtureDir } = createCliFixtureWorkspace({
    prefix: 'run-test-command-',
    fixtureName: 'command-fixture',
    runnerLines: [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      'process.stdin.on("data", () => {});',
      'process.stdin.on("end", () => { process.stdout.write("out"); process.stderr.write("err"); process.exit(3); });',
    ],
    stdin: 'openspec-diff\ninput\n',
  });

  try {
    const stdin = fs.readFileSync(path.join(fixtureDir, 'stdin.txt'), 'utf8');
    const result = await runFixtureCommand({
      stdin,
      path: fixtureDir,
    });

    assert.deepEqual(result, {
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runFixtureCommand handles scripted interactive fixtures through the shared runner pipeline', async () => {
  const { workspaceRoot, fixtureDir } = createCliFixtureWorkspace({
    prefix: 'run-test-suite-',
    fixtureName: 'interactive-fixture',
    runnerLines: [
      '#!/usr/bin/env node',
      'process.stdin.setEncoding("utf8");',
      'let value = "";',
      'process.stdin.on("data", (chunk) => { value += chunk; });',
      'process.stdin.on("end", () => { process.stdout.write(value.toUpperCase()); });',
    ],
    stdin: 'openspec-diff\nhello\\n\n',
    stdout: 'HELLO\n',
    exitCode: 0,
  });

  try {
    const stdin = fs.readFileSync(path.join(fixtureDir, 'stdin.txt'), 'utf8');

    assert.deepEqual(
      await runFixtureCommand({
        stdin,
        path: fixtureDir,
      }),
      {
        stdout: 'HELLO\n',
        stderr: '',
        exitCode: 0,
      }
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runFixtureCommand reports a timeout when scripted interactive input does not make the process exit', async () => {
  const { workspaceRoot, fixtureDir } = createCliFixtureWorkspace({
    prefix: 'run-test-timeout-',
    fixtureName: 'timeout-fixture',
    runnerLines: [
      '#!/usr/bin/env node',
      'setInterval(() => {}, 1000);',
      'process.stdin.resume();',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", () => {});',
    ],
    stdin: 'openspec-diff\nhello\\n\n',
    stdout: '',
  });

  try {
    const stdin = fs.readFileSync(path.join(fixtureDir, 'stdin.txt'), 'utf8');

    await assert.rejects(
      runFixtureCommand({
        stdin,
        path: fixtureDir,
      }),
      {
        message: `${path.join(fixtureDir, 'stdin.txt')}:2: process did not exit after scripted input; add ^C or explicit submit input such as \\n`,
      }
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('main prints dots and exits 0 when fixtures pass', async () => {
  const { workspaceRoot, testsDir } = createCliFixtureWorkspace({
    prefix: 'run-test-main-pass-',
    fixtureName: 'pass-fixture',
    runnerLines: [
      '#!/usr/bin/env node',
      'process.stdin.setEncoding("utf8");',
      'let value = "";',
      'process.stdin.on("data", (chunk) => { value += chunk; });',
      'process.stdin.on("end", () => { process.stdout.write(value.toUpperCase()); });',
    ],
    stdin: 'openspec-diff\nhello\\n\n',
    stdout: 'HELLO\n',
    exitCode: 0,
  });
  try {
    const completed = spawnSync(
      'node',
      [RUN_TEST_PATH, testsDir],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    );

    assert.equal(completed.status, 0);
    assert.equal(completed.stdout, '.\n');
    assert.equal(completed.stderr, '');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('main prints x and exits 1 when any fixture fails', async () => {
  const { workspaceRoot, testsDir, fixtureDir } = createCliFixtureWorkspace({
    prefix: 'run-test-main-fail-',
    fixtureName: 'fail-fixture',
    runnerLines: [
      '#!/usr/bin/env node',
      'setInterval(() => {}, 1000);',
      'process.stdin.resume();',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", () => {});',
    ],
    stdin: 'openspec-diff\nhello\\n\n',
    stdout: '',
  });
  try {
    const completed = spawnSync(
      'node',
      [RUN_TEST_PATH, testsDir],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    );

    assert.equal(completed.status, 1);
    assert.equal(completed.stdout, 'x\n');
    assert.match(
      completed.stderr,
      new RegExp(
        `${fixtureDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n${path
          .join(fixtureDir, 'stdin.txt')
          .replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:2: process did not exit after scripted input`
      )
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('assertFixtureResult returns exitCode 0 when expected and actual files match', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-assert-'));
  const expectedPath = path.join(fixtureDir, 'expected.txt');
  const actualPath = path.join(fixtureDir, 'actual.txt');

  fs.writeFileSync(expectedPath, 'hello\n', 'utf8');
  fs.writeFileSync(actualPath, 'hello\n', 'utf8');

  try {
    assert.deepEqual(assertFixtureResult({ expectedPath, actualPath }), { exitCode: 0 });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('assertFixtureResult returns exitCode 1 when expected and actual files differ', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-assert-fail-'));
  const expectedPath = path.join(fixtureDir, 'expected.txt');
  const actualPath = path.join(fixtureDir, 'actual.txt');

  fs.writeFileSync(expectedPath, 'ok\n', 'utf8');
  fs.writeFileSync(actualPath, 'nope\n', 'utf8');

  try {
    assert.deepEqual(assertFixtureResult({ expectedPath, actualPath }), { exitCode: 1 });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('assertFixtureResult returns exitCode 2 when a compared file does not exist', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-assert-missing-'));
  const expectedPath = path.join(fixtureDir, 'expected.txt');
  const actualPath = path.join(fixtureDir, 'actual.txt');

  fs.writeFileSync(expectedPath, 'ok\n', 'utf8');

  try {
    assert.deepEqual(assertFixtureResult({ expectedPath, actualPath }), { exitCode: 2 });
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
