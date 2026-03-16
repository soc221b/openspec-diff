#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const outFile = path.resolve("../../dist/target/core/debug/openspec-difftool");

await build({
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  format: "esm",
  outfile: outFile,
  platform: "node",
  sourcemap: true,
  target: "node22",
});

fs.chmodSync(outFile, 0o755);
