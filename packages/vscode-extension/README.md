# OpenSpec Diff

OpenSpec Diff is a VS Code extension for working with OpenSpec changes.

## Local install

Install the extension into VS Code from a fresh clone:

```sh
git clone https://github.com/soc221b/openspec-diff.git
cd openspec-diff
npm ci
npm run install:local --workspace openspec-diff-vscode-extension
```

The install script builds the extension, packages `dist/openspec-diff.vsix`, and installs it into VS Code.

If the `code` command is not available, open the VS Code Command Palette and run `Shell Command: Install 'code' command in PATH`, then rerun the install command.
