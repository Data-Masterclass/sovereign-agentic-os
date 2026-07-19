// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/pkg/browser"
	"github.com/sovereign-os/sos/internal/config"
	"github.com/sovereign-os/sos/internal/oauth"
	"github.com/sovereign-os/sos/internal/tokenstore"
	"github.com/spf13/cobra"
)

func newLoginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login <os-url>",
		Short: "Sign in to an OS instance via OAuth 2.1 PKCE loopback",
		Long: `login runs the OAuth 2.1 PKCE loopback flow against the OS authorization server:

  1. discover  — GET <os-url>/.well-known/oauth-authorization-server
  2. register  — Dynamic Client Registration (RFC 7591) with a 127.0.0.1 redirect
  3. authorize — open the browser to /oauth/authorize (PKCE S256 challenge)
  4. callback  — capture the code on http://127.0.0.1:<port>/callback
  5. exchange  — POST /oauth/token (PKCE code_verifier) for access + refresh tokens

Tokens are stored in the OS keychain (or a 0600 file if no keyring is available) and
are never printed or committed. The client_id is saved to the profile for refresh.

  sos login https://os.example.eu
  sos login --profile prod https://os.example.eu`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLogin(cmd.Context(), profileFlag, args[0])
		},
	}
}

func runLogin(ctx context.Context, profileName, baseURL string) error {
	baseURL = strings.TrimRight(baseURL, "/")
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		return fmt.Errorf("os-url must start with http:// or https:// (got %q)", baseURL)
	}
	if profileName == "" {
		profileName = config.DefaultProfile
	}
	hc := oauth.DefaultHTTPClient()

	meta, err := oauth.Discover(ctx, hc, baseURL)
	if err != nil {
		return err
	}

	// Bind the loopback listener FIRST so the redirect_uri (with its OS-chosen port)
	// is known before registration + authorize.
	lb, err := oauth.NewLoopbackServer()
	if err != nil {
		return err
	}
	redirectURI := lb.RedirectURI()

	clientID, err := oauth.RegisterClient(ctx, hc, meta.RegistrationEndpoint, redirectURI, "sos CLI")
	if err != nil {
		return err
	}

	pkce, err := oauth.NewPKCE()
	if err != nil {
		return err
	}
	state, err := oauth.RandomState()
	if err != nil {
		return err
	}
	authURL, err := oauth.AuthorizeURL(meta.AuthorizationEndpoint, clientID, redirectURI, pkce.Challenge, state, oauth.Scope)
	if err != nil {
		return err
	}

	lb.Start(state)
	fmt.Fprintln(os.Stderr, "Opening your browser to sign in…")
	fmt.Fprintf(os.Stderr, "If it does not open, visit:\n\n  %s\n\n", authURL)
	_ = browser.OpenURL(authURL) // best-effort; the URL is printed as a fallback

	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	res, err := lb.Wait(waitCtx)
	if err != nil {
		return err
	}

	tok, err := oauth.ExchangeCode(ctx, hc, meta.TokenEndpoint, clientID, res.Code, redirectURI, pkce.Verifier)
	if err != nil {
		return err
	}

	// Persist profile (base URL + client_id) and the token (secret) separately.
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cfg.Put(profileName, config.Profile{BaseURL: baseURL, ClientID: clientID})
	if err := config.Save(cfg); err != nil {
		return err
	}
	dir, err := config.Dir()
	if err != nil {
		return err
	}
	store := tokenstore.New(dir)
	if err := store.Save(profileName, tok); err != nil {
		return err
	}

	fmt.Printf("Signed in to %s (profile %q). Run: sos whoami\n", baseURL, profileName)
	return nil
}
