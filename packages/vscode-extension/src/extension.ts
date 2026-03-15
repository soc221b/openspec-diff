import * as vscode from "vscode";

import {
  createDiffDocumentUri,
  DIFF_SCHEME,
  getChangeSpecContext,
  isChangeSpecPath,
  loadDiffSnapshot,
} from "./change-spec-diff.js";

let diffController: DiffController | undefined;

export function activate(context: vscode.ExtensionContext) {
  diffController = new DiffController();
  context.subscriptions.push(diffController);
}

export function deactivate() {
  diffController?.dispose();
  diffController = undefined;
}

class DiffController implements vscode.Disposable {
  private readonly contentProvider = new DiffContentProvider();
  private readonly sessions = new Map<string, DiffSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        DIFF_SCHEME,
        this.contentProvider,
      ),
      vscode.languages.registerCodeLensProvider(
        { scheme: "file", pattern: "**/openspec/changes/*/specs/**/spec.md" },
        new DiffCodeLensProvider(),
      ),
      vscode.commands.registerCommand(
        "openspecDiff.openDiff",
        async (uri?: vscode.Uri) => {
          await this.openDiff(
            uri ?? vscode.window.activeTextEditor?.document.uri,
          );
        },
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.scheduleRefreshForDocument(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.scheduleRefreshForDocument(document);
      }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/openspec/{changes/*/specs,specs}/**/spec.md",
    );
    watcher.onDidChange((uri) => this.scheduleRefresh(uri));
    watcher.onDidCreate((uri) => this.scheduleRefresh(uri));
    watcher.onDidDelete((uri) => this.scheduleRefresh(uri));
    this.disposables.push(watcher);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
    }
    this.sessions.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async openDiff(uri?: vscode.Uri): Promise<void> {
    if (!uri || !isChangeSpecPath(uri.fsPath)) {
      await vscode.window.showErrorMessage(
        "Diff is only available for OpenSpec change spec files.",
      );
      return;
    }

    const session = this.getOrCreateSession(uri);

    try {
      await this.refreshSession(session);
      await vscode.commands.executeCommand(
        "vscode.diff",
        session.leftUri,
        session.rightUri,
        session.title,
        { preview: false },
      );
    } catch (error) {
      await vscode.window.showErrorMessage(toErrorMessage(error));
    }
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    if (uri.scheme !== "file") {
      return;
    }

    for (const session of this.getSessionsForUri(uri)) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }

      session.timeout = setTimeout(() => {
        void this.refreshSession(session).catch(async (error) => {
          await vscode.window.showErrorMessage(toErrorMessage(error));
        });
      }, 150);
    }
  }

  private async refreshSession(session: DiffSession): Promise<void> {
    session.version += 1;
    const version = session.version;
    const snapshot = await loadDiffSnapshot(session.sourceUri.fsPath, {
      changeSpecContent: this.openDocumentText(session.sourceUri),
      mainSpecContent: this.openDocumentText(session.mainSpecUri),
    });

    if (version !== session.version) {
      return;
    }

    session.title = snapshot.title;
    this.contentProvider.update(session.leftUri, snapshot.mainContent);
    this.contentProvider.update(session.rightUri, snapshot.changeContent);
  }

  private getOrCreateSession(uri: vscode.Uri): DiffSession {
    const key = uri.toString();
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const source = uri.toString();
    const changeSpecContext = getChangeSpecContextOrThrow(uri.fsPath);
    const session: DiffSession = {
      title: "OpenSpec Diff",
      sourceUri: uri,
      mainSpecUri: vscode.Uri.file(changeSpecContext.mainSpecPath),
      leftUri: vscode.Uri.parse(createDiffDocumentUri(source, "main")),
      rightUri: vscode.Uri.parse(createDiffDocumentUri(source, "change")),
      version: 0,
    };
    this.sessions.set(key, session);
    return session;
  }

  private openDocumentText(uri: vscode.Uri): string | undefined {
    return vscode.workspace.textDocuments
      .find((document) => document.uri.toString() === uri.toString())
      ?.getText();
  }

  private scheduleRefreshForDocument(document: vscode.TextDocument): void {
    this.scheduleRefresh(document.uri);
  }

  private getSessionsForUri(uri: vscode.Uri): DiffSession[] {
    const target = uri.toString();
    return [...this.sessions.values()].filter(
      (session) =>
        session.sourceUri.toString() === target ||
        session.mainSpecUri.toString() === target,
    );
  }
}

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "";
  }

  update(uri: vscode.Uri, content: string): void {
    this.documents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }
}

class DiffCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isChangeSpecPath(document.uri.fsPath)) {
      return [];
    }

    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: "Diff",
        command: "openspecDiff.openDiff",
        arguments: [document.uri],
      }),
    ];
  }
}

interface DiffSession {
  title: string;
  sourceUri: vscode.Uri;
  mainSpecUri: vscode.Uri;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  version: number;
  timeout?: NodeJS.Timeout;
}

function getChangeSpecContextOrThrow(changeSpecPath: string) {
  const context = getChangeSpecContext(changeSpecPath);
  if (!context) {
    throw new Error("Diff is only available for OpenSpec change spec files.");
  }
  return context;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
