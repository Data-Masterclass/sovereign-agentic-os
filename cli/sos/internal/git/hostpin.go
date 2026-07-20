// SPDX-License-Identifier: Apache-2.0
package git

import (
	"os"
	"path/filepath"
	"strings"
)

// hostPinFile records the Forgejo host (protocol://host) this profile's helper
// serves, learned once at `sos git setup` from the mint contract's forgejoBaseUrl.
// It is NOT a secret (a public host name), stored 0600 by convention beside the
// cache. The credential helper reads it so it can passthrough foreign hosts without
// minting a token to discover its own host.
const hostPinFile = "forgejo-host"

// LoadHostPin returns the pinned Forgejo host for a cache dir, or "" if none is set.
func LoadHostPin(dir string) string {
	if dir == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(dir, hostPinFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// SaveHostPin records host as the Forgejo host for a cache dir (0700 dir, 0600 file).
func SaveHostPin(dir, host string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, hostPinFile), []byte(hostKey(host)+"\n"), 0o600)
}
