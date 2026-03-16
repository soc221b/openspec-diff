import process from "node:process";

import { diffWithOpenspecCommand } from "./lib.ts";

const USAGE =
  "Usage: openspec-difftool [--difftool <command>] <uri1> <uri2>  # compare two spec file paths";

interface ParsedArgs {
  diffToolCommand: string;
  uri1: string;
  uri2: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 2) {
    return {
      diffToolCommand: "",
      uri1: argv[0],
      uri2: argv[1],
    };
  }

  if (argv.length === 4 && argv[0] === "--difftool") {
    return {
      diffToolCommand: argv[1],
      uri1: argv[2],
      uri2: argv[3],
    };
  }

  throw new Error(USAGE);
}

function main(argv = process.argv.slice(2)): void {
  try {
    const parsed = parseArgs(argv);
    const openspecCommand = process.env.OPENSPEC_DIFF_OPENSPEC_BIN ?? "openspec";
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
