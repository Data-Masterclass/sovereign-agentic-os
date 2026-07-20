// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/sovereign-os/sos/internal/config"
	"github.com/sovereign-os/sos/internal/git"
	"github.com/sovereign-os/sos/internal/oauth"
	"github.com/spf13/cobra"
)

// newGitCmd builds `sos git`: the credential-helper bridge that lets raw
// `git clone/pull/push` against the governed Forgejo host work AS the logged-in
// user, using a short-lived, server-minted, domain-scoped token.
func newGitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "git",
		Short: "Governed git access: credential helper + setup for the Forgejo host",
		Long: `git bridges raw git to the governed Forgejo host. It implements git's
credential-helper protocol: when git needs a password for the Forgejo host, it asks
'sos git credential get', which mints a short-lived, domain-scoped token server-side
AS you and hands it to git. Tokens are never stored long-term — only cached in a
0600 file until they expire, then transparently re-minted.

  sos git setup                 configure git to use this helper for the Forgejo host
  sos clone <repo>              clone a governed repo (runs setup implicitly)
  sos git credential <action>   (invoked by git; not for direct use)`,
	}
	cmd.AddCommand(newGitCredentialCmd(), newGitSetupCmd())
	return cmd
}

// gitCacheDir is the per-profile directory holding the TTL-bounded credential cache
// and the (non-secret) Forgejo host pin. It lives under the config dir, 0700.
func gitCacheDir(profileName string) (string, error) {
	dir, err := config.Dir()
	if err != nil {
		return "", err
	}
	if profileName == "" {
		profileName = config.DefaultProfile
	}
	return filepath.Join(dir, "git-cache", profileName), nil
}

// newHelper assembles the pure git.Helper for a profile: an HTTP minter bound to the
// profile's OS endpoint (authenticating with the same refreshed session token as
// every other verb) plus the TTL-bounded on-disk cache, pinned to the Forgejo host
// learned at setup.
func newHelper(profileName string) (*git.Helper, string, error) {
	s, err := newSession(profileName)
	if err != nil {
		return nil, "", err
	}
	dir, err := gitCacheDir(s.profileName)
	if err != nil {
		return nil, "", err
	}
	h := &git.Helper{
		ForgejoHost: git.LoadHostPin(dir),
		Minter: &git.HTTPMinter{
			BaseURL: s.profile.BaseURL,
			HTTP:    oauth.DefaultHTTPClient(),
			Token:   s.token,
		},
		Cache: git.NewCache(dir),
	}
	return h, dir, nil
}

func newGitCredentialCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "credential <get|store|erase>",
		Short:  "git credential-helper backend (invoked by git, not by hand)",
		Args:   cobra.ExactArgs(1),
		Hidden: true, // git calls this; it is not a user-facing verb
		// The credential protocol speaks raw stdin/stdout; suppress cobra's usage
		// noise so nothing but the credential block reaches git on stdout.
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			h, _, err := newHelper(profileFlag)
			if err != nil {
				return err
			}
			return h.Dispatch(cmd.Context(), args[0], cmd.InOrStdin(), cmd.OutOrStdout())
		},
	}
}

func newGitSetupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Configure git to use sos as the credential helper for the Forgejo host",
		Long: `setup mints one token to learn the Forgejo host for your OS instance, records
it, and writes a git config entry so raw 'git clone/pull/push' against that host
authenticate through 'sos git credential' as you. Run it once per machine/profile.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			host, err := runGitSetup(cmd.Context(), profileFlag)
			if err != nil {
				return err
			}
			fmt.Printf("Configured git credential helper for %s (profile %q).\n", host, orDefault(profileFlag))
			return nil
		},
	}
}

// runGitSetup mints once to discover the Forgejo host, pins it for the helper, and
// installs the per-host git credential.helper config pointing at this sos binary.
// It returns the configured host.
func runGitSetup(ctx context.Context, profileName string) (string, error) {
	h, dir, err := newHelper(profileName)
	if err != nil {
		return "", err
	}
	// One mint learns forgejoBaseUrl (and warms the cache for the first git call).
	resp, err := h.Minter.Mint(ctx)
	if err != nil {
		return "", err
	}
	host := git.HostOf(resp.ForgejoBaseURL)
	if host == "" {
		return "", fmt.Errorf("mint response did not include a forgejoBaseUrl to configure git against")
	}
	if err := git.SaveHostPin(dir, host); err != nil {
		return "", err
	}
	if err := configureGitHelper(host, profileName); err != nil {
		return "", err
	}
	return host, nil
}

// configureGitHelper writes `git config --global credential.<host>.helper` so git
// invokes `sos git credential` for that host. It scopes the helper to the exact
// Forgejo host so no other host's credentials ever route through us.
func configureGitHelper(host, profileName string) error {
	self, err := os.Executable()
	if err != nil || self == "" {
		self = "sos" // fall back to PATH lookup if the abs path is unavailable
	}
	// git resolves `!<cmd>` as a shell command; pass the profile through so the
	// helper targets the same OS instance the user set up.
	helper := fmt.Sprintf("!%q git credential", self)
	if profileName != "" {
		helper = fmt.Sprintf("!%q --profile %s git credential", self, profileName)
	}
	key := fmt.Sprintf("credential.%s.helper", host)
	// Empty-string reset first so re-running setup replaces rather than stacks
	// helpers (git accumulates multi-valued helper entries otherwise).
	if err := runGit("config", "--global", "--replace-all", key, ""); err != nil {
		return err
	}
	return runGit("config", "--global", "--add", key, helper)
}

// runGit runs a git subcommand, surfacing git's own stderr on failure. It never
// handles a token — only config plumbing.
func runGit(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

// newCloneCmd builds `sos clone <repo>`: ensure the credential helper is configured,
// then run `git clone` against the Forgejo host so it just works as the real user.
func newCloneCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clone <repo> [dir]",
		Short: "Clone a governed repo, configuring the credential helper if needed",
		Long: `clone configures the governed git credential helper (if not already set) and
runs 'git clone' against the Forgejo host. <repo> may be a full URL or an
'owner/name' shorthand resolved against your instance's Forgejo host.

  sos clone analytics
  sos clone myteam/analytics ./analytics`,
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runClone(cmd.Context(), profileFlag, args)
		},
	}
}

func runClone(ctx context.Context, profileName string, args []string) error {
	dir, err := gitCacheDir(orDefault(profileName))
	if err != nil {
		return err
	}
	host := git.LoadHostPin(dir)
	if host == "" {
		// First use: learn + configure the host.
		if host, err = runGitSetup(ctx, profileName); err != nil {
			return err
		}
	}
	repo := resolveRepoURL(host, args[0])
	gitArgs := append([]string{"clone", repo}, args[1:]...)
	return runGit(gitArgs...)
}

// resolveRepoURL turns a repo argument into a clone URL. A full URL passes through;
// an 'owner/name' or bare 'name' shorthand is joined onto the Forgejo host.
func resolveRepoURL(host, repo string) string {
	if strings.Contains(repo, "://") {
		return repo
	}
	repo = strings.TrimPrefix(repo, "/")
	if !strings.HasSuffix(repo, ".git") {
		repo += ".git"
	}
	return strings.TrimRight(host, "/") + "/" + repo
}

func orDefault(profileName string) string {
	if profileName == "" {
		return config.DefaultProfile
	}
	return profileName
}
