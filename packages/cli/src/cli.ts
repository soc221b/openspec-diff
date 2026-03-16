import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { run } from "./app.ts";

const HELP_TEXT = `Usage: openspec-diff [options] [change-name] [spec-name[,spec-name...]]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help       display help for command
  --difftool       command used to diff two files
  --specs          diff all specs without prompting
`;

type ParsedCliArgs =
  | {
      help: true;
    }
  | {
      help: false;
      changeName: string;
      diffTool: string;
      specName: string;
    };

function createProgram(): Command {
  return new Command()
    .name("openspec-diff")
    .argument("[change-name]")
    .argument("[spec-name]")
    .option("--difftool <command>", "command used to diff two files")
    .option("--specs", "diff all specs without prompting")
    .helpOption("-h, --help", "display help for command")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
}

function parseArgs(args: string[]): ParsedCliArgs {
  const program = createProgram();

  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        return { help: true };
      }

      if (error.code === "commander.excessArguments") {
        throw new Error(
          "expected at most one change name argument and one spec name argument",
        );
      }

      if (error.code === "commander.unknownOption") {
        throw new Error(error.message.replace(/^error: /, "").replace(/'/g, '"'));
      }
    }

    throw error;
  }

  const positionalArgs = program.args as string[];
  const options = program.opts<{ difftool?: string; specs?: boolean }>();
  const changeName = positionalArgs[0] ?? "";
  const inputSpecName = positionalArgs[1] ?? "";

  if (options.specs) {
    if (inputSpecName !== "") {
      throw new Error("cannot use --specs with a spec name argument");
    }
    return {
      help: false,
      changeName,
      diffTool: options.difftool ?? "",
      specName: "all",
    };
  }

  return {
    help: false,
    changeName,
    diffTool: options.difftool ?? "",
    specName: inputSpecName,
  };
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
  const parsed = parseArgs(args);

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  await run(
    process.stdin,
    process.stdout,
    ".",
    parsed.changeName,
    parsed.specName,
    parsed.diffTool,
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
