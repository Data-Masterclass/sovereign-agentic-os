// SPDX-License-Identifier: Apache-2.0
package git

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// Helper is the pure, testable core of `sos git credential`. It implements git's
// credential-helper protocol over the injected Minter + Cache, so the command layer
// is a thin I/O shell. It knows exactly one Forgejo host and passes every other host
// through untouched (git then falls back to its next helper).
type Helper struct {
	// ForgejoHost is the "protocol://host" this helper serves (from the mint
	// contract's forgejoBaseUrl). Empty means "serve whatever host git asks for",
	// used before setup has pinned a host.
	ForgejoHost string
	Minter      Minter
	Cache       *Cache
}

// Get handles the credential-helper `get` action: parse git's request, return a
// cached-or-freshly-minted credential for our Forgejo host, and write it back. For
// an unknown host it writes nothing and returns nil so git's own resolution
// continues — the credential is never minted for a host we don't own.
//
// This is the ONLY method that writes a token to out, and only via WriteCredential's
// `password=` line.
func (h *Helper) Get(ctx context.Context, in io.Reader, out io.Writer) error {
	q, err := ParseQuery(in)
	if err != nil {
		return err
	}
	host := q.URLHost()
	if !h.serves(host) {
		return nil // unknown host: passthrough, mint nothing
	}

	if cred, ok := h.Cache.Get(host); ok {
		return WriteCredential(out, cred.Username, cred.Token)
	}

	resp, err := h.Minter.Mint(ctx)
	if err != nil {
		return err
	}
	cred, err := resp.toCredential(host)
	if err != nil {
		return err
	}
	if err := h.Cache.Put(cred); err != nil {
		// Caching is best-effort; still serve git this request's fresh credential.
		_ = err
	}
	return WriteCredential(out, cred.Username, cred.Token)
}

// Store handles `store`: git offers a credential to persist. We deliberately do NOT
// persist git-supplied credentials — our tokens come only from the governed mint —
// so this is a no-op that drains the input block. (We never trust an inbound token.)
func (h *Helper) Store(in io.Reader) error {
	_, err := ParseQuery(in)
	return err
}

// Erase handles `erase`: git asks us to forget a credential (e.g. after a 401). We
// clear our cache for that host so the next `get` re-mints a fresh token.
func (h *Helper) Erase(in io.Reader) error {
	q, err := ParseQuery(in)
	if err != nil {
		return err
	}
	if host := q.URLHost(); host != "" && h.serves(host) {
		h.Cache.Delete(host)
	}
	return nil
}

// Dispatch routes a credential-helper action ("get"/"store"/"erase") to its handler.
// Unknown actions are a no-op (git may add actions; a helper must tolerate them).
func (h *Helper) Dispatch(ctx context.Context, action string, in io.Reader, out io.Writer) error {
	switch action {
	case "get":
		return h.Get(ctx, in, out)
	case "store":
		return h.Store(in)
	case "erase":
		return h.Erase(in)
	default:
		return nil
	}
}

// serves reports whether host is the Forgejo host this helper mints for. An empty
// ForgejoHost serves any host (pre-pin); otherwise it must match exactly (after
// normalisation).
func (h *Helper) serves(host string) bool {
	if host == "" {
		return false
	}
	if h.ForgejoHost == "" {
		return true
	}
	return hostKey(host) == hostKey(h.ForgejoHost)
}

// HostOf returns the "protocol://host" of a base URL (e.g. the mint contract's
// forgejoBaseUrl), dropping any path/query. It is the value to pin as ForgejoHost
// and to configure git's per-host credential helper against.
func HostOf(baseURL string) string {
	s := strings.TrimSpace(baseURL)
	scheme := "https"
	if i := strings.Index(s, "://"); i >= 0 {
		scheme = s[:i]
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return ""
	}
	return fmt.Sprintf("%s://%s", scheme, s)
}
