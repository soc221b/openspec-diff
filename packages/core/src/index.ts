import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ChangeSummary {
  name: string;
  path: string;
  markdownFileCount: number;
}

export interface ChangeFileDiff {
  kind: 'artifact' | 'delta-spec';
  relativePath: string;
  previousPath: string | null;
  currentPath: string;
  diff: string[];
}

export interface ChangeDiffResult {
  change: ChangeSummary;
  files: ChangeFileDiff[];
}

const CHANGE_ROOT_PARTS = ['openspec', 'changes'] as const;

export async function findChanges(repoRoot: string): Promise<ChangeSummary[]> {
  const changesDir = path.join(repoRoot, ...CHANGE_ROOT_PARTS);
  const entries = await fs.readdir(changesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  const changes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map(async (entry) => {
        const changePath = path.join(changesDir, entry.name);
        const markdownFiles = await collectMarkdownFiles(changePath);

        return {
          name: entry.name,
          path: changePath,
          markdownFileCount: markdownFiles.length,
        } satisfies ChangeSummary;
      }),
  );

  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

export function isChangeMarkdownFile(repoRoot: string, filePath: string): boolean {
  const relativePath = path.relative(repoRoot, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  const segments = relativePath.split(path.sep);

  return (
    segments.length >= 4 &&
    segments[0] === 'openspec' &&
    segments[1] === 'changes' &&
    segments[2] !== 'archive' &&
    filePath.endsWith('.md')
  );
}

export function inferChangeNameFromPath(repoRoot: string, filePath: string): string | null {
  if (!isChangeMarkdownFile(repoRoot, filePath)) {
    return null;
  }

  const relativePath = path.relative(repoRoot, filePath);

  return relativePath.split(path.sep)[2] ?? null;
}

export async function generateChangeDiff(repoRoot: string, changeName: string): Promise<ChangeDiffResult> {
  const changes = await findChanges(repoRoot);
  const change = changes.find((candidate) => candidate.name === changeName);

  if (!change) {
    throw new Error(`Change "${changeName}" was not found in ${path.join(repoRoot, ...CHANGE_ROOT_PARTS)}.`);
  }

  const changeFiles = await collectMarkdownFiles(change.path);
  const files = await Promise.all(
    changeFiles.map(async (absolutePath) => {
      const relativePath = path.relative(change.path, absolutePath);
      const currentPath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
      const previousAbsolutePath = resolvePreviousPath(repoRoot, change.path, relativePath);
      const currentContent = await fs.readFile(absolutePath, 'utf8');
      const previousContent = previousAbsolutePath ? await safeReadText(previousAbsolutePath) : '';
      const previousPath =
        previousAbsolutePath && previousContent !== ''
          ? path.relative(repoRoot, previousAbsolutePath).split(path.sep).join('/')
          : null;

      return {
        kind: relativePath.startsWith(`specs${path.sep}`) ? 'delta-spec' : 'artifact',
        relativePath: relativePath.split(path.sep).join('/'),
        previousPath,
        currentPath,
        diff: buildUnifiedDiff(previousPath, currentPath, previousContent, currentContent),
      } satisfies ChangeFileDiff;
    }),
  );

  return {
    change,
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
}

export function formatChangeDiff(result: ChangeDiffResult): string {
  const lines = [`# OpenSpec diff: ${result.change.name}`, ''];

  if (result.files.length === 0) {
    lines.push('No Markdown files were found for this change.');
    return lines.join('\n');
  }

  for (const file of result.files) {
    lines.push(`## ${file.relativePath} (${file.kind})`);
    lines.push(...file.diff, '');
  }

  return lines.join('\n').trimEnd();
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectMarkdownFiles(absolutePath);
      }

      return entry.isFile() && entry.name.endsWith('.md') ? [absolutePath] : [];
    }),
  );

  return files.flat();
}

function resolvePreviousPath(repoRoot: string, changePath: string, relativePath: string): string | null {
  if (!relativePath.startsWith(`specs${path.sep}`)) {
    return null;
  }

  return path.join(repoRoot, 'openspec', 'specs', relativePath.slice(`specs${path.sep}`.length));
}

async function safeReadText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

function buildUnifiedDiff(previousPath: string | null, currentPath: string, previousContent: string, currentContent: string): string[] {
  const beforeLines = splitLines(previousContent);
  const afterLines = splitLines(currentContent);
  const diffBody = diffLines(beforeLines, afterLines);

  return [
    `--- ${previousPath ?? '/dev/null'}`,
    `+++ ${currentPath}`,
    ...diffBody,
  ];
}

function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }

  return content.split('\n');
}

function diffLines(beforeLines: string[], afterLines: string[]): string[] {
  const matrix = Array.from({ length: beforeLines.length + 1 }, () => new Array<number>(afterLines.length + 1).fill(0));

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      matrix[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? matrix[beforeIndex + 1]![afterIndex + 1]! + 1
          : Math.max(matrix[beforeIndex + 1]![afterIndex]!, matrix[beforeIndex]![afterIndex + 1]!);
    }
  }

  const operations: string[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      operations.push(` ${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (matrix[beforeIndex + 1]![afterIndex]! >= matrix[beforeIndex]![afterIndex + 1]!) {
      operations.push(`-${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
    } else {
      operations.push(`+${afterLines[afterIndex]}`);
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    operations.push(`-${beforeLines[beforeIndex]}`);
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    operations.push(`+${afterLines[afterIndex]}`);
    afterIndex += 1;
  }

  return operations;
}
