import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertFixtureResult, runFixtureCommand } from './run-test.mjs';

test('runFixtureCommand captures stdout, stderr, and exit code for non-interactive commands', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-command-'));

  try {
    const result = await runFixtureCommand(
      {
        command: ['node', '-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
        instructions: [],
        interactive: false,
      },
      workspaceDir
    );

    assert.deepEqual(result, {
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
      signalCode: null,
      aborted: false,
      timedOut: false,
    });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('runFixtureCommand replays scripted interactive input before collecting results', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-interactive-'));

  try {
    const result = await runFixtureCommand(
      {
        command: [
          'node',
          '-e',
          [
            'process.stdin.setEncoding("utf8");',
            'let value = "";',
            'process.stdin.on("data", (chunk) => { value += chunk; });',
            'process.stdin.on("end", () => { process.stdout.write(value.toUpperCase()); });',
          ].join(' '),
        ],
        instructions: [{ lineNumber: 2, value: 'hello\\n' }],
        interactive: true,
        stdinPath: '/fixture/stdin.txt',
      },
      workspaceDir
    );

    assert.equal(result.stdout, 'HELLO\n');
    assert.equal(result.stderr, '');
    assert.equal(result.exitCode, 0);
    assert.equal(result.signalCode, null);
    assert.equal(result.aborted, false);
    assert.equal(result.timedOut, false);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('assertFixtureResult compares stdout, stderr, and exit codes together', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-assert-'));
  const workspaceDir = path.join(fixtureDir, 'workspace');
  const stdoutPath = path.join(fixtureDir, 'actual-stdout.txt');
  const stderrPath = path.join(fixtureDir, 'actual-stderr.txt');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'stdout.txt'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'stderr.txt'), `${fixtureDir}/problem\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'exit-code.txt'), '130\n', 'utf8');

  try {
    assert.doesNotThrow(() =>
      assertFixtureResult({
        fixtureDir,
        commandPlan: {
          fixtureDir,
          stdinPath: path.join(fixtureDir, 'stdin.txt'),
          instructions: [{ lineNumber: 2, value: '^C' }],
        },
        outputPaths: { workspaceDir, stdoutPath, stderrPath },
        result: {
          stdout: 'hello\n',
          stderr: `${workspaceDir}/problem\n`,
          exitCode: null,
          signalCode: 'SIGINT',
          aborted: true,
          timedOut: false,
        },
      })
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('assertFixtureResult fails when the exit code does not match the fixture expectation', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-assert-fail-'));
  const workspaceDir = path.join(fixtureDir, 'workspace');
  const stdoutPath = path.join(fixtureDir, 'actual-stdout.txt');
  const stderrPath = path.join(fixtureDir, 'actual-stderr.txt');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'stdout.txt'), 'ok\n', 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'exit-code.txt'), '0\n', 'utf8');

  try {
    assert.throws(
      () =>
        assertFixtureResult({
          fixtureDir,
          commandPlan: {
            fixtureDir,
            stdinPath: path.join(fixtureDir, 'stdin.txt'),
            instructions: [],
          },
          outputPaths: { workspaceDir, stdoutPath, stderrPath },
          result: {
            stdout: 'ok\n',
            stderr: '',
            exitCode: 1,
            signalCode: null,
            aborted: false,
            timedOut: false,
          },
        }),
      new RegExp(`${fixtureDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/exit-code.txt: expected 0, received 1`)
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
