package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/soc221b/openspec-diff/packages/cli/internal/app"
)

const helpText = `Usage: openspec-diff [options] [change-name]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help       display help for command
`

func main() {
	if hasHelpArg(os.Args[1:]) {
		_, _ = fmt.Fprint(os.Stdout, helpText)
		return
	}

	changeName, err := parseChangeNameArg(os.Args[1:])
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if err := app.Run(context.Background(), os.Stdin, os.Stdout, ".", changeName, runCommand); err != nil {
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

func parseChangeNameArg(args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	if len(args) > 1 {
		return "", fmt.Errorf("expected at most one change name argument")
	}
	if strings.HasPrefix(args[0], "-") {
		return "", fmt.Errorf("unknown option %q", args[0])
	}

	return args[0], nil
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
