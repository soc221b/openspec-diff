#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_BIN="$SCRIPT_DIR/../../bin/openspec-diff"
TMP_DIR=$(mktemp -d)
CAPTURE_TIMEOUT_SECONDS=3
POST_INPUT_SLEEP_SECONDS=1
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$SCRIPT_DIR/openspec" "$TMP_DIR/openspec"
git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" config diff.tool terminaldiff
git -C "$TMP_DIR" config difftool.prompt false
git -C "$TMP_DIR" config difftool.terminaldiff.cmd 'diff "$LOCAL" "$REMOTE"'

(
	cd "$TMP_DIR"
	timeout "$CAPTURE_TIMEOUT_SECONDS" sh -c '
		cli_bin=$1
		post_input_sleep_seconds=$2
		{ printf "\033[B"; sleep "$post_input_sleep_seconds"; tail -f /dev/null; } | "$cli_bin"
	' sh "$CLI_BIN" "$POST_INPUT_SLEEP_SECONDS"
) >"$TMP_DIR/raw-stdout.txt" 2>"$TMP_DIR/stderr.txt" || true

python - <<'PY' "$TMP_DIR/raw-stdout.txt" "$TMP_DIR/stdout.txt"
import re
import sys

raw_path, normalized_path = sys.argv[1], sys.argv[2]
raw = open(raw_path, encoding="utf-8").read()
normalized = raw.rsplit("\x1b[J", 1)[-1]
normalized = re.sub(r"\x1b\[\d+A", "", normalized)

with open(normalized_path, "w", encoding="utf-8") as handle:
    handle.write(normalized)
PY

diff -u "$SCRIPT_DIR/stdout.txt" "$TMP_DIR/stdout.txt"
diff -u "$SCRIPT_DIR/stderr.txt" "$TMP_DIR/stderr.txt"
