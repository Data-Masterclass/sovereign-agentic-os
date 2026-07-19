// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Token is the OAuth token set the CLI persists. Expiry is stored as an absolute
// time so refresh decisions don't depend on when the process started.
type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type"`
	Scope        string    `json:"scope"`
	Expiry       time.Time `json:"expiry"`
}

// Expired reports whether the access token is at or past its expiry, with a small
// leeway so we refresh slightly early rather than mid-request.
func (t Token) Expired() bool {
	if t.Expiry.IsZero() {
		return false // server may report no expiry; treat as long-lived
	}
	return time.Now().After(t.Expiry.Add(-30 * time.Second))
}

// tokenResponse mirrors the /oauth/token JSON (os-ui app/oauth/token/route.ts).
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func (r tokenResponse) toToken() Token {
	var exp time.Time
	if r.ExpiresIn > 0 {
		exp = time.Now().Add(time.Duration(r.ExpiresIn) * time.Second)
	}
	return Token{
		AccessToken:  r.AccessToken,
		RefreshToken: r.RefreshToken,
		TokenType:    r.TokenType,
		Scope:        r.Scope,
		Expiry:       exp,
	}
}

// RegisterClient performs Dynamic Client Registration (RFC 7591) at
// registration_endpoint, returning the public client_id (no secret — the server
// is token_endpoint_auth_method=none).
func RegisterClient(ctx context.Context, hc *http.Client, registrationEndpoint, redirectURI, clientName string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"redirect_uris": []string{redirectURI},
		"client_name":   clientName,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registrationEndpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("register client: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		ClientID  string `json:"client_id"`
		Error     string `json:"error"`
		ErrorDesc string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode registration response: %w", err)
	}
	if out.ClientID == "" {
		return "", fmt.Errorf("registration failed: %s (%s)", oauthErr(out.Error), out.ErrorDesc)
	}
	return out.ClientID, nil
}

// ExchangeCode redeems an authorization code for tokens (grant_type=authorization_code,
// PKCE code_verifier, public client).
func ExchangeCode(ctx context.Context, hc *http.Client, tokenEndpoint, clientID, code, redirectURI, verifier string) (Token, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {clientID},
		"code_verifier": {verifier},
	}
	return postToken(ctx, hc, tokenEndpoint, form)
}

// Refresh rotates the token set (grant_type=refresh_token). The server rotates the
// refresh token on every use, so callers MUST persist the returned Token.
func Refresh(ctx context.Context, hc *http.Client, tokenEndpoint, clientID, refreshToken string) (Token, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {clientID},
	}
	return postToken(ctx, hc, tokenEndpoint, form)
}

func postToken(ctx context.Context, hc *http.Client, tokenEndpoint string, form url.Values) (Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()
	var tr tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return Token{}, fmt.Errorf("decode token response: %w", err)
	}
	if tr.Error != "" || tr.AccessToken == "" {
		return Token{}, fmt.Errorf("token endpoint error: %s (%s)", oauthErr(tr.Error), tr.ErrorDesc)
	}
	return tr.toToken(), nil
}

func oauthErr(code string) string {
	if code == "" {
		return "unknown_error"
	}
	return code
}
