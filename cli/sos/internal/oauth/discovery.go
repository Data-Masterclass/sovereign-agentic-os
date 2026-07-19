// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// AuthServerMetadata is the subset of RFC 8414 metadata the CLI consumes from
// <base>/.well-known/oauth-authorization-server (authorizationServerMetadata in
// os-ui/lib/mcp/oauth.ts).
type AuthServerMetadata struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	RegistrationEndpoint  string   `json:"registration_endpoint"`
	CodeChallengeMethods  []string `json:"code_challenge_methods_supported"`
	GrantTypesSupported   []string `json:"grant_types_supported"`
	ScopesSupported       []string `json:"scopes_supported"`
}

// Discover fetches the authorization-server metadata for the given OS base URL.
// base is the instance origin, e.g. https://os.example.eu (no trailing slash
// required).
func Discover(ctx context.Context, hc *http.Client, base string) (*AuthServerMetadata, error) {
	base = strings.TrimRight(base, "/")
	url := base + "/.well-known/oauth-authorization-server"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch discovery document: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discovery %s returned %s", url, resp.Status)
	}
	var m AuthServerMetadata
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, fmt.Errorf("decode discovery document: %w", err)
	}
	if m.AuthorizationEndpoint == "" || m.TokenEndpoint == "" {
		return nil, fmt.Errorf("discovery document from %s is missing endpoints", url)
	}
	return &m, nil
}

// DefaultHTTPClient is a sane client for CLI use: bounded timeout, no redirects
// suppressed (the token/register endpoints are same-origin).
func DefaultHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}
