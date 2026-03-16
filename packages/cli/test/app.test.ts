import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readPromptInput, StreamByteReader } from "../src/app.ts";

test("readPromptInput recognizes arrow navigation", async () => {
  const input = await readPromptInput(
    new StreamByteReader(Readable.from([Buffer.from("\x1b[A")])),
  );

  assert.equal(input.kind, "moveUp");
});

test("readPromptInput preserves unknown escape sequences as typed text", async () => {
  const input = await readPromptInput(
    new StreamByteReader(Readable.from([Buffer.from("\x1b[C")])),
  );

  assert.equal(input.kind, "typed");
  assert.equal(input.text, "\x1b[C");
});

test("readPromptInput treats incomplete escape sequence as eof", async () => {
  const input = await readPromptInput(
    new StreamByteReader(Readable.from([Buffer.from("\x1b[")])),
  );

  assert.equal(input.kind, "eof");
});

test("readPromptInput recognizes space as toggle", async () => {
  const input = await readPromptInput(
    new StreamByteReader(Readable.from([Buffer.from(" ")])),
  );

  assert.equal(input.kind, "toggle");
});
