// SPDX-License-Identifier: Apache-2.0
package git

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// MintResponse is the exact os-ui token-mint contract:
//
//	POST {os-ui}/api/git/token  (Bearer <sos OS session>)
//	→ { token, username, expiresAt, scopes, forgejoBaseUrl }
//
// The token is short-TTL and returned once. It is a secret: never logged, never
// serialised anywhere but the TTL-bounded 0600 cache and the git `password=` line.
type MintResponse struct {
	Token          string    `json:"token"`
	Username       string    `json:"username"`
	ExpiresAt      time.Time `json:"expiresAt"`
	Scopes         []string  `json:"scopes"`
	ForgejoBaseURL string    `json:"forgejoBaseUrl"`
}

// Credential is what the helper caches per host and hands to git. It carries the
// same secret token but a smaller, purpose-built shape with the expiry the cache
// enforces against.
type Credential struct {
	Username  string
	Token     string
	ExpiresAt time.Time
	Scopes    []string
	Host      string // "protocol://host" this credential is bound to
}

// Expired reports whether the credential is at/past expiry, with a small leeway so
// git never receives a token about to die mid-push. A zero expiry is treated as
// already-expired: the mint contract always returns one, so a missing expiry means
// a malformed/untrustworthy response we must not cache or serve.
func (c Credential) Expired(now time.Time) bool {
	if c.ExpiresAt.IsZero() {
		return true
	}
	return !now.Before(c.ExpiresAt.Add(-leeway))
}

// leeway is how early a credential is considered expired (refresh slightly early).
const leeway = 30 * time.Second

// toCredential maps a mint response onto a host-bound Credential. It validates the
// two fields git cannot work without (token, username) so a broken mint never
// yields a silently-empty password.
func (m MintResponse) toCredential(host string) (Credential, error) {
	if m.Token == "" || m.Username == "" {
		return Credential{}, fmt.Errorf("mint response missing token or username")
	}
	return Credential{
		Username:  m.Username,
		Token:     m.Token,
		ExpiresAt: m.ExpiresAt,
		Scopes:    sortedScopes(m.Scopes),
		Host:      host,
	}, nil
}

// Minter mints a short-lived Forgejo credential for the logged-in user. The helper
// depends on this interface, so tests inject a fake endpoint and the token never
// touches a real network path under test.
type Minter interface {
	Mint(ctx context.Context) (MintResponse, error)
}

// HTTPMinter calls the real os-ui mint route with the user's existing OS session
// bearer token (supplied lazily by Token, reusing the CLI's refresh-on-demand path).
type HTTPMinter struct {
	BaseURL string
	HTTP    *http.Client
	// Token returns the current OS bearer token, refreshing if needed. It mirrors
	// mcp.Client.Token so the mint call authenticates exactly as every other verb.
	Token func(ctx context.Context) (string, error)
}

// Mint performs POST {BaseURL}/api/git/token authenticated as the logged-in user.
// It surfaces transport/HTTP errors honestly and NEVER includes the response body
// (which carries the token) in an error message.
func (h *HTTPMinter) Mint(ctx context.Context) (MintResponse, error) {
	bearer, err := h.Token(ctx)
	if err != nil {
		return MintResponse{}, err
	}
	url := strings.TrimRight(h.BaseURL, "/") + "/api/git/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return MintResponse{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearer)

	resp, err := h.HTTP.Do(req)
	if err != nil {
		return MintResponse{}, fmt.Errorf("mint git token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return MintResponse{}, fmt.Errorf("not authenticated to mint a git token (401) — run: sos login")
	}
	if resp.StatusCode != http.StatusOK {
		// Status only — never echo the body, which may contain the token on success.
		return MintResponse{}, fmt.Errorf("git token endpoint returned %s", resp.Status)
	}
	var out MintResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return MintResponse{}, fmt.Errorf("decode git token response: %w", err)
	}
	return out, nil
}
