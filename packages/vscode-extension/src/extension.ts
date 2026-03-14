import * as vscode from "vscode";

import { getWelcomeMessage } from "./message.js";

let helloCommand: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
  helloCommand?.dispose();

  helloCommand = vscode.commands.registerCommand("openspecDiff.hello", () => {
    void vscode.window.showInformationMessage(getWelcomeMessage());
  });

  context.subscriptions.push(helloCommand);
}

export function deactivate() {
  helloCommand?.dispose();
  helloCommand = undefined;
}
