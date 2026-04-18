import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { run } from "./app.ts";

const HELP_TEXT = `Usage: openspec-diff [options]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help         display help for command
  --change <name>    change to diff without prompting
  --spec <name>      spec to diff without prompting (repeatable)
  --specs            diff all specs without prompting
`;

function hasHelpArg(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

function parseArgs(args: string[]): [string, string] {
  let changeName = "";
  const selectedSpecs: string[] = [];
  let allSpecs = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--specs") {
      allSpecs = true;
      continue;
    }

    if (arg === "--change" || arg.startsWith("--change=")) {
      if (changeName !== "") {
        throw new Error("--change can only be provided once");
      }

      if (arg === "--change") {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--change requires a value");
        }
        changeName = value;
        index += 1;
        continue;
      }

      const value = arg.slice("--change=".length).trim();
      if (value === "") {
        throw new Error("--change requires a value");
      }
      changeName = value;
      continue;
    }

    if (arg === "--spec" || arg.startsWith("--spec=")) {
      let value = "";
      if (arg === "--spec") {
        const nextValue = args[index + 1];
        if (!nextValue || nextValue.startsWith("-")) {
          throw new Error("--spec requires a value");
        }
        value = nextValue;
        index += 1;
      } else {
        value = arg.slice("--spec=".length).trim();
        if (value === "") {
          throw new Error("--spec requires a value");
        }
      }

      selectedSpecs.push(value);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option ${JSON.stringify(arg)}`);
    }

    throw new Error(
      `unexpected positional argument ${JSON.stringify(arg)}; use --change and --spec instead`,
    );
  }

  if (allSpecs && selectedSpecs.length > 0) {
    throw new Error("cannot use --specs with --spec");
  }

  const specName = allSpecs ? "all" : selectedSpecs.join(",");
  return [changeName, specName];
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

  const [changeName, specName] = parseArgs(args);
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
