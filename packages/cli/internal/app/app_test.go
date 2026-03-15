package app

import (
	"bufio"
	"strings"
	"testing"
)

func TestReadPromptInputRecognizesArrowNavigation(t *testing.T) {
	input, err := readPromptInput(bufio.NewReader(strings.NewReader("\x1b[A")))
	if err != nil {
		t.Fatalf("readPromptInput returned error: %v", err)
	}

	if input.kind != promptInputMoveUp {
		t.Fatalf("expected move up input, got %v", input.kind)
	}
}

func TestReadPromptInputPreservesUnknownEscapeSequencesAsTypedText(t *testing.T) {
	input, err := readPromptInput(bufio.NewReader(strings.NewReader("\x1b[C")))
	if err != nil {
		t.Fatalf("readPromptInput returned error: %v", err)
	}

	if input.kind != promptInputTyped {
		t.Fatalf("expected typed input, got %v", input.kind)
	}
	if input.text != "\x1b[C" {
		t.Fatalf("expected typed text %q, got %q", "\x1b[C", input.text)
	}
}

func TestReadPromptInputTreatsIncompleteEscapeSequenceAsEOF(t *testing.T) {
	input, err := readPromptInput(bufio.NewReader(strings.NewReader("\x1b[")))
	if err != nil {
		t.Fatalf("readPromptInput returned error: %v", err)
	}

	if input.kind != promptInputEOF {
		t.Fatalf("expected EOF input, got %v", input.kind)
	}
}

func TestReadPromptInputRecognizesSpaceAsToggle(t *testing.T) {
	input, err := readPromptInput(bufio.NewReader(strings.NewReader(" ")))
	if err != nil {
		t.Fatalf("readPromptInput returned error: %v", err)
	}

	if input.kind != promptInputToggle {
		t.Fatalf("expected toggle input, got %v", input.kind)
	}
}
