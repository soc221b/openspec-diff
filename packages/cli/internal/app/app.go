package app

import (
	"context"
	"errors"
	"fmt"
	"io"
)

const (
	openspecDirectory = "openspec"
	changesDirectory  = "changes"
	specsDirectory    = "specs"
	specFileName      = "spec.md"
	// This is the count of fixed UI lines outside the changes list that must be
	// included when moving the cursor back up to redraw the prompt: the question
	// line, the blank spacer line, and the navigation hint line.
	promptOverhead = 3
)

var errNoChanges = errors.New("no active changes found")
var errNoSelection = errors.New("no change selected")
var errNoSpecSelection = errors.New("no spec selected")

type CommandRunner func(ctx context.Context, dir string, name string, args ...string) error

type specPair struct {
	name       string
	selector   string
	changePath string
	mainPath   string
}

func Run(ctx context.Context, stdin io.Reader, stdout io.Writer, workDir string, changeName string, specName string, run CommandRunner) error {
	repoRoot, err := findRepoRoot(workDir)
	if err != nil {
		return err
	}

	selectedChange, err := selectChangeName(stdin, stdout, repoRoot, changeName)
	if err != nil {
		return err
	}
	if selectedChange == "" {
		return nil
	}

	selectedSpecPairs, err := loadSelectedSpecPairs(stdin, stdout, repoRoot, selectedChange, specName)
	if err != nil {
		return err
	}
	if len(selectedSpecPairs) == 0 {
		return nil
	}

	return diffSelectedSpecPairs(ctx, stdout, repoRoot, selectedSpecPairs, run)
}

func selectChangeName(stdin io.Reader, stdout io.Writer, repoRoot string, changeName string) (string, error) {
	changes, err := listChanges(repoRoot)
	if err != nil {
		if errors.Is(err, errNoChanges) {
			_, _ = fmt.Fprintln(stdout, "No active changes found.")
			_, _ = fmt.Fprintln(stdout, "No change selected. Aborting.")
			return "", nil
		}
		return "", err
	}

	selectedChange, err := selectRequestedChange(stdin, stdout, changes, changeName)
	if err != nil {
		if errors.Is(err, errNoSelection) {
			_, _ = fmt.Fprintln(stdout, "No change selected. Aborting.")
			return "", nil
		}
		return "", err
	}

	return selectedChange, nil
}

func loadSelectedSpecPairs(stdin io.Reader, stdout io.Writer, repoRoot string, changeName string, specName string) ([]specPair, error) {
	specPairs, err := collectSpecPairs(repoRoot, changeName)
	if err != nil {
		return nil, err
	}
	if len(specPairs) == 0 {
		_, _ = fmt.Fprintf(stdout, "No spec files found for change %q.\n", changeName)
		return nil, nil
	}

	selectedSpecPairs, err := selectRequestedSpec(stdin, stdout, specPairs, specName)
	if err != nil {
		if errors.Is(err, errNoSpecSelection) {
			return nil, nil
		}
		return nil, err
	}

	return selectedSpecPairs, nil
}

func diffSelectedSpecPairs(ctx context.Context, stdout io.Writer, repoRoot string, specPairs []specPair, run CommandRunner) error {
	for _, pair := range specPairs {
		mainPath := pair.mainPath
		cleanup := func() error { return nil }
		if mainPath == "" {
			var err error
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
