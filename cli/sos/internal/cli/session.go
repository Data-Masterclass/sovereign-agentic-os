// SPDX-License-Identifier: Apache-2.0
// Package cli wires the sos command tree over the oauth/config/tokenstore/mcp/output
// packages. It holds no governance of its own — the OS is authoritative.
package cli

import (
	"context"
	"fmt"

	"github.com/sovereign-os/sos/internal/config"
	"github.com/sovereign-os/sos/internal/mcp"
	"github.com/sovereign-os/sos/internal/oauth"
	"github.com/sovereign-os/sos/internal/tokenstore"
)

// session resolves a profile to a governed MCP client whose bearer token is loaded
// from the keychain and transparently refreshed (with rotation persisted) when
// expired. All calls run as the logged-in user.
type session struct {
	profileName string
	profile     config.Profile
	store       *tokenstore.Store
	http        *mcp.Client
}

// newSession builds a session for the given profile name (empty = default).
func newSession(profileName string) (*session, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	name, prof, err := cfg.Get(profileName)
	if err != nil {
		return nil, err
	}
	dir, err := config.Dir()
	if err != nil {
		return nil, err
	}
	s := &session{
		profileName: name,
		profile:     prof,
		store:       tokenstore.New(dir),
	}
	s.http = &mcp.Client{
		BaseURL: prof.BaseURL,
		HTTP:    oauth.DefaultHTTPClient(),
		Token:   s.token,
	}
	return s, nil
}

// token returns a valid bearer access token, refreshing (and persisting the rotated
// token set) if the stored one is expired.
func (s *session) token(ctx context.Context) (string, error) {
	tok, err := s.store.Load(s.profileName)
	if err != nil {
		return "", fmt.Errorf("%w — run: sos login --profile %s %s", err, s.profileName, s.profile.BaseURL)
	}
	if !tok.Expired() {
		return tok.AccessToken, nil
	}
	if tok.RefreshToken == "" || s.profile.ClientID == "" {
		return "", fmt.Errorf("access token expired and cannot refresh — run: sos login --profile %s", s.profileName)
	}
	meta, err := oauth.Discover(ctx, oauth.DefaultHTTPClient(), s.profile.BaseURL)
	if err != nil {
		return "", err
	}
	refreshed, err := oauth.Refresh(ctx, oauth.DefaultHTTPClient(), meta.TokenEndpoint, s.profile.ClientID, tok.RefreshToken)
	if err != nil {
		return "", fmt.Errorf("token refresh failed — run: sos login --profile %s: %w", s.profileName, err)
	}
	if err := s.store.Save(s.profileName, refreshed); err != nil {
		return "", err
	}
	return refreshed.AccessToken, nil
}
