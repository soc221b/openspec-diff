package app

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/burl/inquire"
)

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

	reader := bufio.NewReader(stdin)
	selectedIndex := 0
	typedSelection := strings.Builder{}
	selected := make([]bool, len(specs))
	rendered := false

	renderPrompt := func() {
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

	renderPrompt()

	for {
		input, err := reader.ReadByte()
		if err != nil {
			return resolveSpecSelections(stdout, specs, selected, typedSelection.String(), err)
		}

		switch input {
		case '\r', '\n':
			return resolveSpecSelections(stdout, specs, selected, typedSelection.String(), nil)
		case ' ':
			selected[selectedIndex] = !selected[selectedIndex]
			renderPrompt()
		case '\x1b':
			next, direction, handled, err := readArrowKey(reader)
			if err != nil {
				return resolveSpecSelections(stdout, specs, selected, typedSelection.String(), err)
			}
			if !handled {
				typedSelection.WriteByte(input)
				typedSelection.WriteByte(next)
				if direction != 0 {
					typedSelection.WriteByte(direction)
				}
				continue
			}

			switch direction {
			case 'A':
				if selectedIndex > 0 {
					selectedIndex--
				}
				renderPrompt()
			case 'B':
				if selectedIndex < len(specs)-1 {
					selectedIndex++
				}
				renderPrompt()
			}
		default:
			typedSelection.WriteByte(input)
		}
	}
}

func resolveSpecSelections(stdout io.Writer, specs []string, selected []bool, rawSelection string, readErr error) ([]string, error) {
	if readErr != nil && !isEOF(readErr) {
		return nil, readErr
	}

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
