package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/soc221b/openspec-diff/packages/cli/internal/app"
)

const helpText = `Diff OpenSpec delta specs against the main specs.

Usage:
  openspec-diff [options]

Description:
  Shows the active OpenSpec changes, lets you select one to diff, and compares
  the selected change's delta specs against the main specs. In interactive use,
  navigate with ↑/↓ and press Enter. You can also pipe an exact change name on
  stdin.

Options:
  --help, -h    Show help for openspec-diff.
`

func main() {
	if hasHelpArg(os.Args[1:]) {
		_, _ = fmt.Fprint(os.Stdout, helpText)
		return
	}

	if err := app.Run(context.Background(), os.Stdin, os.Stdout, ".", runCommand); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func hasHelpArg(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return true
		}
	}

	return false
}

func runCommand(ctx context.Context, dir string, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr

	if err := command.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 {
			return nil
		}
		return err
	}

	return nil
}
