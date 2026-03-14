export interface ChangeSummary {
    name: string;
    path: string;
    markdownFileCount: number;
}
export interface ChangeFileDiff {
    kind: 'artifact' | 'delta-spec';
    relativePath: string;
    previousPath: string | null;
    currentPath: string;
    diff: string[];
}
export interface ChangeDiffResult {
    change: ChangeSummary;
    files: ChangeFileDiff[];
}
export declare function findChanges(repoRoot: string): Promise<ChangeSummary[]>;
export declare function isChangeMarkdownFile(repoRoot: string, filePath: string): boolean;
export declare function inferChangeNameFromPath(repoRoot: string, filePath: string): string | null;
export declare function generateChangeDiff(repoRoot: string, changeName: string): Promise<ChangeDiffResult>;
export declare function formatChangeDiff(result: ChangeDiffResult): string;
//# sourceMappingURL=index.d.ts.map