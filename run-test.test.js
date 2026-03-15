const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { __test } = require('./run-test.ts');

test('stripInlineComment preserves quoted hash characters', () => {
  assert.equal(
    __test.stripInlineComment(`openspec-diff "value # kept" '# also kept' # removed`),
    `openspec-diff "value # kept" '# also kept'`
  );
});

test('parseInvocation tokenizes quoted and escaped arguments', () => {
  assert.deepEqual(
    __test.parseInvocation(
      String.raw`openspec-diff --title "hello world" --path path\ with\ spaces --literal '#value'`,
      '/fixture/stdin.txt',
      1
    ),
    ['openspec-diff', '--title', 'hello world', '--path', 'path with spaces', '--literal', '#value']
  );
});

test('parseInvocation rejects unterminated quotes', () => {
  assert.throws(
    () => __test.parseInvocation(`openspec-diff "unterminated`, '/fixture/stdin.txt', 2),
    /\/fixture\/stdin\.txt:2: invalid CLI invocation in stdin\.txt/
  );
});

test('readExpectedExitCode defaults to zero when exit-code.txt is missing', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-read-exit-'));

  try {
    assert.equal(__test.readExpectedExitCode(fixtureDir), 0);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('getActualExitCode converts signal exits to shell-style codes', () => {
  assert.equal(__test.getActualExitCode({ exitCode: null, signalCode: 'SIGINT' }), 130);
});

test('createContext maps CLI tests to the interactive binary path', () => {
  const workspaceRoot = '/repo';
  const context = __test.createContext(workspaceRoot, '/repo/packages/cli/tests');

  assert.equal(context.interactive, true);
  assert.equal(context.commandName, 'openspec-diff');
  assert.equal(__test.getCommandPath(context), '/repo/packages/cli/bin/openspec-diff');
});

test('createContext maps core fixture paths to the compiled difftool path', () => {
  const workspaceRoot = '/repo';
  const context = __test.createContext(workspaceRoot, '/repo/packages/core/tests/diff-fixture');

  assert.equal(context.interactive, false);
  assert.equal(context.commandName, 'openspec-difftool');
  assert.equal(__test.getCommandPath(context), '/repo/dist/target/core/debug/openspec-difftool');
});
