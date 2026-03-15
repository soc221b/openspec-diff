import process from "node:process";

import { diffWithOpenspecCommand } from "./lib.ts";

const USAGE =
  "Usage: openspec-difftool <uri1> <uri2>  # compare two spec file paths";

function main(argv = process.argv.slice(2)): void {
  if (argv.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  const openspecCommand = process.env.OPENSPEC_DIFF_OPENSPEC_BIN ?? "openspec";

  try {
    process.exit(diffWithOpenspecCommand(argv[0], argv[1], openspecCommand));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

main();
