import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const OPENSPEC_DIRECTORY = "openspec";
export const CHANGES_DIRECTORY = "changes";
export const SPECS_DIRECTORY = "specs";
export const SPEC_FILE_NAME = "spec.md";
export const TEMP_PROPOSAL_CONTENT = "# Temporary diff change\n";
export const TEMP_TASKS_CONTENT =
  "## Tasks\n- [x] Prepare a synthesized spec for diffing\n";

export const DELTA_MARKERS = [
  "## ADDED Requirements",
  "## MODIFIED Requirements",
  "## REMOVED Requirements",
  "## RENAMED Requirements",
] as const;

export interface ChangeSpecContext {
  repoRoot: string;
  changeName: string;
  relativeSpecPath: string;
  changeSpecPath: string;
  mainSpecPath: string;
}

export interface WriteArchiveWorkspaceFilesInput {
  tempRoot: string;
  context: ChangeSpecContext;
  changeSpecContent: string;
  mainContent: string;
}

export function getChangeSpecContext(
  specPath: string,
): ChangeSpecContext | undefined {
  const absolutePath = path.resolve(specPath);
  if (path.basename(absolutePath) !== SPEC_FILE_NAME) {
    return undefined;
  }

  let current = path.dirname(absolutePath);
  while (true) {
    if (path.basename(current) === SPECS_DIRECTORY) {
      const changeRoot = path.dirname(current);
      const changesRoot = path.dirname(changeRoot);
      const openspecRoot = path.dirname(changesRoot);
      const repoRoot = path.dirname(openspecRoot);

      if (
        path.basename(changesRoot) === CHANGES_DIRECTORY &&
        path.basename(openspecRoot) === OPENSPEC_DIRECTORY
      ) {
        const relativeSpecPath = path.relative(current, absolutePath);
        return {
          repoRoot,
          changeName: path.basename(changeRoot),
          relativeSpecPath,
          changeSpecPath: absolutePath,
          mainSpecPath: path.join(
            repoRoot,
            OPENSPEC_DIRECTORY,
            SPECS_DIRECTORY,
            relativeSpecPath,
          ),
        };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function looksLikeDeltaSpec(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return DELTA_MARKERS.some((marker) =>
    lines.some((line) => line.trim() === marker),
  );
}

export function getSynthesizedSpecPath(
  tempRoot: string,
  context: Pick<ChangeSpecContext, "relativeSpecPath">,
): string {
  return path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    SPECS_DIRECTORY,
    context.relativeSpecPath,
  );
}

export async function writeArchiveWorkspaceFiles({
  tempRoot,
  context,
  changeSpecContent,
  mainContent,
}: WriteArchiveWorkspaceFilesInput): Promise<void> {
  const tempChangeSpecPath = path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
    context.changeName,
    SPECS_DIRECTORY,
    context.relativeSpecPath,
  );
  await mkdir(path.dirname(tempChangeSpecPath), { recursive: true });
  await writeFile(tempChangeSpecPath, changeSpecContent, "utf8");

  if (mainContent.length > 0) {
    const tempMainSpecPath = getSynthesizedSpecPath(tempRoot, context);
    await mkdir(path.dirname(tempMainSpecPath), { recursive: true });
    await writeFile(tempMainSpecPath, mainContent, "utf8");
  }

  const tempChangeRoot = path.join(
    tempRoot,
    OPENSPEC_DIRECTORY,
    CHANGES_DIRECTORY,
    context.changeName,
  );
  await mkdir(tempChangeRoot, { recursive: true });
  await writeFile(
    path.join(tempChangeRoot, "proposal.md"),
    TEMP_PROPOSAL_CONTENT,
    "utf8",
  );
  await writeFile(
    path.join(tempChangeRoot, "tasks.md"),
    TEMP_TASKS_CONTENT,
    "utf8",
  );
}
