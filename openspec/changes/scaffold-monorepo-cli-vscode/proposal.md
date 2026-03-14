## Why

The repository currently only contains OpenSpec scaffolding, so there is no implementation surface for diffing OpenSpec changes from the command line or from VS Code. Scaffolding a monorepo provides a clean place to host a shared diff engine, a CLI that exposes it to users, and a VS Code extension that makes the same capability discoverable while editing change files.

## What Changes

- Scaffold a JavaScript/TypeScript monorepo with workspace support for shared packages.
- Add a shared core package that computes the OpenSpec diff data used by other packages.
- Add a CLI package that lists available changes, lets the user select one with the same prompt package OpenSpec already uses when possible, and renders the diff through the core package.
- Add a VS Code extension package that contributes an editor title toggle button when the active file is a spec file inside an `openspec/changes/<change>/` directory and uses the core package to show the diff for that change.

## Impact

- Introduces workspace tooling, package manifests, and build/test configuration for the new monorepo.
- Establishes a reusable API boundary between the diff logic and the package-specific user interfaces.
- Adds follow-on implementation work for CLI interaction, VS Code activation, and extension UX verification.
