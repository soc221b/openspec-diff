#!/bin/sh

set -eu

FIXTURE_DIR=$1
CLI_BIN="$FIXTURE_DIR/../../bin/openspec-diff"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$FIXTURE_DIR/openspec" "$TMP_DIR/openspec"
git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" config diff.tool terminaldiff
git -C "$TMP_DIR" config difftool.prompt false
git -C "$TMP_DIR" config difftool.terminaldiff.cmd 'diff "$LOCAL" "$REMOTE"'

set -- "$CLI_BIN"
if [ -f "$FIXTURE_DIR/args.txt" ]; then
	while IFS= read -r arg || [ -n "$arg" ]; do
		set -- "$@" "$arg"
	done <"$FIXTURE_DIR/args.txt"
fi

(
	cd "$TMP_DIR"
	if [ -f "$FIXTURE_DIR/stdin.txt" ]; then
		FIXTURE_STDIN_PATH="$FIXTURE_DIR/stdin.txt" FIXTURE_STDOUT_PATH="$TMP_DIR/stdout.txt" FIXTURE_STDERR_PATH="$TMP_DIR/stderr.txt" python - <<'PY' "$@"
import codecs
import os
import re
import signal
import subprocess
import sys
import time

stdin_path = os.environ["FIXTURE_STDIN_PATH"]
stdout_path = os.environ["FIXTURE_STDOUT_PATH"]
stderr_path = os.environ["FIXTURE_STDERR_PATH"]
command = sys.argv[1:]
command_name = os.path.basename(command[0])


def decode_instruction(value: str) -> str:
    return codecs.decode(value, "unicode_escape")


def normalize_output(value: str) -> str:
    normalized = value.rsplit("\x1b[J", 1)[-1]
    return re.sub(r"\x1b\[\d+A", "", normalized)


process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    preexec_fn=os.setsid,
)

abort_requested = False

with open(stdin_path, encoding="utf-8") as handle:
    for raw_line in handle:
        instruction = raw_line.split("#", 1)[0].strip()
        # Allow fixture scripts to include the CLI invocation line for readability.
        if not instruction or instruction == command_name:
            continue

        if instruction == "^C":
            abort_requested = True
            # Give the CLI a moment to flush the prompt update before interrupting it.
            time.sleep(0.1)
            os.killpg(process.pid, signal.SIGINT)
            break

        process.stdin.write(decode_instruction(instruction))
        process.stdin.flush()
        # Small delay so interactive prompts can react before the next scripted step.
        time.sleep(0.05)

if not abort_requested:
    process.stdin.close()
    process.stdin = None

stdout, stderr = process.communicate()

with open(stdout_path, "w", encoding="utf-8") as handle:
    handle.write(normalize_output(stdout))

with open(stderr_path, "w", encoding="utf-8") as handle:
    handle.write(stderr)

if process.returncode not in (0, 1):
    if abort_requested and process.returncode in (-signal.SIGINT, 128 + signal.SIGINT):
        sys.exit(0)
    sys.exit(process.returncode)
PY
	else
		"$@" >"$TMP_DIR/stdout.txt" 2>"$TMP_DIR/stderr.txt" <<'EOF'

EOF
	fi
)

diff -u "$FIXTURE_DIR/stdout.txt" "$TMP_DIR/stdout.txt"
diff -u "$FIXTURE_DIR/stderr.txt" "$TMP_DIR/stderr.txt"
