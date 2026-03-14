import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  findChanges,
  formatChangeDiff,
  generateChangeDiff,
  inferChangeNameFromPath,
  isChangeMarkdownFile,
} from './index.js';

function createFixture() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'openspec-diff-'));

  mkdirSync(path.join(repoRoot, 'openspec', 'specs', 'capability'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'openspec', 'changes', 'demo-change', 'specs', 'capability'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'openspec', 'changes', 'archive'), { recursive: true });

  writeFileSync(
    path.join(repoRoot, 'openspec', 'specs', 'capability', 'spec.md'),
    ['# Capability', '', '## Requirement', 'Old behavior'].join('\n'),
  );
  writeFileSync(
    path.join(repoRoot, 'openspec', 'changes', 'demo-change', 'specs', 'capability', 'spec.md'),
    ['# Capability', '', '## Requirement', 'New behavior'].join('\n'),
  );
  writeFileSync(
    path.join(repoRoot, 'openspec', 'changes', 'demo-change', 'proposal.md'),
    ['## Why', '', 'Because it is useful.'].join('\n'),
  );

  return repoRoot;
}

test('findChanges returns active changes and ignores archive', async () => {
  const repoRoot = createFixture();

  const changes = await findChanges(repoRoot);

  assert.deepEqual(changes.map((change) => change.name), ['demo-change']);
  assert.equal(changes[0]?.markdownFileCount, 2);
});

test('path helpers recognize markdown files inside a change', () => {
  const repoRoot = createFixture();
  const changeFile = path.join(repoRoot, 'openspec', 'changes', 'demo-change', 'specs', 'capability', 'spec.md');
  const unrelatedFile = path.join(repoRoot, 'README.md');

  assert.equal(isChangeMarkdownFile(repoRoot, changeFile), true);
  assert.equal(inferChangeNameFromPath(repoRoot, changeFile), 'demo-change');
  assert.equal(isChangeMarkdownFile(repoRoot, unrelatedFile), false);
  assert.equal(inferChangeNameFromPath(repoRoot, unrelatedFile), null);
});

test('generateChangeDiff compares delta specs with canonical specs and artifacts as added files', async () => {
  const repoRoot = createFixture();

  const diff = await generateChangeDiff(repoRoot, 'demo-change');
  const formatted = formatChangeDiff(diff);

  assert.equal(diff.files.length, 2);
  assert.match(formatted, /--- openspec\/specs\/capability\/spec\.md/);
  assert.match(formatted, /\+New behavior/);
  assert.match(formatted, /--- \/dev\/null/);
  assert.match(formatted, /\+\#\# Why/);
});
