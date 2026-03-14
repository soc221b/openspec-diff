package app

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

func selectRequestedChange(stdin io.Reader, stdout io.Writer, changes []string, changeName string) (string, error) {
	if strings.TrimSpace(changeName) != "" {
		return resolveExactChange(changes, changeName)
	}

	return selectChange(stdin, stdout, changes)
}

func selectChange(stdin io.Reader, stdout io.Writer, changes []string) (string, error) {
	reader := bufio.NewReader(stdin)
	selectedIndex := 0
	typedSelection := strings.Builder{}
	rendered := false

	renderPrompt := func() {
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

	renderPrompt()

	for {
		input, err := reader.ReadByte()
		if err != nil {
			return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), err)
		}

		switch input {
		case '\r', '\n':
			return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), nil)
		case '\x1b':
			next, direction, handled, err := readArrowKey(reader)
			if err != nil {
				return resolveSelection(stdout, changes, selectedIndex, typedSelection.String(), err)
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
				if selectedIndex < len(changes)-1 {
					selectedIndex++
				}
				renderPrompt()
			}
		default:
			typedSelection.WriteByte(input)
		}
	}
}

func resolveSelection(stdout io.Writer, changes []string, selectedIndex int, rawSelection string, readErr error) (string, error) {
	if readErr != nil && !isEOF(readErr) {
		return "", readErr
	}

	selection := strings.TrimSpace(rawSelection)
	if selection == "" {
		if isEOF(readErr) {
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
