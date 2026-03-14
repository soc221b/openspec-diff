package main

import "testing"

func TestParsePositionalArgs(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name       string
		args       []string
		wantChange string
		wantSpec   string
		wantErr    string
	}{
		{
			name: "no args",
			args: nil,
		},
		{
			name:       "change only",
			args:       []string{"my-change"},
			wantChange: "my-change",
		},
		{
			name:       "change and spec",
			args:       []string{"my-change", "api"},
			wantChange: "my-change",
			wantSpec:   "api",
		},
		{
			name:     "all specs only",
			args:     []string{"--specs"},
			wantSpec: "all",
		},
		{
			name:       "change and all specs",
			args:       []string{"my-change", "--specs"},
			wantChange: "my-change",
			wantSpec:   "all",
		},
		{
			name:    "unknown option",
			args:    []string{"--wat"},
			wantErr: `unknown option "--wat"`,
		},
		{
			name:    "too many args",
			args:    []string{"a", "b", "c"},
			wantErr: "expected at most one change name argument and one spec name argument",
		},
		{
			name:    "spec arg with all specs",
			args:    []string{"my-change", "api", "--specs"},
			wantErr: "cannot use --specs with a spec name argument",
		},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			gotChange, gotSpec, err := parsePositionalArgs(testCase.args)
			if testCase.wantErr != "" {
				if err == nil || err.Error() != testCase.wantErr {
					t.Fatalf("parsePositionalArgs(%v) error = %v, want %q", testCase.args, err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parsePositionalArgs(%v) unexpected error: %v", testCase.args, err)
			}
			if gotChange != testCase.wantChange || gotSpec != testCase.wantSpec {
				t.Fatalf("parsePositionalArgs(%v) = (%q, %q), want (%q, %q)", testCase.args, gotChange, gotSpec, testCase.wantChange, testCase.wantSpec)
			}
		})
	}
}
