import * as vscode from "vscode";

import { getWelcomeMessage } from "./message.js";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "openspecDiff.hello",
    () => {
      void vscode.window.showInformationMessage(getWelcomeMessage());
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
