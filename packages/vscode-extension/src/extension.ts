import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import {
  cleanupPaths,
  getChangeSpecContext,
  isChangeSpecPath,
  looksLikeDeltaSpec,
  prepareDiff,
  readSynthesizedContent,
  writeBufferWorkspace,
  writeManagedTempFile,
} from "./change-spec-diff.js";

let diffController: DiffController | undefined;

export function activate(context: vscode.ExtensionContext) {
  diffController = new DiffController(context.extensionPath);
  context.subscriptions.push(diffController);
}

export function deactivate() {
  diffController?.dispose();
  diffController = undefined;
}

class DiffController implements vscode.Disposable {
  private readonly sessions = new Map<string, DiffSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionPath: string) {
    this.disposables.push(
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
    const cleanupPromises: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      if (session.managedTempDir) {
        cleanupPromises.push(cleanupPaths([session.managedTempDir]));
      }
    }
    this.sessions.clear();
    void Promise.all(cleanupPromises);

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

    const session = await this.getOrCreateSession(uri);

    try {
      if (session.isDelta) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "Loading diff…" },
          () => this.refreshSession(session),
        );
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(session.mainSpecPath),
          vscode.Uri.file(session.managedTempFile!),
          session.title,
          { preview: false },
        );
      } else {
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(session.mainSpecPath),
          session.sourceUri,
          session.title,
          { preview: false },
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(toErrorMessage(error));
    }
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    if (uri.scheme !== "file") {
      return;
    }

    for (const session of this.getDeltaSessionsForUri(uri)) {
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
    if (!session.isDelta || !session.managedTempFile) {
      return;
    }

    session.version += 1;
    const version = session.version;

    const changeSpecContent = this.openDocumentText(session.sourceUri)
      ?? await readFile(session.sourceUri.fsPath, "utf8");
    const mainSpecContent = this.openDocumentText(
      vscode.Uri.file(session.mainSpecPath),
    ) ?? await readFileIfExists(session.mainSpecPath);

    const context = getChangeSpecContextOrThrow(session.sourceUri.fsPath);
    const config = vscode.workspace.getConfiguration("openspecDiff");

    const bufferWorkspace = await writeBufferWorkspace({
      context,
      changeSpecContent,
      mainSpecContent,
    });

    const pathsToCleanup = [bufferWorkspace.tempRoot];

    try {
      const prepared = await prepareDiff({
        difftoolBin: this.resolveDifftoolBin(config),
        openspecBin: config.get<string>("openspecBin", "openspec"),
        mainSpecPath: bufferWorkspace.mainSpecPath,
        changeSpecPath: bufferWorkspace.changeSpecPath,
      });

      if (version !== session.version) {
        pathsToCleanup.push(path.dirname(prepared.right));
        return;
      }

      const synthesized = await readSynthesizedContent(prepared);
      pathsToCleanup.push(path.dirname(prepared.right));

      await writeManagedTempFile(session.managedTempFile, synthesized);
      session.title = diffTitle(context);
    } finally {
      await cleanupPaths(pathsToCleanup);
    }
  }

  private async getOrCreateSession(uri: vscode.Uri): Promise<DiffSession> {
    const key = uri.toString();
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const context = getChangeSpecContextOrThrow(uri.fsPath);
    const changeSpecContent = this.openDocumentText(uri)
      ?? await readFile(uri.fsPath, "utf8");
    const isDelta = looksLikeDeltaSpec(changeSpecContent);

    let managedTempDir: string | undefined;
    let managedTempFile: string | undefined;

    if (isDelta) {
      managedTempDir = await mkdtemp(
        path.join(os.tmpdir(), "openspec-diff-session-"),
      );
      managedTempFile = path.join(managedTempDir, "spec.md");
    }

    const session: DiffSession = {
      title: diffTitle(context),
      sourceUri: uri,
      mainSpecPath: context.mainSpecPath,
      isDelta,
      managedTempDir,
      managedTempFile,
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

  private getDeltaSessionsForUri(uri: vscode.Uri): DiffSession[] {
    const target = uri.toString();
    return [...this.sessions.values()].filter(
      (session) =>
        session.isDelta &&
        (session.sourceUri.toString() === target ||
          vscode.Uri.file(session.mainSpecPath).toString() === target),
    );
  }

  private resolveDifftoolBin(
    config: vscode.WorkspaceConfiguration,
  ): string {
    const override = config.get<string>("difftoolBin", "");
    if (override) {
      return override;
    }
    return path.join(this.extensionPath, "dist", "openspec-difftool");
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
  mainSpecPath: string;
  isDelta: boolean;
  managedTempDir?: string;
  managedTempFile?: string;
  version: number;
  timeout?: NodeJS.Timeout;
}

function diffTitle(context: { changeName: string; relativeSpecPath: string }): string {
  return `OpenSpec Diff: ${context.changeName} — ${context.relativeSpecPath}`;
}

function getChangeSpecContextOrThrow(changeSpecPath: string) {
  const context = getChangeSpecContext(changeSpecPath);
  if (!context) {
    throw new Error("Diff is only available for OpenSpec change spec files.");
  }
  return context;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
