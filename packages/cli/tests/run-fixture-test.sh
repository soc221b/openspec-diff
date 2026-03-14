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
import threading
import time

stdin_path = os.environ["FIXTURE_STDIN_PATH"]
stdout_path = os.environ["FIXTURE_STDOUT_PATH"]
stderr_path = os.environ["FIXTURE_STDERR_PATH"]
command = sys.argv[1:]
command_name = os.path.basename(command[0])
OUTPUT_IDLE_TIMEOUT_SECONDS = 0.2
OUTPUT_POLL_INTERVAL_SECONDS = 0.01
INITIAL_OUTPUT_LENGTH = 0


def decode_instruction(value: str, line_number: int) -> str:
    """Decode unicode escapes used by scripted stdin fixture instructions."""
    try:
        return codecs.decode(value, "unicode_escape")
    except UnicodeDecodeError as error:
        raise SystemExit(
            f"{stdin_path}:{line_number}: invalid escape sequence in stdin instruction: {error}"
        ) from error


def normalize_output(value: str) -> str:
    """Strip cursor-up and clear-screen redraw escapes from interactive output."""
    normalized = value.rsplit("\x1b[J", 1)[-1]
    return re.sub(r"\x1b\[\d+A", "", normalized)


def read_stream_to_buffer(stream, buffer):
    while True:
        chunk = stream.read(1)
        if chunk == "":
            return
        buffer.append(chunk)


def wait_for_new_output(process, buffer, previous_length):
    """Wait briefly for a captured output buffer to grow after scripted input."""
    deadline = time.monotonic() + OUTPUT_IDLE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if len(buffer) > previous_length or process.poll() is not None:
            return
        time.sleep(OUTPUT_POLL_INTERVAL_SECONDS)


process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    preexec_fn=os.setsid,
)

abort_requested = False
seen_instruction = False
stdout_buffer = []
stderr_buffer = []
stdout_thread = threading.Thread(target=read_stream_to_buffer, args=(process.stdout, stdout_buffer))
stderr_thread = threading.Thread(target=read_stream_to_buffer, args=(process.stderr, stderr_buffer))
stdout_thread.start()
stderr_thread.start()

with open(stdin_path, encoding="utf-8") as handle:
    for line_number, raw_line in enumerate(handle, start=1):
        instruction = raw_line.split("#", 1)[0].strip()
        if not instruction:
            continue
        # Allow fixture scripts to start with the CLI invocation line for
        # readability without stealing later stdin that happens to match it.
        if not seen_instruction and os.path.basename(instruction) == command_name:
            seen_instruction = True
            continue
        seen_instruction = True

        if instruction == "^C":
            abort_requested = True
            wait_for_new_output(process, stdout_buffer, INITIAL_OUTPUT_LENGTH)
            os.killpg(process.pid, signal.SIGINT)
            break

        previous_stdout_length = len(stdout_buffer)
        process.stdin.write(decode_instruction(instruction, line_number))
        process.stdin.flush()
        wait_for_new_output(process, stdout_buffer, previous_stdout_length)

if not abort_requested:
    process.stdin.close()
    process.stdin = None

process.wait()
stdout_thread.join()
stderr_thread.join()
stdout = "".join(stdout_buffer)
stderr = "".join(stderr_buffer)

with open(stdout_path, "w", encoding="utf-8") as handle:
    handle.write(normalize_output(stdout))

with open(stderr_path, "w", encoding="utf-8") as handle:
    handle.write(stderr)

# Exit code 1 is acceptable here because git diff uses it to signal
# "differences found", and fixture tests snapshot that diff output as success.
# A scripted Ctrl-C snapshot is also expected to terminate with SIGINT.
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
