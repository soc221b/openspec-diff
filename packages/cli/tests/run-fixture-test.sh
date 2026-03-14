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

printf '\n' | (
	cd "$TMP_DIR"
	"$CLI_BIN"
) >"$TMP_DIR/stdout.txt" 2>"$TMP_DIR/stderr.txt"

diff -u "$FIXTURE_DIR/stdout.txt" "$TMP_DIR/stdout.txt"
diff -u "$FIXTURE_DIR/stderr.txt" "$TMP_DIR/stderr.txt"
