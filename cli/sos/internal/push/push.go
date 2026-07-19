// SPDX-License-Identifier: Apache-2.0
// Package push holds the PURE logic for `sos push`: walking a local working dir
// into a changeset, diffing it against the app's current governed tree, and
// building the `commit` MCP tool arguments. It performs NO I/O of its own (the
// caller supplies the local files and the remote tree) and knows NOTHING about
// tokens — so it is directly unit-testable and cannot bypass governance. The
// actual submission goes through the same governed `commit` MCP tool the UI uses.
package push

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// File is one path→content pair, matching the governed `commit` tool's file item
// ({ path, content }) exactly.
type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// ChangeKind classifies how a file differs from the remote tree.
type ChangeKind string

const (
	Added     ChangeKind = "add"
	Modified  ChangeKind = "modify"
	Unchanged ChangeKind = "unchanged"
)

// Change is one file's diff status against the current app tree.
type Change struct {
	Path string
	Kind ChangeKind
}

// Diff compares the local working set against the remote tree (both keyed by
// path) and returns, sorted by path: the per-file change classification and the
// subset of files that actually changed (added or modified) — the changeset to
// submit. Deletions are intentionally NOT synthesised: the governed `commit`
// tool merges a changeset over the prior tree, so omitting a file leaves it
// untouched; `sos push` never silently deletes governed files.
func Diff(local, remote map[string]string) (changes []Change, changed []File) {
	paths := make([]string, 0, len(local))
	for p := range local {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	for _, p := range paths {
		content := local[p]
		prev, existed := remote[p]
		switch {
		case !existed:
			changes = append(changes, Change{Path: p, Kind: Added})
			changed = append(changed, File{Path: p, Content: content})
		case prev != content:
			changes = append(changes, Change{Path: p, Kind: Modified})
			changed = append(changed, File{Path: p, Content: content})
		default:
			changes = append(changes, Change{Path: p, Kind: Unchanged})
		}
	}
	return changes, changed
}

// CommitArgs is the argument map for the governed `commit` MCP tool. Field names
// match os-ui/lib/mcp/server.ts exactly: appId (required), message, files.
type CommitArgs struct {
	AppID   string `json:"appId"`
	Message string `json:"message"`
	Files   []File `json:"files"`
}

// ToMap renders CommitArgs as the map[string]any the MCP client sends. Only
// non-empty optional fields are included, matching how the UI omits blanks.
func (a CommitArgs) ToMap() map[string]any {
	files := make([]map[string]any, len(a.Files))
	for i, f := range a.Files {
		files[i] = map[string]any{"path": f.Path, "content": f.Content}
	}
	m := map[string]any{"appId": a.AppID, "files": files}
	if a.Message != "" {
		m["message"] = a.Message
	}
	return m
}

// BuildCommit validates inputs and assembles the commit arguments from a diff.
// It returns an error (not a silent no-op) when there is nothing to push, so the
// CLI can exit honestly rather than submit an empty governed change.
func BuildCommit(appID, message string, changed []File) (CommitArgs, error) {
	if strings.TrimSpace(appID) == "" {
		return CommitArgs{}, fmt.Errorf("app id is required (which governed app to push to)")
	}
	if len(changed) == 0 {
		return CommitArgs{}, fmt.Errorf("no changes to push — local working dir matches the app's current tree")
	}
	return CommitArgs{AppID: appID, Message: message, Files: changed}, nil
}

// Summary renders a human-readable preview of a diff (for --dry-run and the
// pre-submit confirmation). Pure: string in, string out.
func Summary(changes []Change) string {
	var b strings.Builder
	nAdd, nMod := 0, 0
	for _, c := range changes {
		switch c.Kind {
		case Added:
			fmt.Fprintf(&b, "  add     %s\n", c.Path)
			nAdd++
		case Modified:
			fmt.Fprintf(&b, "  modify  %s\n", c.Path)
			nMod++
		case Unchanged:
			// Omit unchanged files from the preview to keep it signal-only.
		}
	}
	if nAdd == 0 && nMod == 0 {
		return "No changes: local working dir matches the app's current tree.\n"
	}
	fmt.Fprintf(&b, "%d file(s) to push: %d added, %d modified.\n", nAdd+nMod, nAdd, nMod)
	return b.String()
}

// NormalizePath makes a slash-separated relative path safe and stable for the
// governed tree: no leading "./", no absolute or parent-escaping paths. The
// caller (I/O layer) is responsible for converting OS separators to slashes
// (filepath.ToSlash) before calling this. It returns an error for anything that
// would write outside the app tree.
func NormalizePath(rel string) (string, error) {
	p := path.Clean(rel)
	if p == "." || p == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.HasPrefix(p, "../") || p == ".." {
		return "", fmt.Errorf("path escapes working dir: %q", rel)
	}
	if strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("absolute path not allowed in a governed changeset: %q", rel)
	}
	return p, nil
}
