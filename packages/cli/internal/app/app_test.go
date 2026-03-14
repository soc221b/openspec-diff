package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunSelectsChangeAndInvokesGitDifftool(t *testing.T) {
	t.Parallel()

	repoRoot := t.TempDir()
	writeSpecFile(t, filepath.Join(repoRoot, "openspec", "specs", "capability-a", "spec.md"), "# main")
	writeSpecFile(t, filepath.Join(repoRoot, "openspec", "changes", "alpha", "specs", "capability-a", "spec.md"), "# alpha")
	writeSpecFile(t, filepath.Join(repoRoot, "openspec", "changes", "beta", "specs", "capability-a", "spec.md"), "# beta")

	var stdout bytes.Buffer
	var calls [][]string
	runErr := Run(
		context.Background(),
		strings.NewReader("2\n"),
		&stdout,
		filepath.Join(repoRoot, "openspec", "changes"),
		func(_ context.Context, dir string, name string, args ...string) error {
			call := append([]string{dir, name}, args...)
			calls = append(calls, call)
			return nil
		},
	)
	if runErr != nil {
		t.Fatalf("Run() error = %v", runErr)
	}

	if got := len(calls); got != 1 {
		t.Fatalf("len(calls) = %d, want 1", got)
	}

	expectedMain := filepath.Join(repoRoot, "openspec", "specs", "capability-a", "spec.md")
	expectedChange := filepath.Join(repoRoot, "openspec", "changes", "beta", "specs", "capability-a", "spec.md")
	if got, want := calls[0][0], repoRoot; got != want {
		t.Fatalf("run dir = %q, want %q", got, want)
	}
	if got, want := calls[0][1], "git"; got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
	if got, want := calls[0][2:], []string{"difftool", "--no-prompt", "--no-index", expectedMain, expectedChange}; !equalStrings(got, want) {
		t.Fatalf("args = %q, want %q", got, want)
	}
	if got := stdout.String(); !strings.Contains(got, "Select a change to diff:") || !strings.Contains(got, "1. alpha") || !strings.Contains(got, "2. beta") {
		t.Fatalf("stdout = %q, want prompt and sorted choices", got)
	}
}

func TestCollectSpecPairsWithMissingMainSpec(t *testing.T) {
	t.Parallel()

	repoRoot := t.TempDir()
	writeSpecFile(t, filepath.Join(repoRoot, "openspec", "changes", "example", "specs", "new-capability", "spec.md"), "# delta")

	pairs, err := collectSpecPairs(repoRoot, "example")
	if err != nil {
		t.Fatalf("collectSpecPairs() error = %v", err)
	}

	if got, want := len(pairs), 1; got != want {
		t.Fatalf("len(pairs) = %d, want %d", got, want)
	}
	if got, want := pairs[0].name, "new-capability/spec.md"; got != want {
		t.Fatalf("pairs[0].name = %q, want %q", got, want)
	}
	if pairs[0].mainPath != "" {
		t.Fatalf("pairs[0].mainPath = %q, want empty", pairs[0].mainPath)
	}
}

func writeSpecFile(t *testing.T, path string, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func equalStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
