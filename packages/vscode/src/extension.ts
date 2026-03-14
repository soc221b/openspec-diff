import path from 'node:path';
import { existsSync } from 'node:fs';

import * as vscode from 'vscode';

import { formatChangeDiff, generateChangeDiff, inferChangeNameFromPath, isChangeMarkdownFile } from '@openspec-diff/core';

const COMMAND_ID = 'openspecDiff.showChangeDiff';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showInformationMessage('Open a change Markdown file to view its OpenSpec diff.');
        return;
      }

      const repoRoot = findRepoRoot(editor.document.uri.fsPath);

      if (!repoRoot || !isChangeMarkdownFile(repoRoot, editor.document.uri.fsPath)) {
        void vscode.window.showInformationMessage('The active file is not inside openspec/changes/<change>/.');
        return;
      }

      const changeName = inferChangeNameFromPath(repoRoot, editor.document.uri.fsPath);

      if (!changeName) {
        void vscode.window.showErrorMessage('Unable to resolve the OpenSpec change for the active file.');
        return;
      }

      const diff = await generateChangeDiff(repoRoot, changeName);
      const document = await vscode.workspace.openTextDocument({
        content: formatChangeDiff(diff),
        language: 'diff',
      });

      await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),
  );
}

export function deactivate(): void {
  // No-op.
}

function findRepoRoot(filePath: string): string | null {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));

  if (workspaceFolder?.uri.fsPath && existsSync(path.join(workspaceFolder.uri.fsPath, 'openspec', 'changes'))) {
    return workspaceFolder.uri.fsPath;
  }

  let currentPath = path.dirname(filePath);

  while (true) {
    if (existsSync(path.join(currentPath, 'openspec', 'changes'))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);

    if (currentPath === parentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}
