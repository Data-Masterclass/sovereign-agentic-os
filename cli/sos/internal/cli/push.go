// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/sovereign-os/sos/internal/mcp"
	"github.com/sovereign-os/sos/internal/push"
	"github.com/spf13/cobra"
)

// pushOpts are the flags for `sos push`.
type pushOpts struct {
	app     string
	dir     string
	message string
	dryRun  bool
	promote bool
	yes     bool
}

func newPushCmd() *cobra.Command {
	o := &pushOpts{}
	cmd := &cobra.Command{
		Use:   "push",
		Short: "Push a local app/analytics working dir through the governed commit path",
		Long: `push takes a local working directory of app or analytics source (dbt models,
Cube YAML, app code), diffs it against the app's current governed tree, and submits
the changed files through the governed 'commit' MCP tool — AS you, the authenticated
user. It is a real governed change request, the same one the Software tab UI makes,
not a raw git push. OPA policy, role and row/document security are enforced
server-side; a denial surfaces clearly.

  sos push --app app_123 --dir ./my-app --dry-run     # preview the diff only
  sos push --app app_123 --dir ./my-app -m "add model"# submit the changeset
  sos push --app app_123 --dir ./my-app --promote     # + file a promotion request

push never deletes governed files: it merges a changeset over the prior tree, so a
file present in the app but absent locally is left untouched.`,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPush(cmd.Context(), o)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.app, "app", "", "target governed app id (from `sos` / list_software) [required]")
	f.StringVar(&o.dir, "dir", ".", "local working directory to push")
	f.StringVarP(&o.message, "message", "m", "", "commit message")
	f.BoolVar(&o.dryRun, "dry-run", false, "compute and preview the diff; submit nothing")
	f.BoolVar(&o.promote, "promote", false, "after a successful push, file a promotion request")
	f.BoolVar(&o.yes, "yes", false, "skip the pre-submit confirmation prompt")
	return cmd
}

func runPush(ctx context.Context, o *pushOpts) error {
	if strings.TrimSpace(o.app) == "" {
		return fmt.Errorf("--app is required (which governed app to push to)")
	}

	// 1. Walk the local working dir into {path: content}.
	local, err := push.WalkDir(o.dir)
	if err != nil {
		return err
	}

	s, err := newSession(profileFlag)
	if err != nil {
		return err
	}

	// 2. Fetch the app's current governed tree and diff against it.
	remote, err := fetchAppTree(ctx, s.http, o.app)
	if err != nil {
		return mapCallError(err)
	}
	changes, changed := push.Diff(local, remote)

	// 3. Preview.
	fmt.Print(push.Summary(changes))
	if o.dryRun {
		fmt.Println("(dry run — nothing submitted)")
		return nil
	}

	args, err := push.BuildCommit(o.app, o.message, changed)
	if err != nil {
		return err
	}

	// 4. Confirm, then submit through the governed commit tool.
	if !o.yes {
		ok, err := confirm(fmt.Sprintf("Submit %d file(s) to app %s through governed commit?", len(changed), o.app))
		if err != nil {
			return err
		}
		if !ok {
			fmt.Println("Aborted.")
			return nil
		}
	}

	if _, err := s.http.CallTool(ctx, "commit", args.ToMap()); err != nil {
		return mapCallError(err)
	}
	fmt.Println("Committed through the governed path.")

	// 5. Optionally file a promotion request (a creator files; a builder approves).
	if o.promote {
		if err := requestPromotion(ctx, s.http, o.app); err != nil {
			return mapCallError(err)
		}
		fmt.Println("Promotion requested — a builder in your domain must approve it.")
	}
	return nil
}

// fetchAppTree reconstructs the app's current governed file tree as {path: content}
// via the governed read_app_files tool: one call for the path list, then one call
// per path for its content. Runs as the logged-in user; DLS/OPA apply.
func fetchAppTree(ctx context.Context, c *mcp.Client, appID string) (map[string]string, error) {
	raw, err := c.CallTool(ctx, "read_app_files", map[string]any{"appId": appID})
	if err != nil {
		return nil, err
	}
	var tree struct {
		Files []string `json:"files"`
	}
	if err := json.Unmarshal([]byte(raw), &tree); err != nil {
		return nil, fmt.Errorf("decode app file tree: %w", err)
	}
	out := make(map[string]string, len(tree.Files))
	for _, p := range tree.Files {
		fileRaw, err := c.CallTool(ctx, "read_app_files", map[string]any{"appId": appID, "path": p})
		if err != nil {
			return nil, err
		}
		var f struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal([]byte(fileRaw), &f); err != nil {
			return nil, fmt.Errorf("decode file %q: %w", p, err)
		}
		out[p] = f.Content
	}
	return out, nil
}

// requestPromotion files an app promotion request through the governed
// request_promotion tool (kind=app). The CLI cannot self-approve.
func requestPromotion(ctx context.Context, c *mcp.Client, appID string) error {
	_, err := c.CallTool(ctx, "request_promotion", map[string]any{"kind": "app", "id": appID})
	return err
}

// confirm prompts on stdin for a yes/no. Defaults to no on empty/EOF so an
// accidental pipe never submits a governed change unattended.
func confirm(prompt string) (bool, error) {
	fmt.Printf("%s [y/N]: ", prompt)
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadString('\n')
	if err != nil && line == "" {
		return false, nil
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	default:
		return false, nil
	}
}
