// SPDX-License-Identifier: Apache-2.0
// Package mcp is a thin JSON-RPC 2.0 client for the Sovereign OS governed MCP
// endpoint (POST <base>/api/mcp). It is a FRONT DOOR, not a back door: every call
// runs as the logged-in user and is OPA/DLS-checked server-side. The client only
// carries the bearer token and surfaces the server's typed errors honestly.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// protocolVersion matches MCP_PROTOCOL_VERSION in os-ui/lib/mcp/server.ts.
const protocolVersion = "2025-06-18"

// ErrUnauthorized signals a 401 from the MCP endpoint (token missing/expired/revoked).
var ErrUnauthorized = errors.New("unauthorized")

// ToolError is the server's structured, typed tool error (toolError in server.ts):
// { code, reason, hint }. code=="forbidden" is a governed OPA/role denial.
type ToolError struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
	Hint   string `json:"hint"`
}

func (e *ToolError) Error() string {
	if e.Hint != "" {
		return fmt.Sprintf("%s: %s (%s)", e.Code, e.Reason, e.Hint)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Reason)
}

// Forbidden reports whether this is a governance/role denial (403-equivalent).
func (e *ToolError) Forbidden() bool { return e.Code == "forbidden" }

// Client calls the MCP endpoint with a bearer token. TokenProvider lets it fetch a
// fresh (possibly refreshed) token per request without knowing storage details.
type Client struct {
	BaseURL string
	HTTP    *http.Client
	// Token returns the current bearer access token, refreshing if needed.
	Token func(ctx context.Context) (string, error)
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// toolCallResult is the shape of a tools/call result (ok(...) in server.ts):
// content[0].text carries the JSON string the governed function returned; isError
// flags a typed tool error whose payload is { error: {code, reason, hint} }.
type toolCallResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	IsError bool `json:"isError"`
}

// CallTool invokes an MCP tool and returns the raw JSON text the governed function
// produced. A governed denial is returned as a *ToolError.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (string, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.rpc(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return "", err
	}
	var res toolCallResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("decode tool result: %w", err)
	}
	text := ""
	if len(res.Content) > 0 {
		text = res.Content[0].Text
	}
	if res.IsError {
		return "", parseToolError(text)
	}
	return text, nil
}

// parseToolError unwraps { "error": {code, reason, hint} } into a *ToolError.
func parseToolError(text string) error {
	var wrap struct {
		Error ToolError `json:"error"`
	}
	if err := json.Unmarshal([]byte(text), &wrap); err == nil && wrap.Error.Code != "" {
		return &wrap.Error
	}
	if strings.TrimSpace(text) == "" {
		return errors.New("tool returned an error with no detail")
	}
	return errors.New(text)
}

func (c *Client) rpc(ctx context.Context, method string, params any) (json.RawMessage, error) {
	token, err := c.Token(ctx)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(c.BaseURL, "/") + "/api/mcp"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("MCP-Protocol-Version", protocolVersion)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MCP endpoint returned %s", resp.Status)
	}
	var rr rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return nil, fmt.Errorf("decode JSON-RPC response: %w", err)
	}
	if rr.Error != nil {
		return nil, fmt.Errorf("MCP error %d: %s", rr.Error.Code, rr.Error.Message)
	}
	return rr.Result, nil
}
