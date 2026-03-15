package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/soc221b/openspec-diff/packages/cli/internal/app"
)

const helpText = `Usage: openspec-diff [options] [change-name] [spec-name[,spec-name...]]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help       display help for command
  --specs          diff all specs without prompting
`

func main() {
	if hasHelpArg(os.Args[1:]) {
		_, _ = fmt.Fprint(os.Stdout, helpText)
		return
	}

	changeName, specName, err := parsePositionalArgs(os.Args[1:])
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if err := app.Run(context.Background(), os.Stdin, os.Stdout, ".", changeName, specName, coreDiffCommand(), runCommand); err != nil {
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

func parsePositionalArgs(args []string) (string, string, error) {
	positionalArgs := make([]string, 0, len(args))
	allSpecs := false
	for _, arg := range args {
		if arg == "--specs" {
			allSpecs = true
			continue
		}
		if strings.HasPrefix(arg, "-") {
			return "", "", fmt.Errorf("unknown option %q", arg)
		}
		positionalArgs = append(positionalArgs, arg)
	}
	if len(positionalArgs) > 2 {
		return "", "", fmt.Errorf("expected at most one change name argument and one spec name argument")
	}
	if allSpecs {
		if len(positionalArgs) == 2 {
			return "", "", fmt.Errorf("cannot use --specs with a spec name argument")
		}
		if len(positionalArgs) == 0 {
			return "", "all", nil
		}
		return positionalArgs[0], "all", nil
	}

	switch len(positionalArgs) {
	case 0:
		return "", "", nil
	case 1:
		return positionalArgs[0], "", nil
	default:
		return positionalArgs[0], positionalArgs[1], nil
	}
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

func coreDiffCommand() string {
	executablePath, err := os.Executable()
	if err != nil {
		return "openspec-difftool"
	}

	commandName := "openspec-difftool"
	if runtime.GOOS == "windows" {
		commandName += ".exe"
	}

	return filepath.Join(filepath.Dir(executablePath), commandName)
}
