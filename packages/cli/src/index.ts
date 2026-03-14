#!/usr/bin/env node
import path from 'node:path';

import { select } from '@inquirer/prompts';
import { findChanges, formatChangeDiff, generateChangeDiff } from '@openspec-diff/core';

interface CliOptions {
  changeName?: string;
  repoRoot: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const changeName = options.changeName ?? (await promptForChange(options.repoRoot));

  const diff = await generateChangeDiff(options.repoRoot, changeName);
  process.stdout.write(`${formatChangeDiff(diff)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let changeName: string | undefined;
  let repoRoot = process.cwd();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--change') {
      changeName = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === '--repo-root') {
      repoRoot = path.resolve(args[index + 1] ?? repoRoot);
      index += 1;
    }
  }

  return {
    changeName,
    repoRoot,
  };
}

async function promptForChange(repoRoot: string): Promise<string> {
  const changes = await findChanges(repoRoot);

  if (changes.length === 0) {
    throw new Error(`No OpenSpec changes were found in ${path.join(repoRoot, 'openspec', 'changes')}.`);
  }

  if (changes.length === 1) {
    return changes[0]!.name;
  }

  return select({
    message: 'Select an OpenSpec change to diff',
    choices: changes.map((change) => ({
      name: `${change.name} (${change.markdownFileCount} markdown files)`,
      value: change.name,
    })),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
