// SPDX-License-Identifier: Apache-2.0
package oauth

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Scope is the MCP tool scope the server issues (SCOPE in os-ui/lib/mcp/oauth.ts).
const Scope = "mcp:tools"

// LoopbackResult carries the authorization code captured on the 127.0.0.1 callback.
type LoopbackResult struct {
	Code  string
	State string
}

// LoopbackServer binds a 127.0.0.1 listener whose redirect URI (http://127.0.0.1:PORT/callback)
// is on the server's allowlist (isAllowedRedirect in oauth.ts). The port is chosen
// by the OS so parallel logins don't collide.
type LoopbackServer struct {
	listener net.Listener
	srv      *http.Server
	results  chan LoopbackResult
	errs     chan error
}

// NewLoopbackServer binds an ephemeral 127.0.0.1 port. Call RedirectURI to build the
// registration/authorize redirect, then Wait after opening the browser.
func NewLoopbackServer() (*LoopbackServer, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind loopback listener: %w", err)
	}
	return &LoopbackServer{
		listener: l,
		results:  make(chan LoopbackResult, 1),
		errs:     make(chan error, 1),
	}, nil
}

// RedirectURI is the exact loopback callback the server allowlists: it must be
// http://127.0.0.1:<port>/callback.
func (s *LoopbackServer) RedirectURI() string {
	return fmt.Sprintf("http://127.0.0.1:%d/callback", s.port())
}

func (s *LoopbackServer) port() int {
	return s.listener.Addr().(*net.TCPAddr).Port
}

// Start serves the callback in the background. expectState is the CSRF `state`
// value; a mismatch is rejected.
func (s *LoopbackServer) Start(expectState string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			writeBrowserPage(w, "Login failed", "You can close this window and return to the terminal.")
			s.errs <- fmt.Errorf("authorization denied: %s (%s)", e, q.Get("error_description"))
			return
		}
		code := q.Get("code")
		state := q.Get("state")
		if code == "" {
			writeBrowserPage(w, "Login failed", "No authorization code was returned.")
			s.errs <- errors.New("no authorization code in callback")
			return
		}
		if state != expectState {
			writeBrowserPage(w, "Login failed", "State mismatch — possible CSRF. Aborted.")
			s.errs <- errors.New("state mismatch on callback (possible CSRF)")
			return
		}
		writeBrowserPage(w, "Signed in to Sovereign OS", "You can close this window and return to the terminal.")
		s.results <- LoopbackResult{Code: code, State: state}
	})
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := s.srv.Serve(s.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.errs <- err
		}
	}()
}

// Wait blocks until the callback fires, the context is cancelled, or ctx times out.
func (s *LoopbackServer) Wait(ctx context.Context) (LoopbackResult, error) {
	defer s.close()
	select {
	case res := <-s.results:
		return res, nil
	case err := <-s.errs:
		return LoopbackResult{}, err
	case <-ctx.Done():
		return LoopbackResult{}, fmt.Errorf("login timed out or was cancelled: %w", ctx.Err())
	}
}

func (s *LoopbackServer) close() {
	if s.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(ctx)
	}
}

// AuthorizeURL builds the /oauth/authorize URL for the browser to open.
func AuthorizeURL(authEndpoint, clientID, redirectURI, challenge, state, scope string) (string, error) {
	u, err := url.Parse(authEndpoint)
	if err != nil {
		return "", fmt.Errorf("parse authorization endpoint: %w", err)
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("scope", scope)
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func writeBrowserPage(w http.ResponseWriter, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>%s</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e7ecf1;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:26rem;padding:2rem;border:1px solid #232a31;border-radius:12px;background:#11151a}
h1{font-size:1.15rem;margin:0 0 .5rem} p{color:#9aa7b2;margin:0;line-height:1.5}</style></head>
<body><div class="card"><h1>%s</h1><p>%s</p></div></body></html>`, title, title, body)
}
