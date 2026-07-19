// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestS256ChallengeMatchesServerTransform(t *testing.T) {
	// The server computes BASE64URL(SHA256(verifier)) with no padding (Go's
	// RawURLEncoding == Node's base64url). This test pins that exact transform.
	verifier := "abc123_verifier-value.example~test"
	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if got := S256Challenge(verifier); got != want {
		t.Fatalf("S256Challenge = %q, want %q", got, want)
	}
}

func TestNewPKCEProducesVerifiableChallenge(t *testing.T) {
	p, err := NewPKCE()
	if err != nil {
		t.Fatalf("NewPKCE: %v", err)
	}
	if len(p.Verifier) < 43 || len(p.Verifier) > 128 {
		t.Fatalf("verifier length %d out of RFC 7636 range 43..128", len(p.Verifier))
	}
	if S256Challenge(p.Verifier) != p.Challenge {
		t.Fatal("challenge does not verify against its verifier")
	}
	// base64url must not contain +, / or = characters.
	for _, c := range p.Challenge {
		if c == '+' || c == '/' || c == '=' {
			t.Fatalf("challenge contains non-url-safe char %q", c)
		}
	}
}

func TestNewPKCEUnique(t *testing.T) {
	a, _ := NewPKCE()
	b, _ := NewPKCE()
	if a.Verifier == b.Verifier {
		t.Fatal("two PKCE verifiers collided — randomness broken")
	}
}

func TestRandomStateNonEmptyAndUnique(t *testing.T) {
	s1, err := RandomState()
	if err != nil {
		t.Fatalf("RandomState: %v", err)
	}
	s2, _ := RandomState()
	if s1 == "" || s1 == s2 {
		t.Fatalf("state not random: %q vs %q", s1, s2)
	}
}
