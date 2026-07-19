// SPDX-License-Identifier: Apache-2.0
// Package config manages ~/.config/sos/config.toml: named profiles, each targeting
// one OS instance (like `aws` profiles), plus the DCR client_id learned at login.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

// DefaultProfile is used when --profile is not given.
const DefaultProfile = "default"

// Profile targets a single OS instance. ClientID is the Dynamic Client Registration
// id learned on first login; reused on refresh. Tokens are NOT stored here — they
// live in the OS keychain (see internal/tokenstore).
type Profile struct {
	BaseURL  string `toml:"base_url"`
	ClientID string `toml:"client_id,omitempty"`
}

// Config is the full config.toml: a default profile name plus named profiles.
type Config struct {
	Default  string             `toml:"default_profile,omitempty"`
	Profiles map[string]Profile `toml:"profiles"`
}

// Dir returns the config directory (respecting XDG_CONFIG_HOME, falling back to
// ~/.config/sos).
func Dir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "sos"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".config", "sos"), nil
}

// Path returns the config file path.
func Path() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.toml"), nil
}

// Load reads config.toml. A missing file yields an empty (valid) Config so first
// run works without setup.
func Load() (*Config, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if err := toml.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", p, err)
	}
	if c.Profiles == nil {
		c.Profiles = map[string]Profile{}
	}
	return &c, nil
}

// Save writes config.toml with 0600 perms in a 0700 directory (it can hold the
// instance URL and client_id — not secret, but kept private by convention).
func Save(c *Config) error {
	d, err := Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	out, err := toml.Marshal(c)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	p := filepath.Join(d, "config.toml")
	if err := os.WriteFile(p, out, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// Get returns the named profile, or the default if name is empty. It errors if the
// profile does not exist so commands can tell the user to run `sos login`.
func (c *Config) Get(name string) (string, Profile, error) {
	if name == "" {
		name = c.Default
	}
	if name == "" {
		name = DefaultProfile
	}
	p, ok := c.Profiles[name]
	if !ok {
		return name, Profile{}, fmt.Errorf("profile %q not found — run: sos login --profile %s <os-url>", name, name)
	}
	return name, p, nil
}

// Put upserts a profile. If no default is set yet, this profile becomes the default.
func (c *Config) Put(name string, p Profile) {
	if name == "" {
		name = DefaultProfile
	}
	if c.Profiles == nil {
		c.Profiles = map[string]Profile{}
	}
	c.Profiles[name] = p
	if c.Default == "" {
		c.Default = name
	}
}
