import process from "node:process";

import {
  diffWithOpenspecCommand,
  prepareDiffInputsForExternal,
} from "./lib.ts";

const USAGE =
  "Usage: openspec-difftool [--prepare-only] [--difftool <command>] <uri1> <uri2>  # compare two spec file paths";

interface ParsedArgs {
  diffToolCommand: string;
  prepareOnly: boolean;
  uri1: string;
  uri2: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let prepareOnly = false;
  const rest = [...argv];

  if (rest[0] === "--prepare-only") {
    prepareOnly = true;
    rest.shift();
  }

  if (rest.length === 2) {
    return {
      diffToolCommand: "",
      prepareOnly,
      uri1: rest[0],
      uri2: rest[1],
    };
  }

  if (rest.length === 4 && rest[0] === "--difftool") {
    return {
      diffToolCommand: rest[1],
      prepareOnly,
      uri1: rest[2],
      uri2: rest[3],
    };
  }

  throw new Error(USAGE);
}

function main(argv = process.argv.slice(2)): void {
  try {
    const parsed = parseArgs(argv);
    const openspecCommand = process.env.OPENSPEC_DIFF_OPENSPEC_BIN ?? "openspec";

    if (parsed.prepareOnly) {
      const result = prepareDiffInputsForExternal(
        parsed.uri1,
        parsed.uri2,
        openspecCommand,
      );
      process.stdout.write(JSON.stringify(result) + "\n");
      process.exit(0);
    }

    process.exit(
      diffWithOpenspecCommand(
        parsed.uri1,
        parsed.uri2,
        openspecCommand,
        parsed.diffToolCommand,
      ),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

main();
