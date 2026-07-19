// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"testing"
	"time"
)

func TestTokenExpired(t *testing.T) {
	past := Token{Expiry: time.Now().Add(-time.Hour)}
	if !past.Expired() {
		t.Error("token with past expiry should be Expired")
	}
	future := Token{Expiry: time.Now().Add(time.Hour)}
	if future.Expired() {
		t.Error("token with future expiry should not be Expired")
	}
	// A token expiring within the 30s leeway is treated as expired so we refresh early.
	soon := Token{Expiry: time.Now().Add(10 * time.Second)}
	if !soon.Expired() {
		t.Error("token inside leeway window should be Expired")
	}
	// Zero expiry means the server reported no exp — treat as long-lived.
	var zero Token
	if zero.Expired() {
		t.Error("zero-expiry token should not be Expired")
	}
}

func TestTokenResponseToToken(t *testing.T) {
	r := tokenResponse{
		AccessToken:  "at",
		RefreshToken: "rt",
		TokenType:    "Bearer",
		Scope:        "mcp:tools",
		ExpiresIn:    3600,
	}
	tok := r.toToken()
	if tok.AccessToken != "at" || tok.RefreshToken != "rt" || tok.Scope != "mcp:tools" {
		t.Fatalf("fields not mapped: %+v", tok)
	}
	if tok.Expiry.Before(time.Now().Add(30*time.Minute)) || tok.Expiry.After(time.Now().Add(90*time.Minute)) {
		t.Fatalf("expiry %v not ~1h out", tok.Expiry)
	}
}
