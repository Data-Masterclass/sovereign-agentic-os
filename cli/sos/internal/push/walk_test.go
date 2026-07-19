// SPDX-License-Identifier: Apache-2.0
package push

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWalkDirCollectsTextSkipsIgnored(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "app.yaml", "name: shop\n")
	writeFile(t, root, "src/index.ts", "export const x = 1\n")
	writeFile(t, root, "node_modules/dep/index.js", "junk\n") // ignored dir
	writeFile(t, root, ".git/config", "[core]\n")             // ignored dir

	got, err := WalkDir(root)
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 files, got %d: %v", len(got), SortedPaths(got))
	}
	if got["app.yaml"] != "name: shop\n" || got["src/index.ts"] != "export const x = 1\n" {
		t.Fatalf("unexpected content: %v", got)
	}
	if _, ok := got["node_modules/dep/index.js"]; ok {
		t.Fatal("node_modules should be ignored")
	}
}

func TestWalkDirSkipsBinary(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "ok.txt", "hello\n")
	// Invalid UTF-8 -> treated as binary and skipped.
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0xff, 0xfe, 0x00}, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := WalkDir(root)
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if _, ok := got["blob.bin"]; ok {
		t.Fatal("binary file should be skipped")
	}
	if _, ok := got["ok.txt"]; !ok {
		t.Fatal("text file should be kept")
	}
}

func TestWalkDirRejectsOversizeFile(t *testing.T) {
	root := t.TempDir()
	big := make([]byte, maxFileBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	if err := os.WriteFile(filepath.Join(root, "big.txt"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := WalkDir(root); err == nil {
		t.Fatal("expected error for oversize file")
	}
}

func TestWalkDirEmptyIsError(t *testing.T) {
	if _, err := WalkDir(t.TempDir()); err == nil {
		t.Fatal("expected error for empty dir (nothing to push)")
	}
}

func TestWalkDirNotADir(t *testing.T) {
	root := t.TempDir()
	f := filepath.Join(root, "file")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := WalkDir(f); err == nil {
		t.Fatal("expected error when path is not a directory")
	}
}
