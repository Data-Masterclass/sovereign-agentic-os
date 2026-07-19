// SPDX-License-Identifier: Apache-2.0
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func staticToken(_ context.Context) (string, error) { return "test-token", nil }

// rpcServer builds a test MCP endpoint that returns the given tools/call result body
// (the value placed under result), or a 401 when status is set.
func newClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &Client{BaseURL: srv.URL, HTTP: srv.Client(), Token: staticToken}
}

func TestCallToolSuccessUnwrapsText(t *testing.T) {
	c := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("missing bearer: %q", got)
		}
		if got := r.Header.Get("MCP-Protocol-Version"); got != protocolVersion {
			t.Errorf("protocol header = %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []map[string]any{{"type": "text", "text": `{"ok":true}`}},
			},
		})
	})
	got, err := c.CallTool(context.Background(), "whoami", nil)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if got != `{"ok":true}` {
		t.Fatalf("unwrapped text = %q", got)
	}
}

func TestCallToolUnauthorized(t *testing.T) {
	c := newClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	_, err := c.CallTool(context.Background(), "whoami", nil)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized, got %v", err)
	}
}

func TestCallToolForbiddenIsTypedError(t *testing.T) {
	c := newClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"isError": true,
				"content": []map[string]any{{"type": "text",
					"text": `{"error":{"code":"forbidden","reason":"needs builder","hint":"ask a builder"}}`}},
			},
		})
	})
	_, err := c.CallTool(context.Background(), "promote", nil)
	var te *ToolError
	if !errors.As(err, &te) {
		t.Fatalf("expected *ToolError, got %v", err)
	}
	if !te.Forbidden() || te.Reason != "needs builder" {
		t.Fatalf("unexpected tool error: %+v", te)
	}
}

func TestParseToolError(t *testing.T) {
	err := parseToolError(`{"error":{"code":"not_found","reason":"no such id","hint":"check id"}}`)
	var te *ToolError
	if !errors.As(err, &te) || te.Code != "not_found" {
		t.Fatalf("parseToolError structured = %v", err)
	}
	// Non-structured text falls back to a plain error.
	if e := parseToolError("boom"); e == nil || e.Error() != "boom" {
		t.Fatalf("plain fallback = %v", e)
	}
}
