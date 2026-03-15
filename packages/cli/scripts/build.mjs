#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const cliOutFile = path.resolve("bin/openspec-diff");
const coreOutFile = path.resolve(
  "../../dist/target/core/debug/openspec-difftool",
);
const bundledCoreOutFile = path.resolve("bin/openspec-difftool");

await build({
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  format: "esm",
  outfile: cliOutFile,
  platform: "node",
  sourcemap: true,
  target: "node22",
});

fs.mkdirSync(path.dirname(bundledCoreOutFile), { recursive: true });
fs.copyFileSync(coreOutFile, bundledCoreOutFile);
fs.chmodSync(cliOutFile, 0o755);
fs.chmodSync(bundledCoreOutFile, 0o755);
