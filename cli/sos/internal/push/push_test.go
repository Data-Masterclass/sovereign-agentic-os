// SPDX-License-Identifier: Apache-2.0
package push

import (
	"reflect"
	"testing"
)

func TestDiffClassifiesAndCollectsChanged(t *testing.T) {
	remote := map[string]string{
		"app.yaml":     "name: shop\n",
		"src/index.ts": "old\n",
		"keep.txt":     "same\n",
	}
	local := map[string]string{
		"app.yaml":     "name: shop\n", // unchanged
		"src/index.ts": "new\n",        // modified
		"keep.txt":     "same\n",       // unchanged
		"src/new.ts":   "hello\n",      // added
	}

	changes, changed := Diff(local, remote)

	want := []Change{
		{Path: "app.yaml", Kind: Unchanged},
		{Path: "keep.txt", Kind: Unchanged},
		{Path: "src/index.ts", Kind: Modified},
		{Path: "src/new.ts", Kind: Added},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes = %+v, want %+v", changes, want)
	}

	// Only modified + added end up in the changeset, sorted by path.
	wantChanged := []File{
		{Path: "src/index.ts", Content: "new\n"},
		{Path: "src/new.ts", Content: "hello\n"},
	}
	if !reflect.DeepEqual(changed, wantChanged) {
		t.Fatalf("changed = %+v, want %+v", changed, wantChanged)
	}
}

func TestDiffDoesNotDeleteRemoteOnlyFiles(t *testing.T) {
	// A file present remotely but absent locally must NOT appear as a change:
	// commit merges over the prior tree; push never silently deletes.
	remote := map[string]string{"gone.txt": "still here\n"}
	local := map[string]string{}
	changes, changed := Diff(local, remote)
	if len(changes) != 0 || len(changed) != 0 {
		t.Fatalf("remote-only file must be ignored, got changes=%v changed=%v", changes, changed)
	}
}

func TestBuildCommitRequiresAppID(t *testing.T) {
	_, err := BuildCommit("  ", "msg", []File{{Path: "a", Content: "b"}})
	if err == nil {
		t.Fatal("expected error for missing app id")
	}
}

func TestBuildCommitRejectsEmptyChangeset(t *testing.T) {
	_, err := BuildCommit("app_1", "msg", nil)
	if err == nil {
		t.Fatal("expected error when there is nothing to push")
	}
}

func TestBuildCommitOK(t *testing.T) {
	got, err := BuildCommit("app_1", "add x", []File{{Path: "x", Content: "1"}})
	if err != nil {
		t.Fatalf("BuildCommit: %v", err)
	}
	if got.AppID != "app_1" || got.Message != "add x" || len(got.Files) != 1 {
		t.Fatalf("unexpected args: %+v", got)
	}
}

func TestToMapShapeMatchesTool(t *testing.T) {
	a := CommitArgs{AppID: "app_1", Message: "m", Files: []File{{Path: "p", Content: "c"}}}
	m := a.ToMap()
	if m["appId"] != "app_1" || m["message"] != "m" {
		t.Fatalf("scalar fields wrong: %+v", m)
	}
	files, ok := m["files"].([]map[string]any)
	if !ok || len(files) != 1 || files[0]["path"] != "p" || files[0]["content"] != "c" {
		t.Fatalf("files shape wrong: %+v", m["files"])
	}
}

func TestToMapOmitsEmptyMessage(t *testing.T) {
	m := CommitArgs{AppID: "app_1", Files: []File{{Path: "p", Content: "c"}}}.ToMap()
	if _, present := m["message"]; present {
		t.Fatalf("empty message should be omitted, got %+v", m)
	}
}

func TestSummaryCountsAndSkipsUnchanged(t *testing.T) {
	changes := []Change{
		{Path: "a", Kind: Added},
		{Path: "b", Kind: Modified},
		{Path: "c", Kind: Unchanged},
	}
	out := Summary(changes)
	if !contains(out, "add     a") || !contains(out, "modify  b") {
		t.Fatalf("summary missing changed files:\n%s", out)
	}
	if contains(out, " c\n") {
		t.Fatalf("summary should skip unchanged files:\n%s", out)
	}
	if !contains(out, "2 file(s) to push: 1 added, 1 modified.") {
		t.Fatalf("summary count wrong:\n%s", out)
	}
}

func TestSummaryNoChanges(t *testing.T) {
	out := Summary([]Change{{Path: "a", Kind: Unchanged}})
	if !contains(out, "No changes") {
		t.Fatalf("expected no-change message, got:\n%s", out)
	}
}

func TestNormalizePath(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"./src/index.ts", "src/index.ts", false},
		{"src/../app.yaml", "app.yaml", false},
		{"a/b/c.ts", "a/b/c.ts", false},
		{"../escape.ts", "", true},
		{"/etc/passwd", "", true},
		{".", "", true},
		{"", "", true},
	}
	for _, c := range cases {
		got, err := NormalizePath(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("NormalizePath(%q) expected error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizePath(%q) unexpected error: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("NormalizePath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
