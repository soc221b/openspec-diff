package main

import (
	"context"
	"fmt"
	"os"

	"github.com/soc221b/openspec-diff/packages/cli/internal/app"
)

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

	if err := app.Run(context.Background(), os.Stdin, os.Stdout, ".", changeName, specName, runCommand); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
