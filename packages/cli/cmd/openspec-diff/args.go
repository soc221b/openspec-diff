package main

import (
	"fmt"
	"strings"
)

const helpText = `Usage: openspec-diff [options] [change-name] [spec-name[,spec-name...]]

Show changes between delta specs of a change and the main specs

Options:
  -h, --help       display help for command
  --specs          diff all specs without prompting
`

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
	if len(positionalArgs) == 0 {
		return "", "", nil
	}
	if len(positionalArgs) == 1 {
		return positionalArgs[0], "", nil
	}

	return positionalArgs[0], positionalArgs[1], nil
}
