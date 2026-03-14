package app

import "testing"

func TestGreeting(t *testing.T) {
	t.Parallel()

	if got, want := Greeting(), "openspec-diff CLI"; got != want {
		t.Fatalf("Greeting() = %q, want %q", got, want)
	}
}
