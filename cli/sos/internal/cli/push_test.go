// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sovereign-os/sos/internal/mcp"
)

// mcpToolServer builds a test MCP endpoint that dispatches tools/call by tool
// name to the given responders, each returning the JSON text a governed tool
// would produce.
func mcpToolServer(t *testing.T, responders map[string]func(args map[string]any) string) *mcp.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		fn, ok := responders[req.Params.Name]
		if !ok {
			t.Fatalf("unexpected tool call: %q", req.Params.Name)
		}
		text := fn(req.Params.Arguments)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
			},
		})
	}))
	t.Cleanup(srv.Close)
	return &mcp.Client{
		BaseURL: srv.URL,
		HTTP:    srv.Client(),
		Token:   func(context.Context) (string, error) { return "t", nil },
	}
}

func TestFetchAppTreeReconstructsMap(t *testing.T) {
	files := map[string]string{
		"app.yaml":     "name: shop\n",
		"src/index.ts": "export const x = 1\n",
	}
	client := mcpToolServer(t, map[string]func(map[string]any) string{
		"read_app_files": func(args map[string]any) string {
			// Tree listing when no path; single-file read when path present.
			if p, ok := args["path"].(string); ok {
				b, _ := json.Marshal(map[string]any{"appId": args["appId"], "path": p, "content": files[p]})
				return string(b)
			}
			b, _ := json.Marshal(map[string]any{"appId": args["appId"], "files": []string{"app.yaml", "src/index.ts"}})
			return string(b)
		},
	})

	got, err := fetchAppTree(context.Background(), client, "app_1")
	if err != nil {
		t.Fatalf("fetchAppTree: %v", err)
	}
	if len(got) != 2 || got["app.yaml"] != files["app.yaml"] || got["src/index.ts"] != files["src/index.ts"] {
		t.Fatalf("reconstructed tree wrong: %v", got)
	}
}

func TestFetchAppTreeSurfacesForbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"isError": true,
				"content": []map[string]any{{"type": "text",
					"text": `{"error":{"code":"forbidden","reason":"no access to app","hint":"ask the owner"}}`}},
			},
		})
	}))
	t.Cleanup(srv.Close)
	client := &mcp.Client{BaseURL: srv.URL, HTTP: srv.Client(), Token: func(context.Context) (string, error) { return "t", nil }}

	_, err := fetchAppTree(context.Background(), client, "app_1")
	if err == nil {
		t.Fatal("expected a governed denial to surface")
	}
	// mapCallError turns it into a clear governance message.
	mapped := mapCallError(err)
	if mapped == nil || !contains(mapped.Error(), "denied by governance") {
		t.Fatalf("expected governance-denied error, got: %v", mapped)
	}
}

func TestPushCommandRequiresApp(t *testing.T) {
	// Arg validation must fire before any network/IO.
	err := runPush(context.Background(), &pushOpts{app: "  ", dir: "."})
	if err == nil {
		t.Fatal("expected error when --app is missing")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
