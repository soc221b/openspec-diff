import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { run } from "./app.ts";

const HELP_TEXT = `Usage: openspec-diff [options] [change-name] [spec-name[,spec-name...]]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help       display help for command
  --specs          diff all specs without prompting
`;

function hasHelpArg(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

function parsePositionalArgs(args: string[]): [string, string] {
  const positionalArgs: string[] = [];
  let allSpecs = false;

  for (const arg of args) {
    if (arg === "--specs") {
      allSpecs = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option ${JSON.stringify(arg)}`);
    }
    positionalArgs.push(arg);
  }

  if (positionalArgs.length > 2) {
    throw new Error(
      "expected at most one change name argument and one spec name argument",
    );
  }

  if (allSpecs) {
    if (positionalArgs.length === 2) {
      throw new Error("cannot use --specs with a spec name argument");
    }
    if (positionalArgs.length === 0) {
      return ["", "all"];
    }
    return [positionalArgs[0], "all"];
  }

  if (positionalArgs.length === 0) {
    return ["", ""];
  }
  if (positionalArgs.length === 1) {
    return [positionalArgs[0], ""];
  }
  return [positionalArgs[0], positionalArgs[1]];
}

async function runCommand(
  dir: string,
  name: string,
  ...args: string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = spawn(name, args, {
      cwd: dir,
      stdio: "inherit",
    });

    command.on("error", reject);
    command.on("close", (code, signal) => {
      if (code === 0 || code === 1) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${name} terminated with signal ${signal}`
            : `${name} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function coreDiffCommand(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "openspec-difftool",
  );
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (hasHelpArg(args)) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const [changeName, specName] = parsePositionalArgs(args);
  await run(
    process.stdin,
    process.stdout,
    ".",
    changeName,
    specName,
    coreDiffCommand(),
    runCommand,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
