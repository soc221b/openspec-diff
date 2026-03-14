package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	openspecDirectory = "openspec"
	changesDirectory  = "changes"
	specsDirectory    = "specs"
	specFileName      = "spec.md"
	// Add these prompt lines—"? Select a change to diff", the blank spacer line,
	// and "↑↓ navigate • ⏎ select"—to len(changes) when redrawing.
	promptOverhead    = 3
)

var errNoChanges = errors.New("no active changes found")
var errNoSelection = errors.New("no change selected")

type CommandRunner func(ctx context.Context, dir string, name string, args ...string) error

type specPair struct {
	name       string
	changePath string
	mainPath   string
}

func Run(ctx context.Context, stdin io.Reader, stdout io.Writer, workDir string, run CommandRunner) error {
	repoRoot, err := findRepoRoot(workDir)
	if err != nil {
		return err
	}

	changes, err := listChanges(repoRoot)
	if err != nil {
		if errors.Is(err, errNoChanges) {
			_, _ = fmt.Fprintln(stdout, "No active changes found.")
			_, _ = fmt.Fprintln(stdout, "No change selected. Aborting.")
			return nil
		}
		return err
	}

	selectedChange, err := selectChange(stdin, stdout, changes)
	if err != nil {
		if errors.Is(err, errNoSelection) {
			_, _ = fmt.Fprintln(stdout, "No change selected. Aborting.")
			return nil
		}
		return err
	}

	specPairs, err := collectSpecPairs(repoRoot, selectedChange)
	if err != nil {
		return err
	}
	if len(specPairs) == 0 {
		_, _ = fmt.Fprintf(stdout, "No spec files found for change %q.\n", selectedChange)
		return nil
	}

	for _, pair := range specPairs {
		mainPath := pair.mainPath
		cleanup := func() error { return nil }
		if mainPath == "" {
			mainPath, cleanup, err = createEmptySpecPlaceholder()
			if err != nil {
				return err
			}
		}

		_, _ = fmt.Fprintf(stdout, "Diffing %s\n", pair.name)
		runErr := run(ctx, repoRoot, "git", "difftool", "--no-prompt", "--no-index", mainPath, pair.changePath)
		cleanupErr := cleanup()
		if runErr != nil {
			return runErr
		}
		if cleanupErr != nil {
			return cleanupErr
		}
	}

	return nil
}

func findRepoRoot(startDir string) (string, error) {
	currentDir, err := filepath.Abs(startDir)
	if err != nil {
		return "", err
	}

	for {
		changesPath := filepath.Join(currentDir, openspecDirectory, changesDirectory)
		specsPath := filepath.Join(currentDir, openspecDirectory, specsDirectory)
		if isDirectory(changesPath) && isDirectory(specsPath) {
			return currentDir, nil
		}

		parentDir := filepath.Dir(currentDir)
		if parentDir == currentDir {
			return "", errors.New("could not find openspec/changes and openspec/specs directories in the current path or any parent directory")
		}
		currentDir = parentDir
	}
}

func listChanges(repoRoot string) ([]string, error) {
	changesPath := filepath.Join(repoRoot, openspecDirectory, changesDirectory)
	entries, err := os.ReadDir(changesPath)
	if err != nil {
		return nil, err
	}

	changes := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if entry.Name() == "archive" || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		changes = append(changes, entry.Name())
	}

	sort.Strings(changes)
	if len(changes) == 0 {
		return nil, errNoChanges
	}

	return changes, nil
}

func selectChange(stdin io.Reader, stdout io.Writer, changes []string) (string, error) {
	reader := bufio.NewReader(stdin)
	selectedIndex := 0
	typedSelection := strings.Builder{}
	rendered := false

	renderPrompt := func() {
		if rendered {
			_, _ = fmt.Fprintf(stdout, "\x1b[%dA\x1b[J", len(changes)+promptOverhead)
		}

		_, _ = fmt.Fprintln(stdout, "? Select a change to diff")
		for index, change := range changes {
			prefix := " "
			if index == selectedIndex {
				prefix = "❯"
			}
			_, _ = fmt.Fprintf(stdout, "%s %s\n", prefix, change)
		}
		_, _ = fmt.Fprintln(stdout)
		_, _ = fmt.Fprintln(stdout, "↑↓ navigate • ⏎ select")
		rendered = true
	}

	renderPrompt()

	for {
		input, err := reader.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), true)
			}
			return "", err
		}

		switch input {
		case '\r', '\n':
			return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), false)
		case '\x1b':
			next, err := reader.ReadByte()
			if err != nil {
				if errors.Is(err, io.EOF) {
					return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), true)
				}
				return "", err
			}
			if next != '[' {
				typedSelection.WriteByte(input)
				typedSelection.WriteByte(next)
				continue
			}

			direction, err := reader.ReadByte()
			if err != nil {
				if errors.Is(err, io.EOF) {
					return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), true)
				}
				return "", err
			}

			switch direction {
			case 'A':
				if selectedIndex > 0 {
					selectedIndex--
				}
				renderPrompt()
			case 'B':
				if selectedIndex < len(changes)-1 {
					selectedIndex++
				}
				renderPrompt()
			default:
				typedSelection.WriteByte(input)
				typedSelection.WriteByte(next)
				typedSelection.WriteByte(direction)
			}
		default:
			typedSelection.WriteByte(input)
		}
	}
}

func resolveSelection(stdout io.Writer, changes []string, selectedIndex int, rawSelection string, eof bool) (string, error) {
	selection := strings.TrimSpace(rawSelection)
	if selection == "" {
		if eof {
			return "", errNoSelection
		}

		selected := changes[selectedIndex]
		_, _ = fmt.Fprintf(stdout, "✔ Select a change to diff %s\n\n", selected)
		return selected, nil
	}

	if index, err := strconv.Atoi(selection); err == nil {
		if index < 1 || index > len(changes) {
			return "", fmt.Errorf("selection %d is out of range", index)
		}
		selected := changes[index-1]
		_, _ = fmt.Fprintf(stdout, "✔ Select a change to diff %s\n\n", selected)
		return selected, nil
	}

	for _, change := range changes {
		if change == selection {
			_, _ = fmt.Fprintf(stdout, "✔ Select a change to diff %s\n\n", change)
			return change, nil
		}
	}

	return "", fmt.Errorf("unknown change %q", selection)
}

func collectSpecPairs(repoRoot, change string) ([]specPair, error) {
	changeSpecsPath := filepath.Join(repoRoot, openspecDirectory, changesDirectory, change, specsDirectory)
	if !isDirectory(changeSpecsPath) {
		return nil, nil
	}

	pairs := make([]specPair, 0)
	err := filepath.WalkDir(changeSpecsPath, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() != specFileName {
			return nil
		}

		relativePath, err := filepath.Rel(changeSpecsPath, path)
		if err != nil {
			return err
		}

		mainPath := filepath.Join(repoRoot, openspecDirectory, specsDirectory, relativePath)
		if _, err := os.Stat(mainPath); errors.Is(err, os.ErrNotExist) {
			mainPath = ""
		} else if err != nil {
			return err
		}

		pairs = append(pairs, specPair{
			name:       filepath.ToSlash(relativePath),
			changePath: path,
			mainPath:   mainPath,
		})

		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].name < pairs[j].name
	})

	return pairs, nil
}

func createEmptySpecPlaceholder() (string, func() error, error) {
	file, err := os.CreateTemp("", "openspec-diff-empty-spec-*.md")
	if err != nil {
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(file.Name())
		return "", nil, err
	}

	return file.Name(), func() error {
		return os.Remove(file.Name())
	}, nil
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
