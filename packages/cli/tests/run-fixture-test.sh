#!/bin/sh

set -eu

FIXTURE_DIR=$(CDPATH= cd -- "$1" && pwd)
CLI_BIN="$FIXTURE_DIR/../../bin/openspec-diff"
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
	FIXTURE_STDIN_PATH="$FIXTURE_DIR/stdin.txt" FIXTURE_STDOUT_PATH="$TMP_DIR/stdout.txt" FIXTURE_STDERR_PATH="$TMP_DIR/stderr.txt" python - <<'PY' "$CLI_BIN"
import codecs
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

stdin_path = os.environ["FIXTURE_STDIN_PATH"]
stdout_path = os.environ["FIXTURE_STDOUT_PATH"]
stderr_path = os.environ["FIXTURE_STDERR_PATH"]
cli_bin = sys.argv[1]
command_name = os.path.basename(cli_bin)
OUTPUT_IDLE_TIMEOUT_SECONDS = 0.2
OUTPUT_POLL_INTERVAL_SECONDS = 0.01
MAX_OUTPUT_SETTLE_SECONDS = 1.0


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


def parse_invocation(value: str, line_number: int) -> list[str]:
    """Parse a readable CLI invocation line from stdin.txt.

    Args:
        value: The uncommented line content from stdin.txt.
        line_number: The 1-based source line number for error reporting.

    Returns:
        The shell-style token list from stdin.txt, such as
        ``["openspec-diff", "--help"]``.
    """
    try:
        return shlex.split(value)
    except ValueError as error:
        raise SystemExit(
            f"{stdin_path}:{line_number}: invalid CLI invocation in stdin.txt: {error}"
        ) from error


def strip_inline_comment(value: str) -> str:
    """Drop unquoted trailing # comments without disturbing input escapes.

    Args:
        value: A raw stdin.txt line that may include quotes, escapes, and a
            trailing shell-style comment.

    Returns:
        The line content with only an unquoted trailing comment removed, while
        preserving quoted or escaped # characters used as real input. When no
        unquoted comment marker is present, this returns the original line with
        leading and trailing whitespace removed; comment-only lines normalize
        to an empty string.
    """
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


def read_stream_to_buffer(stream, buffer):
    while True:
        chunk = stream.read(1)
        if chunk == "":
            return
        buffer.append(chunk)


def wait_for_output_to_settle(process, buffer):
    """Wait until captured output stops changing briefly or the process exits."""
    previous_length = len(buffer)
    idle_deadline = time.monotonic() + OUTPUT_IDLE_TIMEOUT_SECONDS
    overall_deadline = time.monotonic() + MAX_OUTPUT_SETTLE_SECONDS
    exit_deadline = None
    while time.monotonic() < overall_deadline:
        current_length = len(buffer)
        if current_length != previous_length:
            previous_length = current_length
            idle_deadline = time.monotonic() + OUTPUT_IDLE_TIMEOUT_SECONDS
        now = time.monotonic()
        if process.poll() is None:
            if now >= idle_deadline:
                return
            time.sleep(OUTPUT_POLL_INTERVAL_SECONDS)
            continue
        if exit_deadline is None:
            exit_deadline = min(now + OUTPUT_IDLE_TIMEOUT_SECONDS, overall_deadline)
        if now >= exit_deadline:
            return
        time.sleep(OUTPUT_POLL_INTERVAL_SECONDS)


command = [cli_bin]
instructions = []
seen_instruction = False

with open(stdin_path, encoding="utf-8") as handle:
    for line_number, raw_line in enumerate(handle, start=1):
        instruction = strip_inline_comment(raw_line)
        if not instruction:
            continue
        if not seen_instruction:
            invocation = parse_invocation(instruction, line_number)
            seen_instruction = True
            if len(invocation) > 0 and os.path.basename(invocation[0]) == command_name:
                command.extend(invocation[1:])
                continue
        instructions.append((line_number, instruction))


process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    preexec_fn=os.setsid,
)

abort_requested = False
stdout_buffer = []
stderr_buffer = []
stdout_thread = threading.Thread(target=read_stream_to_buffer, args=(process.stdout, stdout_buffer))
stderr_thread = threading.Thread(target=read_stream_to_buffer, args=(process.stderr, stderr_buffer))
stdout_thread.start()
stderr_thread.start()

error_message = None

if len(instructions) == 0:
    process.stdin.close()
    process.stdin = None
    wait_for_output_to_settle(process, stdout_buffer)

for line_number, instruction in instructions:
    if instruction == "^C":
        abort_requested = True
        wait_for_output_to_settle(process, stdout_buffer)
        os.killpg(process.pid, signal.SIGINT)
        break

    process.stdin.write(decode_instruction(instruction, line_number))
    process.stdin.flush()
    wait_for_output_to_settle(process, stdout_buffer)
    if process.poll() is not None:
        break

if not abort_requested and process.poll() is None:
    last_line_number = instructions[-1][0] if instructions else 1
    error_message = (
        f"{stdin_path}:{last_line_number}: process did not exit after scripted input; "
        "add ^C or explicit submit input such as \\n"
    )
    if process.stdin is not None:
        process.stdin.close()
        process.stdin = None
    os.killpg(process.pid, signal.SIGINT)

process.wait()
stdout_thread.join()
stderr_thread.join()
stdout = "".join(stdout_buffer)
stderr = "".join(stderr_buffer)

with open(stdout_path, "w", encoding="utf-8") as handle:
    handle.write(normalize_output(stdout))

with open(stderr_path, "w", encoding="utf-8") as handle:
    handle.write(stderr)

if error_message is not None:
    print(error_message, file=sys.stderr)
    sys.exit(1)

# Exit code 1 is acceptable here because git diff uses it to signal
# "differences found", and fixture tests snapshot that diff output as success.
# A scripted Ctrl-C snapshot is also expected to terminate with SIGINT.
if process.returncode not in (0, 1):
    if abort_requested and process.returncode in (-signal.SIGINT, 128 + signal.SIGINT):
        sys.exit(0)
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
