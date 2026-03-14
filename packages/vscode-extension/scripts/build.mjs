import { build } from "esbuild";

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
