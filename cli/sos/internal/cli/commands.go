// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"errors"
	"fmt"

	"github.com/sovereign-os/sos/internal/config"
	"github.com/sovereign-os/sos/internal/mcp"
	"github.com/sovereign-os/sos/internal/output"
	"github.com/sovereign-os/sos/internal/tokenstore"
	"github.com/spf13/cobra"
)

// mapCallError turns transport/governance errors into honest, actionable CLI errors.
// It never fakes success: 401 → "run sos login"; a governed deny → the server's hint.
func mapCallError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, mcp.ErrUnauthorized) {
		return fmt.Errorf("not authenticated (401) — run: sos login")
	}
	var te *mcp.ToolError
	if errors.As(err, &te) {
		if te.Forbidden() {
			return fmt.Errorf("denied by governance (403): %s\n%s", te.Reason, te.Hint)
		}
		return te
	}
	return err
}

func newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove stored tokens for a profile",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			name := profileFlag
			if name == "" {
				cfg, err := config.Load()
				if err != nil {
					return err
				}
				if cfg.Default != "" {
					name = cfg.Default
				} else {
					name = config.DefaultProfile
				}
			}
			dir, err := config.Dir()
			if err != nil {
				return err
			}
			if err := tokenstore.New(dir).Delete(name); err != nil {
				return err
			}
			fmt.Printf("Signed out of profile %q.\n", name)
			return nil
		},
	}
}

func newWhoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show your identity, role and domains",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := newSession(profileFlag)
			if err != nil {
				return err
			}
			raw, err := s.http.CallTool(cmd.Context(), "whoami", nil)
			if err != nil {
				return mapCallError(err)
			}
			fmt.Println(output.PrettyJSON(raw))
			return nil
		},
	}
}

func newDatasetsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "datasets",
		Short: "Work with governed datasets",
	}
	cmd.AddCommand(newDatasetsListCmd(), newDatasetsGetCmd())
	return cmd
}

func newDatasetsListCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List datasets you can see (via MCP list_datasets)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := newSession(profileFlag)
			if err != nil {
				return err
			}
			raw, err := s.http.CallTool(cmd.Context(), "list_datasets", nil)
			if err != nil {
				return mapCallError(err)
			}
			if jsonOut {
				fmt.Println(output.PrettyJSON(raw))
				return nil
			}
			table, err := output.DatasetsTable(raw)
			if err != nil {
				// Fall back to JSON rather than hide the data on an unexpected shape.
				fmt.Println(output.PrettyJSON(raw))
				return nil
			}
			fmt.Print(table)
			return nil
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "output raw JSON instead of a table")
	return cmd
}

func newDatasetsGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <dataset-id>",
		Short: "Show one dataset (via MCP get_dataset)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := newSession(profileFlag)
			if err != nil {
				return err
			}
			raw, err := s.http.CallTool(cmd.Context(), "get_dataset", map[string]any{"id": args[0]})
			if err != nil {
				return mapCallError(err)
			}
			fmt.Println(output.PrettyJSON(raw))
			return nil
		},
	}
}

func newQueryCmd() *cobra.Command {
	var metric bool
	cmd := &cobra.Command{
		Use:   "query <query>",
		Short: "Run a governed query (via MCP query_data, or --metric for query_metric)",
		Long: `query runs a governed query as you. By default it calls the MCP query_data tool
with your natural-language or SQL query; --metric calls query_metric with a metric id.
Results are printed as returned by the governed function; OPA + row-level security are
enforced server-side at the Trino/Cube layer.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := newSession(profileFlag)
			if err != nil {
				return err
			}
			tool, arg := "query_data", "query"
			if metric {
				tool, arg = "query_metric", "metric"
			}
			raw, err := s.http.CallTool(cmd.Context(), tool, map[string]any{arg: args[0]})
			if err != nil {
				return mapCallError(err)
			}
			fmt.Println(output.PrettyJSON(raw))
			return nil
		},
	}
	cmd.Flags().BoolVar(&metric, "metric", false, "treat the argument as a metric id (query_metric)")
	return cmd
}
