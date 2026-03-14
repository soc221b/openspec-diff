package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/soc221b/openspec-diff/packages/cli/internal/app"
)

func main() {
	if err := app.Run(context.Background(), os.Stdin, os.Stdout, ".", runCommand); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
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
