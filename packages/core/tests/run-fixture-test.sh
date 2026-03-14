#!/bin/sh

set -eu

FIXTURE_DIR=$(CDPATH= cd -- "$1" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$FIXTURE_DIR/../../../.." && pwd)
TOOL_BIN="$WORKSPACE_ROOT/dist/target/core/debug/openspec-difftool"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$FIXTURE_DIR/openspec" "$TMP_DIR/openspec"
git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" config diff.tool terminaldiff
git -C "$TMP_DIR" config difftool.prompt false
git -C "$TMP_DIR" config difftool.terminaldiff.cmd 'diff "$LOCAL" "$REMOTE"'

if [ ! -f "$FIXTURE_DIR/stdin.txt" ]; then
	printf '%s\n' "Missing required stdin fixture: $FIXTURE_DIR/stdin.txt" >&2
	exit 1
fi

(
	cd "$TMP_DIR"
	PATH="$FIXTURE_DIR/mock-bin:$PATH" FIXTURE_STDIN_PATH="$FIXTURE_DIR/stdin.txt" FIXTURE_STDOUT_PATH="$TMP_DIR/stdout.txt" FIXTURE_STDERR_PATH="$TMP_DIR/stderr.txt" python - <<'PY' "$TOOL_BIN"
import os
import shlex
import subprocess
import sys

stdin_path = os.environ["FIXTURE_STDIN_PATH"]
stdout_path = os.environ["FIXTURE_STDOUT_PATH"]
stderr_path = os.environ["FIXTURE_STDERR_PATH"]
tool_bin = sys.argv[1]
command_name = os.path.basename(tool_bin)


def strip_inline_comment(value: str) -> str:
    escaped = False
    quote = None

    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char == "#":
            return value[:index].rstrip()

    return value.strip()


command = [tool_bin]

with open(stdin_path, encoding="utf-8") as handle:
    for line_number, raw_line in enumerate(handle, start=1):
        instruction = strip_inline_comment(raw_line)
        if not instruction:
            continue
        invocation = shlex.split(instruction)
        if len(invocation) == 0 or os.path.basename(invocation[0]) != command_name:
            raise SystemExit(
                f"{stdin_path}:{line_number}: expected invocation starting with {command_name}"
            )
        command.extend(invocation[1:])
        break
    else:
        raise SystemExit(f"{stdin_path}: missing {command_name} invocation")


process = subprocess.run(command, text=True, capture_output=True)

with open(stdout_path, "w", encoding="utf-8") as handle:
    handle.write(process.stdout)

with open(stderr_path, "w", encoding="utf-8") as handle:
    handle.write(process.stderr)

if process.returncode not in (0, 1):
    sys.exit(process.returncode)
PY
)

diff -u "$FIXTURE_DIR/stdout.txt" "$TMP_DIR/stdout.txt"

if [ -f "$FIXTURE_DIR/stderr.txt" ]; then
	diff -u "$FIXTURE_DIR/stderr.txt" "$TMP_DIR/stderr.txt"
elif [ -s "$TMP_DIR/stderr.txt" ]; then
	printf '%s\n' "Unexpected stderr output for $FIXTURE_DIR" >&2
	cat "$TMP_DIR/stderr.txt" >&2
	exit 1
fi
