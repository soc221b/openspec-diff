import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const coreOutFile = path.resolve(
  "../../dist/target/core/debug/openspec-difftool",
);
const bundledCoreOutFile = path.resolve("dist/openspec-difftool");

await build({
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "esm",
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: true,
  target: "node22",
});

fs.mkdirSync(path.dirname(bundledCoreOutFile), { recursive: true });
fs.copyFileSync(coreOutFile, bundledCoreOutFile);
fs.chmodSync(bundledCoreOutFile, 0o755);
