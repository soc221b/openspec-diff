use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const OPENSPEC_DIRECTORY: &str = "openspec";
const CHANGES_DIRECTORY: &str = "changes";
const SPECS_DIRECTORY: &str = "specs";
const SPEC_FILE_NAME: &str = "spec.md";
const TEMP_PROPOSAL_CONTENT: &str = "# Temporary diff change\n";
const TEMP_TASKS_CONTENT: &str = "## Tasks\n- [x] Prepare a synthesized spec for diffing\n";
/// Markers used to detect OpenSpec delta specs that must be archived before diffing.
const DELTA_MARKERS: [&str; 4] = [
    "## ADDED Requirements",
    "## MODIFIED Requirements",
    "## REMOVED Requirements",
    "## RENAMED Requirements",
];

static TEMP_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn diff(uri1: &str, uri2: &str) -> Result<i32, String> {
    diff_with_openspec_command(uri1, uri2, OsStr::new("openspec"))
}

pub fn diff_with_openspec_command(
    uri1: &str,
    uri2: &str,
    openspec_command: &OsStr,
) -> Result<i32, String> {
    let prepared = prepare_diff_inputs(uri1, uri2, openspec_command)?;
    let status = Command::new("git")
        .args(["difftool", "--no-prompt", "--no-index"])
        .arg(&prepared.left)
        .arg(&prepared.right)
        .status()
        .map_err(|error| format!("failed to run git difftool: {error}"))?;

    Ok(normalize_diff_exit_code(status.code()))
}

fn normalize_diff_exit_code(code: Option<i32>) -> i32 {
    match code {
        Some(1) => 0,
        Some(code) => code,
        None => 2,
    }
}

struct PreparedDiff {
    left: PathBuf,
    right: PathBuf,
    _guards: Vec<TempPathGuard>,
}

fn prepare_diff_inputs(
    uri1: &str,
    uri2: &str,
    openspec_command: &OsStr,
) -> Result<PreparedDiff, String> {
    let mut guards = Vec::new();
    let left = prepare_diff_input(Path::new(uri1), openspec_command, &mut guards)?;
    let right = prepare_diff_input(Path::new(uri2), openspec_command, &mut guards)?;

    Ok(PreparedDiff {
        left,
        right,
        _guards: guards,
    })
}

fn prepare_diff_input(
    uri: &Path,
    openspec_command: &OsStr,
    guards: &mut Vec<TempPathGuard>,
) -> Result<PathBuf, String> {
    let absolute_path = absolute_path(uri)?;
    let context = match change_spec_context(&absolute_path) {
        Some(context) => context,
        None => {
            if absolute_path.exists() {
                return Ok(absolute_path);
            }
            return create_empty_placeholder(guards);
        }
    };

    if !looks_like_delta_spec(&context.change_spec_path)? {
        return Ok(context.change_spec_path);
    }

    preprocess_change_spec(&context, openspec_command, guards)
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    std::env::current_dir()
        .map(|current_dir| current_dir.join(path))
        .map_err(|error| {
            format!(
                "failed to resolve absolute path for {}: {error}",
                path.display()
            )
        })
}

fn looks_like_delta_spec(path: &Path) -> Result<bool, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read change spec {}: {error}", path.display()))?;

    Ok(DELTA_MARKERS
        .iter()
        .any(|marker| content.lines().any(|line| line.trim() == *marker)))
}

fn preprocess_change_spec(
    context: &ChangeSpecContext,
    openspec_command: &OsStr,
    guards: &mut Vec<TempPathGuard>,
) -> Result<PathBuf, String> {
    let temp_root = create_temp_directory("openspec-difftool")?;
    let temp_guard = TempPathGuard::new(temp_root.clone());
    let synthesized_spec_path = temp_root.join(context.main_spec_relative_path());

    prepare_temp_change_workspace(context, &temp_root)?;
    let archive_output = run_archive_command(context, openspec_command, &temp_root)?;
    validate_archive_output(context.change_spec_path.as_path(), &archive_output)?;
    ensure_synthesized_spec_exists(context.change_spec_path.as_path(), &synthesized_spec_path)?;

    guards.push(temp_guard);
    Ok(synthesized_spec_path)
}

fn prepare_temp_change_workspace(
    context: &ChangeSpecContext,
    temp_root: &Path,
) -> Result<(), String> {
    let temp_change_spec_path = temp_root.join(context.change_spec_relative_path());
    copy_file(&context.change_spec_path, &temp_change_spec_path)?;

    if context.main_spec_path.exists() {
        let temp_main_spec_path = temp_root.join(context.main_spec_relative_path());
        copy_file(&context.main_spec_path, &temp_main_spec_path)?;
    }

    let temp_change_root = temp_root
        .join(OPENSPEC_DIRECTORY)
        .join(CHANGES_DIRECTORY)
        .join(&context.change_name);
    write_minimal_change_files(&temp_change_root)
}

fn run_archive_command(
    context: &ChangeSpecContext,
    openspec_command: &OsStr,
    temp_root: &Path,
) -> Result<ArchiveCommandOutput, String> {
    let output = Command::new(openspec_command)
        .current_dir(temp_root)
        .arg("archive")
        .arg(&context.change_name)
        .arg("--yes")
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "failed to preprocess delta spec {}: openspec command not found",
                    context.change_spec_path.display()
                )
            } else {
                format!(
                    "failed to preprocess delta spec {}: {error}",
                    context.change_spec_path.display()
                )
            }
        })?;

    Ok(ArchiveCommandOutput::from_process_output(output))
}

fn validate_archive_output(
    change_spec_path: &Path,
    output: &ArchiveCommandOutput,
) -> Result<(), String> {
    if !output.status.success() {
        return Err(format!(
            "failed to preprocess delta spec {}: {}",
            change_spec_path.display(),
            output.details(&format!(
                "openspec archive exited with status {}",
                output.status
            ))
        ));
    }

    if output.aborted_without_writing() {
        return Err(format!(
            "failed to preprocess delta spec {}: {}",
            change_spec_path.display(),
            output.details("openspec archive aborted: no files were changed")
        ));
    }

    Ok(())
}

fn ensure_synthesized_spec_exists(
    change_spec_path: &Path,
    synthesized_spec_path: &Path,
) -> Result<(), String> {
    if synthesized_spec_path.exists() {
        return Ok(());
    }

    Err(format!(
        "failed to preprocess delta spec {}: archive did not produce {}",
        change_spec_path.display(),
        synthesized_spec_path.display()
    ))
}

struct ArchiveCommandOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

impl ArchiveCommandOutput {
    fn from_process_output(output: std::process::Output) -> Self {
        Self {
            status: output.status,
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        }
    }

    fn aborted_without_writing(&self) -> bool {
        let aborted_marker = "Aborted. No files were changed.";

        self.stdout.contains(aborted_marker) || self.stderr.contains(aborted_marker)
    }

    fn details(&self, fallback: &str) -> String {
        if !self.stderr.is_empty() {
            self.stderr.clone()
        } else if !self.stdout.is_empty() {
            self.stdout.clone()
        } else {
            fallback.to_owned()
        }
    }
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    fs::copy(source, target).map_err(|error| {
        format!(
            "failed to copy {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;

    Ok(())
}

fn write_minimal_change_files(change_root: &Path) -> Result<(), String> {
    fs::create_dir_all(change_root)
        .map_err(|error| format!("failed to create {}: {error}", change_root.display()))?;
    fs::write(change_root.join("proposal.md"), TEMP_PROPOSAL_CONTENT).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            change_root.join("proposal.md").display()
        )
    })?;
    fs::write(change_root.join("tasks.md"), TEMP_TASKS_CONTENT).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            change_root.join("tasks.md").display()
        )
    })?;

    Ok(())
}

fn create_empty_placeholder(guards: &mut Vec<TempPathGuard>) -> Result<PathBuf, String> {
    let temp_root = create_temp_directory("openspec-diff-empty")?;
    let placeholder_path = temp_root.join(SPEC_FILE_NAME);
    fs::write(&placeholder_path, "")
        .map_err(|error| format!("failed to create {}: {error}", placeholder_path.display()))?;
    guards.push(TempPathGuard::new(temp_root));
    Ok(placeholder_path)
}

fn create_temp_directory(prefix: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("failed to read system time: {error}"))?
        .as_nanos();
    let suffix = TEMP_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_root = std::env::temp_dir().join(format!("{prefix}-{timestamp}-{suffix}"));

    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("failed to create {}: {error}", temp_root.display()))?;

    Ok(temp_root)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChangeSpecContext {
    repo_root: PathBuf,
    change_name: String,
    relative_spec_path: PathBuf,
    change_spec_path: PathBuf,
    main_spec_path: PathBuf,
}

impl ChangeSpecContext {
    fn change_spec_relative_path(&self) -> PathBuf {
        Path::new(OPENSPEC_DIRECTORY)
            .join(CHANGES_DIRECTORY)
            .join(&self.change_name)
            .join(SPECS_DIRECTORY)
            .join(&self.relative_spec_path)
    }

    fn main_spec_relative_path(&self) -> PathBuf {
        Path::new(OPENSPEC_DIRECTORY)
            .join(SPECS_DIRECTORY)
            .join(&self.relative_spec_path)
    }
}

fn change_spec_context(path: &Path) -> Option<ChangeSpecContext> {
    if path.file_name()? != OsStr::new(SPEC_FILE_NAME) {
        return None;
    }

    for ancestor in path.ancestors() {
        if ancestor.file_name()? != OsStr::new(SPECS_DIRECTORY) {
            continue;
        }

        let change_root = ancestor.parent()?;
        let changes_root = change_root.parent()?;
        let openspec_root = changes_root.parent()?;
        let repo_root = openspec_root.parent()?;

        if changes_root.file_name()? != OsStr::new(CHANGES_DIRECTORY)
            || openspec_root.file_name()? != OsStr::new(OPENSPEC_DIRECTORY)
        {
            continue;
        }

        let relative_spec_path = path.strip_prefix(ancestor).ok()?.to_path_buf();
        let change_name = change_root.file_name()?.to_string_lossy().into_owned();
        let main_spec_path = repo_root
            .join(OPENSPEC_DIRECTORY)
            .join(SPECS_DIRECTORY)
            .join(&relative_spec_path);

        return Some(ChangeSpecContext {
            repo_root: repo_root.to_path_buf(),
            change_name,
            relative_spec_path,
            change_spec_path: path.to_path_buf(),
            main_spec_path,
        });
    }

    None
}

struct TempPathGuard {
    path: PathBuf,
}

impl TempPathGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempPathGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::ArchiveCommandOutput;
    use std::process::{ExitStatus, Output};

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: u32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code)
    }

    fn archive_output(status: ExitStatus, stdout: &[u8], stderr: &[u8]) -> ArchiveCommandOutput {
        ArchiveCommandOutput::from_process_output(Output {
            status,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        })
    }

    #[test]
    fn archive_output_prefers_stderr_details() {
        let output = archive_output(exit_status(1), b"stdout detail", b"stderr detail");

        assert_eq!(output.details("fallback"), "stderr detail");
    }

    #[test]
    fn archive_output_detects_aborted_archive_marker() {
        let output = archive_output(exit_status(0), b"Aborted. No files were changed.", b"");

        assert!(output.aborted_without_writing());
    }
}
