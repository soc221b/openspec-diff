## Overview

Use a small TypeScript workspace monorepo so the shared diff logic can be authored once and consumed by both the CLI and the VS Code extension. The initial scaffold should prioritize minimal tooling and straightforward local development over advanced release automation.

## Package Layout

```text
packages/
├── core/
│   └── src/
├── cli/
│   └── src/
└── vscode/
    └── src/
```

- `core` owns OpenSpec change discovery, spec file loading, and diff generation.
- `cli` depends on `core` and only adds argument parsing, interactive change selection, and terminal rendering.
- `vscode` depends on `core` and only adds editor integration, commands, and presentation inside VS Code.

## Monorepo Tooling

- Use built-in npm workspaces to avoid introducing unnecessary package-management complexity in a brand-new repository.
- Share TypeScript configuration from the repo root so all packages compile consistently.
- Keep build and test scripts package-local, with root scripts delegating to workspace commands.

## Core Package Responsibilities

The core package should expose a small API surface that is independent of CLI and VS Code specifics:

- find available OpenSpec changes in `openspec/changes/`
- resolve the active change and relevant spec files
- generate a structured diff result that downstream packages can format for their UI

Returning structured data instead of terminal-ready text keeps the core reusable for the extension.

## CLI Interaction

The CLI should:

1. discover available changes through `core`
2. present an interactive selector when the user did not pass a change name explicitly
3. show the diff for the chosen change

To satisfy the UI requirement, first inspect the prompt library OpenSpec uses and reuse that same open-source package in the CLI. If OpenSpec relies on internal or unpublished code, introduce a small in-repo selector built on a public package so the CLI still offers an interactive picker without coupling to unavailable internals.

## VS Code Extension UX

The extension should register a command and an editor title button that is visible only when:

- the active editor is a Markdown spec file
- the file path is inside `openspec/changes/<change>/`

When triggered, the command should resolve the owning change from the active file path, call `core` to generate the diff, and show the result in a VS Code-friendly surface. A secondary editor or webview is acceptable as long as the command is reachable from the title bar and clearly tied to the open change file.

## Risks and Mitigations

- **Unknown OpenSpec prompt dependency**: isolate change selection behind a CLI adapter so the implementation can switch between a reused dependency and a local selector with minimal churn.
- **Shared code portability**: keep `core` free of Node-only CLI assumptions so the VS Code extension can bundle it cleanly.
- **Extension visibility noise**: gate the title button with path checks so it only appears for relevant files in change directories.
