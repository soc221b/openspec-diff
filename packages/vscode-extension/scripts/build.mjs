import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  outfile: "dist/extension.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
