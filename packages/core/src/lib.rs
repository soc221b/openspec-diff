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

    Ok(status.code().unwrap_or(2))
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
    let temp_root = create_temp_directory("openspec-diff-core")?;
    let temp_guard = TempPathGuard::new(temp_root.clone());

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
    write_minimal_change_files(&temp_change_root)?;

    let output = Command::new(openspec_command)
        .current_dir(&temp_root)
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("openspec archive exited with status {}", output.status)
        };
        return Err(format!(
            "failed to preprocess delta spec {}: {details}",
            context.change_spec_path.display()
        ));
    }

    let synthesized_spec_path = temp_root.join(context.main_spec_relative_path());
    if !synthesized_spec_path.exists() {
        return Err(format!(
            "failed to preprocess delta spec {}: archive did not produce {}",
            context.change_spec_path.display(),
            synthesized_spec_path.display()
        ));
    }

    guards.push(temp_guard);
    Ok(synthesized_spec_path)
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
    fs::write(change_root.join("proposal.md"), "# Temporary diff change\n").map_err(|error| {
        format!(
            "failed to write {}: {error}",
            change_root.join("proposal.md").display()
        )
    })?;
    fs::write(
        change_root.join("tasks.md"),
        "## Tasks\n- [x] Prepare a synthesized spec for diffing\n",
    )
    .map_err(|error| {
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
    use super::{ChangeSpecContext, change_spec_context, prepare_diff_inputs};
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn detects_change_spec_context() {
        let path = Path::new("/repo/openspec/changes/change-a/specs/capability-a/spec.md");

        let context = change_spec_context(path).expect("expected change spec context");

        assert_eq!(
            context,
            ChangeSpecContext {
                repo_root: PathBuf::from("/repo"),
                change_name: "change-a".to_owned(),
                relative_spec_path: PathBuf::from("capability-a/spec.md"),
                change_spec_path: PathBuf::from(
                    "/repo/openspec/changes/change-a/specs/capability-a/spec.md"
                ),
                main_spec_path: PathBuf::from("/repo/openspec/specs/capability-a/spec.md"),
            }
        );
    }

    #[test]
    fn uses_empty_placeholder_for_missing_non_change_inputs() {
        let prepared = prepare_diff_inputs(
            "/tmp/openspec-diff-core-missing-left/spec.md",
            "/tmp/openspec-diff-core-missing-right/spec.md",
            OsStr::new("openspec"),
        )
        .expect("expected placeholder inputs");

        assert!(prepared.left.exists());
        assert!(prepared.right.exists());
        assert_eq!(fs::read_to_string(prepared.left).unwrap(), "");
        assert_eq!(fs::read_to_string(prepared.right).unwrap(), "");
    }

    #[test]
    fn archives_delta_specs_before_diffing() {
        let repo_root = create_test_directory("archive-delta");
        let main_spec_path = repo_root.join("openspec/specs/capability-a/spec.md");
        let change_spec_path =
            repo_root.join("openspec/changes/change-a/specs/capability-a/spec.md");
        let fake_openspec_path = repo_root.join("mock-bin/openspec");

        write_file(
            &main_spec_path,
            "# Capability A\n\n## Requirements\n\n### Requirement: Existing\nThe original behavior.\n",
        );
        write_file(
            &change_spec_path,
            "# Capability A\n\n## MODIFIED Requirements\n\n### Requirement: Existing\nThe archived behavior.\n",
        );
        write_fake_openspec(&fake_openspec_path);

        let prepared = prepare_diff_inputs(
            change_spec_path.to_str().unwrap(),
            main_spec_path.to_str().unwrap(),
            fake_openspec_path.as_os_str(),
        )
        .expect("expected archived delta output");

        assert_eq!(
            fs::read_to_string(prepared.left).unwrap(),
            "# Capability A\n\n## Requirements\n\n### Requirement: Existing\nThe archived behavior.\n"
        );
        assert_eq!(
            fs::read_to_string(prepared.right).unwrap(),
            "# Capability A\n\n## Requirements\n\n### Requirement: Existing\nThe original behavior.\n"
        );
    }

    fn create_test_directory(prefix: &str) -> PathBuf {
        super::create_temp_directory(&format!("openspec-diff-core-test-{prefix}")).unwrap()
    }

    fn write_file(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[cfg(unix)]
    fn write_fake_openspec(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        write_file(
            path,
            r##"#!/usr/bin/env python3
import pathlib
import sys

repo_root = pathlib.Path.cwd()
change_name = sys.argv[2]
change_spec = repo_root / "openspec" / "changes" / change_name / "specs" / "capability-a" / "spec.md"
output_spec = repo_root / "openspec" / "specs" / "capability-a" / "spec.md"
output_spec.parent.mkdir(parents=True, exist_ok=True)
output_spec.write_text("# Capability A\n\n## Requirements\n\n### Requirement: Existing\nThe archived behavior.\n", encoding="utf-8")
"##,
        );
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}
