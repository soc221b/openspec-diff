# openspec-diff

Monorepo scaffold for an OpenSpec diff library, CLI, and VS Code extension.

## Packages

- `@openspec-diff/core` discovers OpenSpec changes and generates unified text diffs for change artifacts and delta specs.
- `@openspec-diff/cli` reuses the same prompt package OpenSpec uses, `@inquirer/prompts`, to let users select a change and render its diff.
- `@openspec-diff/vscode` contributes a **Show OpenSpec Diff** editor title action for Markdown files inside `openspec/changes/<change>/`.

## Development

```bash
npm install
npm run build
npm test
```

## CLI usage

```bash
npm run diff -- --change scaffold-monorepo-cli-vscode
```

If `--change` is omitted, the CLI prompts for one of the available changes using `@inquirer/prompts`.

## VS Code extension

The extension entrypoint is in `packages/vscode`. After building, load that folder as an unpacked extension in VS Code. The editor title button appears for Markdown files whose path lives under `openspec/changes/<change>/`.
