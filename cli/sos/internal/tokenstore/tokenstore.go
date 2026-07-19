// SPDX-License-Identifier: Apache-2.0
// Package tokenstore persists OAuth tokens as secrets. It prefers the OS keychain
// (macOS Keychain / libsecret / Windows Credential Manager via go-keyring) and
// falls back to a 0600 file under the config dir ONLY when no keyring is available.
// Tokens are secrets: they are never logged and never written to config.toml.
package tokenstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/sovereign-os/sos/internal/oauth"
	"github.com/zalando/go-keyring"
)

// keyringService is the keychain service name; tokens are keyed per profile.
const keyringService = "sovereign-os-sos"

// Store reads and writes tokens for a profile. Backend selection happens lazily on
// first write so a working keyring is used when present.
type Store struct {
	// dir is the config dir used for the file fallback.
	dir string
}

// New returns a Store rooted at the given config directory (used only for the file
// fallback).
func New(dir string) *Store { return &Store{dir: dir} }

// Save persists the token for a profile. It tries the keyring first; on failure it
// falls back to a 0600 file and returns nil (login must still succeed offline of a
// keyring, e.g. headless Linux without libsecret).
func (s *Store) Save(profile string, tok oauth.Token) error {
	blob, err := json.Marshal(tok)
	if err != nil {
		return fmt.Errorf("encode token: %w", err)
	}
	if err := keyring.Set(keyringService, profile, string(blob)); err == nil {
		// Keyring holds it; remove any stale file copy so there is one source of truth.
		_ = os.Remove(s.filePath(profile))
		return nil
	}
	return s.saveFile(profile, blob)
}

// Load returns the stored token for a profile. It checks the keyring first, then the
// file fallback. A missing token returns ErrNotFound.
func (s *Store) Load(profile string) (oauth.Token, error) {
	if v, err := keyring.Get(keyringService, profile); err == nil {
		var t oauth.Token
		if err := json.Unmarshal([]byte(v), &t); err != nil {
			return oauth.Token{}, fmt.Errorf("decode token from keyring: %w", err)
		}
		return t, nil
	}
	return s.loadFile(profile)
}

// Delete removes the stored token from both backends (logout).
func (s *Store) Delete(profile string) error {
	_ = keyring.Delete(keyringService, profile)
	err := os.Remove(s.filePath(profile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ErrNotFound is returned when no token exists for a profile.
var ErrNotFound = errors.New("no stored token — run: sos login")

func (s *Store) filePath(profile string) string {
	return filepath.Join(s.dir, "tokens", profile+".json")
}

func (s *Store) saveFile(profile string, blob []byte) error {
	p := s.filePath(profile)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return fmt.Errorf("create token dir: %w", err)
	}
	if err := os.WriteFile(p, blob, 0o600); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}
	return nil
}

func (s *Store) loadFile(profile string) (oauth.Token, error) {
	data, err := os.ReadFile(s.filePath(profile))
	if errors.Is(err, os.ErrNotExist) {
		return oauth.Token{}, ErrNotFound
	}
	if err != nil {
		return oauth.Token{}, fmt.Errorf("read token file: %w", err)
	}
	var t oauth.Token
	if err := json.Unmarshal(data, &t); err != nil {
		return oauth.Token{}, fmt.Errorf("decode token file: %w", err)
	}
	return t, nil
}
