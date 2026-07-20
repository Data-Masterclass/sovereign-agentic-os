// SPDX-License-Identifier: Apache-2.0
package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const secretToken = "s3cr3t-forgejo-token-DO-NOT-LEAK"

// fakeMinter returns a canned response and counts calls so tests can prove the
// cache mints once and refreshes exactly when expected. It never touches a network.
type fakeMinter struct {
	resp  MintResponse
	err   error
	calls int
}

func (f *fakeMinter) Mint(ctx context.Context) (MintResponse, error) {
	f.calls++
	if f.err != nil {
		return MintResponse{}, f.err
	}
	return f.resp, nil
}

func newFakeMinter(expiresAt time.Time) *fakeMinter {
	return &fakeMinter{resp: MintResponse{
		Token:          secretToken,
		Username:       "alice",
		ExpiresAt:      expiresAt,
		Scopes:         []string{"analytics", "os-42"},
		ForgejoBaseURL: "https://forgejo.example.eu",
	}}
}

// --- credential protocol parsing ---

func TestParseQuery(t *testing.T) {
	in := "protocol=https\nhost=forgejo.example.eu\npath=analytics.git\nusername=git\n\n"
	q, err := ParseQuery(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if q.Protocol != "https" || q.Host != "forgejo.example.eu" || q.Path != "analytics.git" {
		t.Fatalf("parsed wrong: %+v", q)
	}
	if got := q.URLHost(); got != "https://forgejo.example.eu" {
		t.Fatalf("URLHost = %q", got)
	}
}

func TestParseQueryStopsAtBlankLine(t *testing.T) {
	in := "protocol=https\nhost=a.example\n\nhost=evil.example\n"
	q, err := ParseQuery(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if q.Host != "a.example" {
		t.Fatalf("did not stop at blank line: host=%q", q.Host)
	}
}

func TestWriteCredential(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteCredential(&buf, "alice", secretToken); err != nil {
		t.Fatal(err)
	}
	want := "username=alice\npassword=" + secretToken + "\n\n"
	if buf.String() != want {
		t.Fatalf("credential output = %q, want %q", buf.String(), want)
	}
}

// --- mint -> credential mapping ---

func TestToCredentialMapsFields(t *testing.T) {
	m := newFakeMinter(time.Now().Add(time.Hour)).resp
	cred, err := m.toCredential("https://forgejo.example.eu")
	if err != nil {
		t.Fatal(err)
	}
	if cred.Username != "alice" || cred.Token != secretToken {
		t.Fatalf("mapped wrong: %+v", cred)
	}
	if cred.Host != "https://forgejo.example.eu" {
		t.Fatalf("host = %q", cred.Host)
	}
	// scopes normalised to sorted order.
	if strings.Join(cred.Scopes, ",") != "analytics,os-42" {
		t.Fatalf("scopes = %v", cred.Scopes)
	}
}

func TestToCredentialRejectsMissingSecret(t *testing.T) {
	if _, err := (MintResponse{Username: "alice"}).toCredential("h"); err == nil {
		t.Fatal("expected error when token missing")
	}
	if _, err := (MintResponse{Token: "x"}).toCredential("h"); err == nil {
		t.Fatal("expected error when username missing")
	}
}

// --- TTL / expiry ---

func TestCredentialExpired(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	live := Credential{ExpiresAt: now.Add(time.Hour)}
	if live.Expired(now) {
		t.Fatal("live credential reported expired")
	}
	// Within the leeway window counts as expired (refresh slightly early).
	edge := Credential{ExpiresAt: now.Add(leeway / 2)}
	if !edge.Expired(now) {
		t.Fatal("credential inside leeway not treated as expired")
	}
	past := Credential{ExpiresAt: now.Add(-time.Second)}
	if !past.Expired(now) {
		t.Fatal("past credential not expired")
	}
	// Zero expiry is untrustworthy -> expired.
	if !(Credential{}).Expired(now) {
		t.Fatal("zero-expiry credential must be treated as expired")
	}
}

// --- cache: TTL, never-returns-expired, 0600, clear ---

func TestCacheRoundTripAndPerms(t *testing.T) {
	dir := t.TempDir()
	c := NewCache(dir)
	cred := Credential{Username: "alice", Token: secretToken, Host: "https://h.example", ExpiresAt: time.Now().Add(time.Hour)}
	if err := c.Put(cred); err != nil {
		t.Fatal(err)
	}
	// A fresh cache (cold memory) must load it from disk.
	c2 := NewCache(dir)
	got, ok := c2.Get("https://h.example")
	if !ok || got.Token != secretToken {
		t.Fatalf("cold-load miss: ok=%v cred=%+v", ok, got)
	}
	// On-disk file must be 0600.
	entries, _ := os.ReadDir(dir)
	var found bool
	for _, e := range entries {
		if filepath.Ext(e.Name()) == cacheExt {
			found = true
			info, err := os.Stat(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if perm := info.Mode().Perm(); perm != 0o600 {
				t.Fatalf("cache file perms = %o, want 600", perm)
			}
		}
	}
	if !found {
		t.Fatal("no cache file written")
	}
}

func TestCacheNeverReturnsExpired(t *testing.T) {
	dir := t.TempDir()
	c := NewCache(dir)
	c.now = func() time.Time { return time.Unix(2_000, 0) }
	// Store an already-expired credential directly to disk to simulate a stale file.
	expired := Credential{Username: "a", Token: secretToken, Host: "https://h", ExpiresAt: time.Unix(1_000, 0)}
	if err := c.Put(expired); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Get("https://h"); ok {
		t.Fatal("cache returned an expired credential")
	}
	// The stale on-disk token must have been purged, not left readable.
	if _, ok := NewCache(dir).readFile(encodeKey("https://h")); ok {
		// readFile finds it only if still present; after purge it should be gone.
		t.Fatal("expired cache file not purged from disk")
	}
}

func TestCacheClearRemovesTokens(t *testing.T) {
	dir := t.TempDir()
	c := NewCache(dir)
	_ = c.Put(Credential{Username: "a", Token: secretToken, Host: "https://h1", ExpiresAt: time.Now().Add(time.Hour)})
	_ = c.Put(Credential{Username: "a", Token: secretToken, Host: "https://h2", ExpiresAt: time.Now().Add(time.Hour)})
	c.Clear()
	if _, ok := NewCache(dir).Get("https://h1"); ok {
		t.Fatal("Clear left a token behind")
	}
	// No .json token files remain on disk.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == cacheExt {
			t.Fatalf("Clear left cache file %s", e.Name())
		}
	}
}

// --- helper get/store/erase protocol + refresh ---

// request builds a git credential `get` stdin block for a "protocol://host" URL.
func request(host string) string {
	parts := strings.SplitN(host, "://", 2)
	return "protocol=" + parts[0] + "\nhost=" + parts[1] + "\n\n"
}

func TestHelperGetMintsThenCaches(t *testing.T) {
	m := newFakeMinter(time.Now().Add(time.Hour))
	h := &Helper{ForgejoHost: "https://forgejo.example.eu", Minter: m, Cache: NewCache(t.TempDir())}

	var out bytes.Buffer
	if err := h.Dispatch(context.Background(), "get", strings.NewReader(request("https://forgejo.example.eu")), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "password="+secretToken) {
		t.Fatalf("get did not return the token: %q", out.String())
	}
	if m.calls != 1 {
		t.Fatalf("expected 1 mint, got %d", m.calls)
	}
	// Second get within TTL must be served from cache — no second mint.
	out.Reset()
	if err := h.Get(context.Background(), strings.NewReader(request("https://forgejo.example.eu")), &out); err != nil {
		t.Fatal(err)
	}
	if m.calls != 1 {
		t.Fatalf("cache miss: expected still 1 mint, got %d", m.calls)
	}
}

func TestHelperGetRefreshesWhenExpired(t *testing.T) {
	// First mint expires almost immediately; the cache clock advances past it.
	m := newFakeMinter(time.Unix(1_100, 0))
	cache := NewCache(t.TempDir())
	clock := time.Unix(1_000, 0)
	cache.now = func() time.Time { return clock }
	h := &Helper{ForgejoHost: "https://f.example", Minter: m, Cache: cache}

	var out bytes.Buffer
	host := "https://f.example"
	if err := h.Get(context.Background(), strings.NewReader(request(host)), &out); err != nil {
		t.Fatal(err)
	}
	if m.calls != 1 {
		t.Fatalf("expected first mint, got %d", m.calls)
	}
	// Advance the clock past expiry and re-mint with a fresh token.
	clock = time.Unix(5_000, 0)
	m.resp.Token = "second-token"
	m.resp.ExpiresAt = time.Unix(9_000, 0)
	out.Reset()
	if err := h.Get(context.Background(), strings.NewReader(request(host)), &out); err != nil {
		t.Fatal(err)
	}
	if m.calls != 2 {
		t.Fatalf("expected refresh mint, got %d calls", m.calls)
	}
	if !strings.Contains(out.String(), "password=second-token") {
		t.Fatalf("did not serve refreshed token: %q", out.String())
	}
}

func TestHelperUnknownHostPassthrough(t *testing.T) {
	m := newFakeMinter(time.Now().Add(time.Hour))
	h := &Helper{ForgejoHost: "https://forgejo.example.eu", Minter: m, Cache: NewCache(t.TempDir())}

	var out bytes.Buffer
	if err := h.Get(context.Background(), strings.NewReader(request("https://github.com")), &out); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("passthrough wrote output: %q", out.String())
	}
	if m.calls != 0 {
		t.Fatalf("minted a token for a foreign host (%d calls)", m.calls)
	}
}

func TestHelperStoreIsNoOpAndDrainsInput(t *testing.T) {
	m := newFakeMinter(time.Now().Add(time.Hour))
	h := &Helper{ForgejoHost: "https://f.example", Minter: m, Cache: NewCache(t.TempDir())}
	// store carries a password; it must be ignored (never trusted/cached).
	in := "protocol=https\nhost=f.example\nusername=x\npassword=attacker-supplied\n\n"
	if err := h.Dispatch(context.Background(), "store", strings.NewReader(in), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.Cache.Get("https://f.example"); ok {
		t.Fatal("store cached a git-supplied credential")
	}
}

func TestHelperEraseClearsCache(t *testing.T) {
	m := newFakeMinter(time.Now().Add(time.Hour))
	cache := NewCache(t.TempDir())
	h := &Helper{ForgejoHost: "https://f.example", Minter: m, Cache: cache}
	var out bytes.Buffer
	host := "https://f.example"
	_ = h.Get(context.Background(), strings.NewReader(request(host)), &out)
	if _, ok := cache.Get(host); !ok {
		t.Fatal("precondition: credential should be cached")
	}
	if err := h.Dispatch(context.Background(), "erase", strings.NewReader(request(host)), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := cache.Get(host); ok {
		t.Fatal("erase did not clear the cache")
	}
}

func TestHelperUnknownActionNoOp(t *testing.T) {
	h := &Helper{Minter: newFakeMinter(time.Now().Add(time.Hour)), Cache: NewCache(t.TempDir())}
	if err := h.Dispatch(context.Background(), "bogus", strings.NewReader(""), &bytes.Buffer{}); err != nil {
		t.Fatalf("unknown action should be a no-op, got %v", err)
	}
}

// --- token hygiene: no secret in any error output ---

func TestMintErrorNeverLeaksToken(t *testing.T) {
	// A 500 whose body echoes the token must not surface the token in the error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"token":"` + secretToken + `"}`))
	}))
	defer srv.Close()
	hm := &HTTPMinter{BaseURL: srv.URL, HTTP: srv.Client(), Token: func(context.Context) (string, error) { return "bearer", nil }}
	_, err := hm.Mint(context.Background())
	if err == nil {
		t.Fatal("expected error on 500")
	}
	if strings.Contains(err.Error(), secretToken) {
		t.Fatalf("error leaked the token: %v", err)
	}
}

func TestHTTPMinterHappyPathParsesContract(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost || r.URL.Path != "/api/git/token" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(MintResponse{
			Token: secretToken, Username: "alice",
			ExpiresAt: time.Now().Add(time.Hour), Scopes: []string{"analytics"},
			ForgejoBaseURL: "https://forgejo.example.eu",
		})
	}))
	defer srv.Close()
	hm := &HTTPMinter{BaseURL: srv.URL, HTTP: srv.Client(), Token: func(context.Context) (string, error) { return "bearer-xyz", nil }}
	resp, err := hm.Mint(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if resp.Token != secretToken || resp.Username != "alice" {
		t.Fatalf("parsed wrong: %+v", resp)
	}
	if gotAuth != "Bearer bearer-xyz" {
		t.Fatalf("mint did not authenticate as the user: %q", gotAuth)
	}
}

func TestHTTPMinter401IsActionable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	hm := &HTTPMinter{BaseURL: srv.URL, HTTP: srv.Client(), Token: func(context.Context) (string, error) { return "b", nil }}
	_, err := hm.Mint(context.Background())
	if err == nil || !strings.Contains(err.Error(), "sos login") {
		t.Fatalf("401 should tell the user to log in, got %v", err)
	}
}

func TestMintTokenErrorPropagates(t *testing.T) {
	hm := &HTTPMinter{BaseURL: "http://unused", Token: func(context.Context) (string, error) {
		return "", errors.New("no token")
	}}
	if _, err := hm.Mint(context.Background()); err == nil {
		t.Fatal("expected token-provider error to propagate")
	}
}

// --- host helpers ---

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://forgejo.example.eu":            "https://forgejo.example.eu",
		"https://forgejo.example.eu/":           "https://forgejo.example.eu",
		"https://forgejo.example.eu/owner/repo": "https://forgejo.example.eu",
		"http://localhost:3000/x":               "http://localhost:3000",
		"forgejo.example.eu":                    "https://forgejo.example.eu",
		"":                                      "",
	}
	for in, want := range cases {
		if got := HostOf(in); got != want {
			t.Errorf("HostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHostPinRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if LoadHostPin(dir) != "" {
		t.Fatal("expected empty pin initially")
	}
	if err := SaveHostPin(dir, "https://Forgejo.Example.EU"); err != nil {
		t.Fatal(err)
	}
	if got := LoadHostPin(dir); got != "https://forgejo.example.eu" {
		t.Fatalf("pin round-trip = %q", got)
	}
	info, err := os.Stat(filepath.Join(dir, hostPinFile))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("host pin perms = %o, want 600", perm)
	}
}
