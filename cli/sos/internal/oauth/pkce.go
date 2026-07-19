// SPDX-License-Identifier: Apache-2.0
// Package oauth implements the client side of the Sovereign OS OAuth 2.1 PKCE
// loopback flow (RFC 7636). It targets the SAME authorization server the UI and
// hosted MCP clients use — os-ui is both AS and RS on one origin.
package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// PKCE holds a generated verifier and its S256 challenge. The server mandates
// code_challenge_method=S256 (see os-ui/lib/mcp/oauth.ts validateAuthorizeRequest).
type PKCE struct {
	Verifier  string
	Challenge string
}

// NewPKCE generates a cryptographically-random verifier and its S256 challenge.
// The verifier is 32 random bytes, base64url-encoded (43 chars), well within the
// RFC 7636 43–128 char range.
func NewPKCE() (PKCE, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return PKCE{}, fmt.Errorf("generate PKCE verifier: %w", err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(b)
	return PKCE{Verifier: verifier, Challenge: S256Challenge(verifier)}, nil
}

// S256Challenge computes BASE64URL(SHA256(verifier)) — the transform the server
// re-runs to verify the code (verifyPkceS256 in oauth.ts).
func S256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// RandomState returns a URL-safe random string for the OAuth `state` parameter
// (CSRF protection on the loopback callback).
func RandomState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
