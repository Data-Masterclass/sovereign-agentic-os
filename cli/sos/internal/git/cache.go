// SPDX-License-Identifier: Apache-2.0
package git

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Cache stores minted credentials keyed by "protocol://host". It exists so a burst
// of git calls (a push touches the helper several times) mints once, then reuses
// the token until just before it expires. It is a CACHE, not a token store: the
// on-disk copy is 0600, TTL-bounded, and re-mints transparently once expired.
//
// Security invariants:
//   - Get NEVER returns an expired credential (it is treated as absent).
//   - The on-disk file is written 0600 in a 0700 dir; the token lives nowhere else.
//   - Delete (erase/logout) removes both the memory and disk copy.
type Cache struct {
	dir string // per-profile cache dir; "" disables the disk layer (memory only)
	mem map[string]Credential
	now func() time.Time // injectable clock for tests
}

// NewCache returns a cache backed by dir (a per-profile directory). Passing "" for
// dir yields a pure in-memory cache (used in tests and when no cache dir resolves).
func NewCache(dir string) *Cache {
	return &Cache{dir: dir, mem: map[string]Credential{}, now: time.Now}
}

// Get returns a non-expired credential for host, or ok=false if none is usable. An
// expired or malformed entry is proactively purged so it can never be served.
func (c *Cache) Get(host string) (Credential, bool) {
	key := hostKey(host)
	now := c.now()

	if cred, ok := c.mem[key]; ok {
		if !cred.Expired(now) {
			return cred, true
		}
		delete(c.mem, key) // never serve an expired token
	}

	cred, ok := c.readFile(key)
	if !ok {
		return Credential{}, false
	}
	if cred.Expired(now) {
		_ = os.Remove(c.filePath(key)) // purge stale on-disk token
		return Credential{}, false
	}
	c.mem[key] = cred
	return cred, true
}

// Put stores cred for its host in memory and (best-effort) on disk with 0600 perms.
// An unwritable disk layer is not fatal: the memory copy still serves this process.
func (c *Cache) Put(cred Credential) error {
	key := hostKey(cred.Host)
	c.mem[key] = cred
	if c.dir == "" {
		return nil
	}
	return c.writeFile(key, cred)
}

// Delete removes any cached credential for host from both layers (erase/logout).
func (c *Cache) Delete(host string) {
	key := hostKey(host)
	delete(c.mem, key)
	if c.dir != "" {
		_ = os.Remove(c.filePath(key))
	}
}

// Clear removes every on-disk cached credential and empties memory. Used on logout
// so no minted token outlives the session.
func (c *Cache) Clear() {
	c.mem = map[string]Credential{}
	if c.dir == "" {
		return
	}
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == cacheExt {
			_ = os.Remove(filepath.Join(c.dir, e.Name()))
		}
	}
}

const cacheExt = ".json"

// cacheFile is the on-disk shape. It mirrors Credential; host is stored so a stray
// file is self-describing, and the token stays as the sole secret at rest.
type cacheFile struct {
	Username  string    `json:"username"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
	Scopes    []string  `json:"scopes"`
	Host      string    `json:"host"`
}

// fileName is a filesystem-safe, collision-free name for a host key. The key can
// contain "://" and ":port"; hex-encoding avoids path traversal and separator
// ambiguity entirely.
func (c *Cache) filePath(key string) string {
	return filepath.Join(c.dir, encodeKey(key)+cacheExt)
}

func (c *Cache) writeFile(key string, cred Credential) error {
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return fmt.Errorf("create git cache dir: %w", err)
	}
	blob, err := json.Marshal(cacheFile{
		Username:  cred.Username,
		Token:     cred.Token,
		ExpiresAt: cred.ExpiresAt,
		Scopes:    cred.Scopes,
		Host:      cred.Host,
	})
	if err != nil {
		return fmt.Errorf("encode git credential: %w", err)
	}
	// 0600: the token is a secret at rest, readable only by the owner.
	if err := os.WriteFile(c.filePath(key), blob, 0o600); err != nil {
		return fmt.Errorf("write git credential cache: %w", err)
	}
	return nil
}

func (c *Cache) readFile(key string) (Credential, bool) {
	data, err := os.ReadFile(c.filePath(key))
	if errors.Is(err, os.ErrNotExist) || err != nil {
		return Credential{}, false
	}
	var f cacheFile
	if err := json.Unmarshal(data, &f); err != nil {
		return Credential{}, false // treat a corrupt cache as absent, not fatal
	}
	return Credential{
		Username:  f.Username,
		Token:     f.Token,
		ExpiresAt: f.ExpiresAt,
		Scopes:    f.Scopes,
		Host:      f.Host,
	}, true
}
