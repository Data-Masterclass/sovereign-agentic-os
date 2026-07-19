// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"github.com/spf13/cobra"
)

// profileFlag is the shared --profile value (like `aws --profile`).
var profileFlag string

// NewRootCmd builds the `sos` command tree.
func NewRootCmd(version string) *cobra.Command {
	root := &cobra.Command{
		Use:   "sos",
		Short: "Governed developer CLI for the Sovereign Agentic OS",
		Long: `sos is a thin, governed client for the Sovereign Agentic OS.

Every command runs AS the logged-in user through the OS MCP front door — the same
governed path as the UI. The CLI holds only a short-lived OAuth token; role, domains,
OPA policy and row/document security are re-resolved live on the server for every call.

Use --profile to target multiple OS instances (like aws profiles).`,
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().StringVar(&profileFlag, "profile", "", "config profile (OS instance) to use")

	root.AddCommand(
		newLoginCmd(),
		newLogoutCmd(),
		newWhoamiCmd(),
		newDatasetsCmd(),
		newQueryCmd(),
		newPushCmd(),
		newInstallCmd(),
	)
	return root
}
