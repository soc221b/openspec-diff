import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertFixtureResult, runFixtureCommand, runFixtureSuite } from './run-test.ts';

test('runFixtureCommand captures stdout, stderr, and exit code for non-interactive commands', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-command-'));

  try {
    const result = await runFixtureCommand({
      commands: ['node', '-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
      workingDirectory: workspaceDir,
    });

    assert.deepEqual(result, {
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('runFixtureSuite handles scripted interactive fixtures through the shared runner pipeline', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-suite-'));
  const packageDir = path.join(workspaceRoot, 'packages', 'cli');
  const testsDir = path.join(packageDir, 'tests');
  const fixtureDir = path.join(testsDir, 'interactive-fixture');
  const openspecDir = path.join(fixtureDir, 'openspec');
  const binDir = path.join(packageDir, 'bin');
  const runnerPath = path.join(binDir, 'openspec-diff');

  try {
    fs.mkdirSync(openspecDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      runnerPath,
      [
        '#!/usr/bin/env node',
        'process.stdin.setEncoding("utf8");',
        'let value = "";',
        'process.stdin.on("data", (chunk) => { value += chunk; });',
        'process.stdin.on("end", () => { process.stdout.write(value.toUpperCase()); });',
      ].join('\n'),
      'utf8'
    );
    fs.chmodSync(runnerPath, 0o755);
    fs.writeFileSync(path.join(fixtureDir, 'stdin.txt'), 'openspec-diff\nhello\\n\n', 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'stdout.txt'), 'HELLO\n', 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'exit-code.txt'), '0\n', 'utf8');

    assert.deepEqual(await runFixtureSuite({ workspaceRoot, testsPath: testsDir }), []);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runFixtureSuite reports a timeout when scripted interactive input does not make the process exit', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-timeout-'));
  const packageDir = path.join(workspaceRoot, 'packages', 'cli');
  const testsDir = path.join(packageDir, 'tests');
  const fixtureDir = path.join(testsDir, 'timeout-fixture');
  const openspecDir = path.join(fixtureDir, 'openspec');
  const binDir = path.join(packageDir, 'bin');
  const runnerPath = path.join(binDir, 'openspec-diff');

  try {
    fs.mkdirSync(openspecDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      runnerPath,
      [
        '#!/usr/bin/env node',
        'setInterval(() => {}, 1000);',
        'process.stdin.resume();',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", () => {});',
      ].join('\n'),
      'utf8'
    );
    fs.chmodSync(runnerPath, 0o755);
    fs.writeFileSync(path.join(fixtureDir, 'stdin.txt'), 'openspec-diff\nhello\\n\n', 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'stdout.txt'), '', 'utf8');

    const failures = await runFixtureSuite({ workspaceRoot, testsPath: testsDir });

    assert.deepEqual(failures, [
      {
        fixtureDir,
        message: `${path.join(fixtureDir, 'stdin.txt')}:2: process did not exit after scripted input; add ^C or explicit submit input such as \\n`,
      },
    ]);
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
