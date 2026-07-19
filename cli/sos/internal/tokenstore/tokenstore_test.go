// SPDX-License-Identifier: Apache-2.0
package tokenstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sovereign-os/sos/internal/oauth"
	"github.com/zalando/go-keyring"
)

func sample() oauth.Token {
	return oauth.Token{
		AccessToken:  "access-secret",
		RefreshToken: "refresh-secret",
		TokenType:    "Bearer",
		Scope:        "mcp:tools",
		Expiry:       time.Now().Add(time.Hour).Truncate(time.Second),
	}
}

func TestKeyringRoundTrip(t *testing.T) {
	keyring.MockInit() // in-memory keyring backend
	s := New(t.TempDir())
	want := sample()
	if err := s.Save("prod", want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := s.Load("prod")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.AccessToken != want.AccessToken || got.RefreshToken != want.RefreshToken {
		t.Fatalf("round-trip mismatch: %+v vs %+v", got, want)
	}
}

func TestDeleteRemoves(t *testing.T) {
	keyring.MockInit()
	s := New(t.TempDir())
	_ = s.Save("prod", sample())
	if err := s.Delete("prod"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Load("prod"); err == nil {
		t.Fatal("expected load after delete to fail")
	}
}

// TestFileFallback exercises the 0600-file backend used when no keyring is present,
// by driving the unexported file methods directly.
func TestFileFallback(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	want := sample()
	if err := s.saveFile("prod", mustJSON(t, want)); err != nil {
		t.Fatalf("saveFile: %v", err)
	}
	p := filepath.Join(dir, "tokens", "prod.json")
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat token file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token file perms = %o, want 600", perm)
	}
	got, err := s.loadFile("prod")
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	if got.AccessToken != want.AccessToken {
		t.Fatalf("file round-trip mismatch: %+v", got)
	}
}

func TestLoadMissingIsNotFound(t *testing.T) {
	s := New(t.TempDir())
	if _, err := s.loadFile("absent"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func mustJSON(t *testing.T, tok oauth.Token) []byte {
	t.Helper()
	b, err := json.Marshal(tok)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
