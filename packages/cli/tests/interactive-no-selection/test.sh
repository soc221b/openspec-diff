#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_BIN="$SCRIPT_DIR/../../bin/openspec-diff"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$SCRIPT_DIR/openspec" "$TMP_DIR/openspec"
git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" config diff.tool terminaldiff
git -C "$TMP_DIR" config difftool.prompt false
git -C "$TMP_DIR" config difftool.terminaldiff.cmd 'diff "$LOCAL" "$REMOTE"'

(
	cd "$TMP_DIR"
	timeout 1 sh -c 'sleep 30 | "$1"' sh "$CLI_BIN"
) >"$TMP_DIR/stdout.txt" 2>"$TMP_DIR/stderr.txt" || true

diff -u "$SCRIPT_DIR/stdout.txt" "$TMP_DIR/stdout.txt"
diff -u "$SCRIPT_DIR/stderr.txt" "$TMP_DIR/stderr.txt"
