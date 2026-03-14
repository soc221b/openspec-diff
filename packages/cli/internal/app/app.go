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
	"strings"

	"github.com/burl/inquire"
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

// navigationAction represents an ANSI arrow-key direction code.
type navigationAction byte

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

	changes, err := listChanges(repoRoot)
	if err != nil {
		if errors.Is(err, errNoChanges) {
			_, _ = fmt.Fprintln(stdout, "No active changes found.")
			_, _ = fmt.Fprintln(stdout, "No change selected. Aborting.")
			return nil
		}
		return err
	}

	selectedChange, err := selectRequestedChange(stdin, stdout, changes, changeName)
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

	selectedSpecPairs, err := selectRequestedSpec(stdin, stdout, specPairs, specName)
	if err != nil {
		if errors.Is(err, errNoSpecSelection) {
			return nil
		}
		return err
	}
	if len(selectedSpecPairs) == 0 {
		return nil
	}

	for _, pair := range selectedSpecPairs {
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

func selectRequestedChange(stdin io.Reader, stdout io.Writer, changes []string, changeName string) (string, error) {
	if strings.TrimSpace(changeName) != "" {
		return resolveExactChange(changes, changeName)
	}

	return selectChange(stdin, stdout, changes)
}

func selectChange(stdin io.Reader, stdout io.Writer, changes []string) (string, error) {
	rendered := false

	renderPrompt := func(selectedIndex int) {
		if rendered {
			// Move the cursor back to the top of the prompt and clear it before
			// redrawing with the updated selection marker.
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

	return runInteractivePrompt(
		stdin,
		len(changes),
		renderPrompt,
		func(selectedIndex int, rawSelection string, eof bool) (string, error) {
			return resolveSelection(stdout, changes, selectedIndex, rawSelection, eof)
		},
		nil,
	)
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

	change, err := resolveExactChange(changes, selection)
	if err != nil {
		return "", err
	}

	_, _ = fmt.Fprintf(stdout, "✔ Select a change to diff %s\n\n", change)
	return change, nil
}

func resolveExactChange(changes []string, rawSelection string) (string, error) {
	selection := strings.TrimSpace(rawSelection)
	for _, change := range changes {
		if change == selection {
			return change, nil
		}
	}

	return "", fmt.Errorf("Change '%s' not found.", selection)
}

func selectRequestedSpec(stdin io.Reader, stdout io.Writer, specPairs []specPair, specName string) ([]specPair, error) {
	selections := parseSpecSelections(specName)
	if len(selections) > 0 {
		return filterSpecPairs(specPairs, selections)
	}
	if len(specPairs) <= 1 {
		return specPairs, nil
	}

	specs := make([]string, 0, len(specPairs))
	for _, pair := range specPairs {
		specs = append(specs, pair.selector)
	}
	selectedSpecs, err := selectSpecs(stdin, stdout, specs)
	if err != nil {
		return nil, err
	}
	return filterSpecPairs(specPairs, selectedSpecs)
}

func selectSpecs(stdin io.Reader, stdout io.Writer, specs []string) ([]string, error) {
	if canUseInquire(stdin, stdout) {
		return selectSpecsWithInquire(specs)
	}

	selected := make([]bool, len(specs))
	rendered := false

	renderPrompt := func(selectedIndex int) {
		if rendered {
			_, _ = fmt.Fprintf(stdout, "\x1b[%dA\x1b[J", len(specs)+promptOverhead)
		}

		_, _ = fmt.Fprintln(stdout, "? Select specs to diff")
		for index, spec := range specs {
			prefix := " "
			if index == selectedIndex {
				prefix = "❯"
			}
			marker := "◯"
			if selected[index] {
				marker = "◉"
			}
			_, _ = fmt.Fprintf(stdout, "%s %s %s\n", prefix, marker, spec)
		}
		_, _ = fmt.Fprintln(stdout)
		_, _ = fmt.Fprintln(stdout, "↑↓ navigate • space toggle • ⏎ submit")
		rendered = true
	}

	return runInteractivePrompt(
		stdin,
		len(specs),
		renderPrompt,
		func(selectedIndex int, rawSelection string, eof bool) ([]string, error) {
			return resolveSpecSelections(stdout, specs, selected, rawSelection, eof)
		},
		func(input byte, selectedIndex int) (bool, bool) {
			if input != ' ' {
				return false, false
			}

			selected[selectedIndex] = !selected[selectedIndex]
			return true, true
		},
	)
}

func runInteractivePrompt[T any](
	stdin io.Reader,
	optionCount int,
	renderPrompt func(selectedIndex int),
	resolve func(selectedIndex int, rawSelection string, eof bool) (T, error),
	handleInput func(input byte, selectedIndex int) (handled bool, rerender bool),
) (T, error) {
	reader := bufio.NewReader(stdin)
	selectedIndex := 0
	typedSelection := strings.Builder{}
	renderPrompt(selectedIndex)

	for {
		input, err := reader.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return resolve(selectedIndex, typedSelection.String(), true)
			}
			var zero T
			return zero, err
		}

		switch input {
		case '\r', '\n':
			return resolve(selectedIndex, typedSelection.String(), false)
		case '\x1b':
			action, rawInput, err := readNavigationAction(reader)
			if err != nil {
				if errors.Is(err, io.EOF) {
					return resolve(selectedIndex, typedSelection.String(), true)
				}
				var zero T
				return zero, err
			}
			if action == 0 {
				typedSelection.WriteString(rawInput)
				continue
			}

			selectedIndex = navigateSelection(selectedIndex, optionCount, action)
			renderPrompt(selectedIndex)
		default:
			if handleInput != nil {
				handled, rerender := handleInput(input, selectedIndex)
				if handled {
					if rerender {
						renderPrompt(selectedIndex)
					}
					continue
				}
			}
			typedSelection.WriteByte(input)
		}
	}
}

// readNavigationAction parses an ANSI escape sequence and returns the matching
// arrow-key action, or the raw bytes when the sequence should be treated as
// typed input instead.
func readNavigationAction(reader *bufio.Reader) (navigationAction, string, error) {
	next, err := reader.ReadByte()
	if err != nil {
		return 0, "", err
	}
	if next != '[' {
		return 0, string([]byte{'\x1b', next}), nil
	}

	direction, err := reader.ReadByte()
	if err != nil {
		return 0, "", err
	}

	switch direction {
	case 'A':
		return navigationAction(direction), "", nil
	case 'B':
		return navigationAction(direction), "", nil
	default:
		return 0, string([]byte{'\x1b', next, direction}), nil
	}
}

// navigateSelection applies an arrow-key action while keeping the selection
// index within the available option range.
func navigateSelection(selectedIndex, optionCount int, action navigationAction) int {
	switch action {
	case 'A':
		if selectedIndex > 0 {
			return selectedIndex - 1
		}
	case 'B':
		if selectedIndex < optionCount-1 {
			return selectedIndex + 1
		}
	}

	return selectedIndex
}

func resolveSpecSelections(stdout io.Writer, specs []string, selected []bool, rawSelection string, eof bool) ([]string, error) {
	selection := parseSpecSelections(rawSelection)
	if len(selection) == 0 {
		selectedSpecs := selectedSpecNames(specs, selected)
		if len(selectedSpecs) == 0 {
			return nil, nil
		}
		_, _ = fmt.Fprintf(stdout, "✔ Select specs to diff %s\n\n", strings.Join(selectedSpecs, ", "))
		return selectedSpecs, nil
	}

	selectedSpecs, err := validateSpecSelections(specs, selection)
	if err != nil {
		return nil, err
	}

	_, _ = fmt.Fprintf(stdout, "✔ Select specs to diff %s\n\n", strings.Join(selectedSpecs, ", "))
	return selectedSpecs, nil
}

func filterSpecPairs(specPairs []specPair, selections []string) ([]specPair, error) {
	selectedSpecs, err := validateSpecSelections(specSelectors(specPairs), selections)
	if err != nil {
		return nil, err
	}
	if len(selectedSpecs) == len(specPairs) {
		return specPairs, nil
	}

	selectedSet := make(map[string]struct{}, len(selectedSpecs))
	for _, selection := range selectedSpecs {
		selectedSet[selection] = struct{}{}
	}

	filtered := make([]specPair, 0, len(selectedSpecs))
	for _, pair := range specPairs {
		if _, ok := selectedSet[pair.selector]; ok {
			filtered = append(filtered, pair)
		}
	}

	return filtered, nil
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
			selector:   specSelectorName(relativePath),
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

func specSelectorName(relativePath string) string {
	normalizedPath := filepath.ToSlash(relativePath)
	selector := strings.TrimSuffix(normalizedPath, "/"+specFileName)
	if selector == normalizedPath && normalizedPath == specFileName {
		return "spec"
	}

	return selector
}

func selectSpecsWithInquire(specs []string) ([]string, error) {
	selected := make([]bool, len(specs))

	query := inquire.Query().Select("Select specs to diff", nil)
	for index, spec := range specs {
		query.SelectItem(&selected[index], spec)
	}
	query.Exec()

	selectedSpecs := selectedSpecNames(specs, selected)
	if len(selectedSpecs) == 0 {
		return nil, nil
	}

	return selectedSpecs, nil
}

func canUseInquire(stdin io.Reader, stdout io.Writer) bool {
	inputFile, ok := stdin.(*os.File)
	if !ok || inputFile != os.Stdin {
		return false
	}
	outputFile, ok := stdout.(*os.File)
	if !ok || outputFile != os.Stdout {
		return false
	}

	return isTerminalFile(inputFile) && isTerminalFile(outputFile)
}

func isTerminalFile(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func parseSpecSelections(rawSelection string) []string {
	selection := strings.TrimSpace(rawSelection)
	if selection == "" {
		return nil
	}

	parts := strings.Split(selection, ",")
	selections := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		spec := strings.TrimSpace(part)
		if spec == "" {
			continue
		}
		if spec == "all" {
			return []string{"all"}
		}
		if _, ok := seen[spec]; ok {
			continue
		}
		seen[spec] = struct{}{}
		selections = append(selections, spec)
	}

	return selections
}

func validateSpecSelections(specs []string, selections []string) ([]string, error) {
	if len(selections) == 0 {
		return nil, errNoSpecSelection
	}
	if len(selections) == 1 && selections[0] == "all" {
		return specs, nil
	}

	available := make(map[string]struct{}, len(specs))
	for _, spec := range specs {
		available[spec] = struct{}{}
	}

	for _, selection := range selections {
		if _, ok := available[selection]; !ok {
			return nil, fmt.Errorf("Spec '%s' not found.", selection)
		}
	}

	return selections, nil
}

func selectedSpecNames(specs []string, selected []bool) []string {
	selectedSpecs := make([]string, 0, len(specs))
	for index, spec := range specs {
		if selected[index] {
			selectedSpecs = append(selectedSpecs, spec)
		}
	}

	return selectedSpecs
}

func specSelectors(specPairs []specPair) []string {
	specs := make([]string, 0, len(specPairs))
	for _, pair := range specPairs {
		specs = append(specs, pair.selector)
	}

	return specs
}
