// SPDX-License-Identifier: Apache-2.0
package config

import (
	"os"
	"path/filepath"
	"testing"
)

// withTempConfig points XDG_CONFIG_HOME at a temp dir so Load/Save touch no real
// user config.
func withTempConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

func TestLoadMissingReturnsEmpty(t *testing.T) {
	withTempConfig(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(c.Profiles) != 0 {
		t.Fatalf("expected empty profiles, got %v", c.Profiles)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := withTempConfig(t)
	c := &Config{Profiles: map[string]Profile{}}
	c.Put("prod", Profile{BaseURL: "https://os.example.eu", ClientID: "soa_client_x"})
	if err := Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// File must be 0600.
	info, err := os.Stat(filepath.Join(dir, "sos", "config.toml"))
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perms = %o, want 600", perm)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	name, p, err := got.Get("prod")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if name != "prod" || p.BaseURL != "https://os.example.eu" || p.ClientID != "soa_client_x" {
		t.Fatalf("round-trip mismatch: %s %+v", name, p)
	}
}

func TestPutSetsDefaultOnce(t *testing.T) {
	c := &Config{}
	c.Put("first", Profile{BaseURL: "a"})
	if c.Default != "first" {
		t.Fatalf("first Put should set default, got %q", c.Default)
	}
	c.Put("second", Profile{BaseURL: "b"})
	if c.Default != "first" {
		t.Fatalf("default should stay %q, got %q", "first", c.Default)
	}
}

func TestGetDefaultResolution(t *testing.T) {
	c := &Config{Profiles: map[string]Profile{"default": {BaseURL: "x"}}}
	name, _, err := c.Get("")
	if err != nil {
		t.Fatalf("Get empty: %v", err)
	}
	if name != "default" {
		t.Fatalf("empty profile should resolve to default, got %q", name)
	}
}

func TestGetUnknownProfileErrors(t *testing.T) {
	c := &Config{Profiles: map[string]Profile{}}
	if _, _, err := c.Get("nope"); err == nil {
		t.Fatal("expected error for unknown profile")
	}
}
