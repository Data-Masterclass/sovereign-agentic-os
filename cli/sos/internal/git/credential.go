// SPDX-License-Identifier: Apache-2.0
// Package git implements the `sos git` credential-helper: a governed bridge that
// hands raw `git clone/pull/push` a per-user, short-lived, domain-scoped Forgejo
// token minted server-side by os-ui. It is a FRONT DOOR — the token is minted AS
// the logged-in user and re-checked by OPA/DLS server-side; the helper only carries
// it to git for the moment git needs it.
//
// Token hygiene is the whole point of this package: the minted token is NEVER
// logged, NEVER printed except in the exact credential-helper `password=` line git
// requires, and any on-disk cache is 0600 and TTL-bounded (see cache.go).
package git

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"io"
	"sort"
	"strings"
)

// Query is a parsed git credential-helper request. git writes these key=value
// lines on stdin (git-credential(1) "credential helper" protocol); we read the
// fields we route on. Password is present only on `store`, never on `get`.
type Query struct {
	Protocol string // e.g. "https"
	Host     string // e.g. "forgejo.example.eu" (may include :port)
	Path     string // e.g. "analytics.git" (present when useHttpPath is on)
	Username string // git's suggested username, if any
}

// ParseQuery reads the newline-terminated key=value credential block from r,
// stopping at a blank line or EOF as git's protocol specifies. Unknown keys are
// ignored (forward-compatible); the sensitive `password` key is intentionally not
// retained on read so a token can never leak back through our parsing.
func ParseQuery(r io.Reader) (Query, error) {
	var q Query
	sc := bufio.NewScanner(r)
	// Allow long lines (paths/URLs) without a tiny default cap.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			break // blank line terminates the block
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "protocol":
			q.Protocol = val
		case "host":
			q.Host = val
		case "path":
			q.Path = val
		case "username":
			q.Username = val
		}
	}
	if err := sc.Err(); err != nil {
		return Query{}, fmt.Errorf("read credential request: %w", err)
	}
	return q, nil
}

// URLHost is protocol://host, the stable key we cache and match Forgejo on. Path
// is deliberately excluded so one minted token serves every repo on the host.
func (q Query) URLHost() string {
	if q.Protocol == "" || q.Host == "" {
		return ""
	}
	return q.Protocol + "://" + q.Host
}

// WriteCredential emits the credential-helper `get` response git expects:
// username/password key=value lines followed by a blank line. This is the ONE
// place a token is written to stdout, and only ever as the `password=` value.
func WriteCredential(w io.Writer, username, password string) error {
	if _, err := fmt.Fprintf(w, "username=%s\n", username); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "password=%s\n", password); err != nil {
		return err
	}
	_, err := fmt.Fprint(w, "\n")
	return err
}

// hostKey normalises a "protocol://host" string for cache/config keying. It is a
// plain lower-cased trim — hosts are already canonical from git.
func hostKey(urlHost string) string {
	return strings.ToLower(strings.TrimSpace(urlHost))
}

// sortedScopes returns scopes in a stable order (used only for non-sensitive
// display/summaries — scopes are repo names, not secrets).
func sortedScopes(scopes []string) []string {
	out := append([]string(nil), scopes...)
	sort.Strings(out)
	return out
}

// encodeKey hex-encodes a host key into a filesystem-safe cache filename. Host keys
// contain "://" and ":port"; hex removes any separator/traversal ambiguity.
func encodeKey(key string) string {
	return hex.EncodeToString([]byte(hostKey(key)))
}
