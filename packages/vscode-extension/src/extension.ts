import * as vscode from "vscode";

import { getWelcomeMessage } from "./message.js";

let helloCommand: vscode.Disposable | undefined;

export function activate(_context: vscode.ExtensionContext) {
  helloCommand = vscode.commands.registerCommand("openspecDiff.hello", () => {
    void vscode.window.showInformationMessage(getWelcomeMessage());
  });
}

export function deactivate() {
  helloCommand?.dispose();
  helloCommand = undefined;
}
