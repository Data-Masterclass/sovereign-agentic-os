// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"net/url"
	"testing"
)

func TestAuthorizeURLCarriesPKCEParams(t *testing.T) {
	raw, err := AuthorizeURL(
		"https://os.example.eu/oauth/authorize",
		"soa_client_abc",
		"http://127.0.0.1:54321/callback",
		"CHALLENGE",
		"STATE",
		Scope,
	)
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	checks := map[string]string{
		"response_type":         "code",
		"client_id":             "soa_client_abc",
		"redirect_uri":          "http://127.0.0.1:54321/callback",
		"code_challenge":        "CHALLENGE",
		"code_challenge_method": "S256",
		"scope":                 "mcp:tools",
		"state":                 "STATE",
	}
	for k, want := range checks {
		if got := q.Get(k); got != want {
			t.Errorf("param %s = %q, want %q", k, got, want)
		}
	}
}

func TestLoopbackRedirectURIShape(t *testing.T) {
	lb, err := NewLoopbackServer()
	if err != nil {
		t.Fatalf("NewLoopbackServer: %v", err)
	}
	uri := lb.RedirectURI()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("parse redirect uri %q: %v", uri, err)
	}
	if u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Path != "/callback" {
		t.Fatalf("redirect uri %q is not an allowlisted loopback callback", uri)
	}
}
