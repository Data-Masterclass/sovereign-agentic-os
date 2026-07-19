// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

package install

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Preflight is one prerequisite check. Name is what we print; Run returns a
// clear, actionable error (naming the exact missing tool) or nil.
type Preflight struct {
	Name string
	Run  func(ctx context.Context) error
}

// binExists reports whether a binary is on PATH.
func binExists(bin string) bool {
	_, err := exec.LookPath(bin)
	return err == nil
}

// Preflights returns the ordered checks for a cloud. Every check fails fast with
// a message naming the exact missing prerequisite (report §3 fail-fast guards).
// These are the checks the CLI CAN do offline; the deeper cluster-identity probe
// is best-effort (it needs a reachable cluster).
func Preflights(cloud Cloud) []Preflight {
	checks := []Preflight{
		{
			Name: "helm present",
			Run: func(context.Context) error {
				if !binExists("helm") {
					return fmt.Errorf("`helm` not found on PATH — install Helm 3 (https://helm.sh/docs/intro/install/)")
				}
				return nil
			},
		},
		{
			Name: "kubectl present",
			Run: func(context.Context) error {
				if !binExists("kubectl") {
					return fmt.Errorf("`kubectl` not found on PATH — install kubectl and point it at your cluster")
				}
				return nil
			},
		},
		{
			Name: "kubectl reachable (cluster responds)",
			Run: func(ctx context.Context) error {
				if !binExists("kubectl") {
					return nil // already reported above
				}
				cmd := exec.CommandContext(ctx, "kubectl", "version", "--request-timeout=10s", "-o", "json")
				if out, err := cmd.CombinedOutput(); err != nil {
					return fmt.Errorf("kubectl cannot reach a cluster — check your kubeconfig/context:\n%s", strings.TrimSpace(string(out)))
				}
				return nil
			},
		},
	}

	// Per-cloud CLI presence — the bootstrap script needs it. kind/stackit are
	// handled by the existing local/managed paths and need no cloud CLI here.
	switch cloud {
	case CloudGKE:
		checks = append(checks, cliCheck("gcloud", "Google Cloud SDK", "https://cloud.google.com/sdk/docs/install"))
	case CloudEKS:
		checks = append(checks, cliCheck("aws", "AWS CLI v2", "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"))
	case CloudAKS:
		checks = append(checks, cliCheck("az", "Azure CLI", "https://learn.microsoft.com/cli/azure/install-azure-cli"))
	}
	return checks
}

func cliCheck(bin, name, url string) Preflight {
	return Preflight{
		Name: fmt.Sprintf("%s present (%s)", bin, name),
		Run: func(context.Context) error {
			if !binExists(bin) {
				return fmt.Errorf("`%s` not found on PATH — install %s (%s)", bin, name, url)
			}
			return nil
		},
	}
}

// RunCommand streams a command to the given writer, prefixing nothing (the child
// writes its own output). It never logs the environment. Used for the bootstrap
// script + helm; both are secret-free on argv (auth is keyless / in kubeconfig).
func RunCommand(ctx context.Context, out, errOut *os.File, name string, args ...string) error {
	return RunCommandEnv(ctx, out, errOut, nil, name, args...)
}

// RunCommandEnv is RunCommand with extra env vars appended to the current
// environment. Callers pass only non-secret ids/regions/names (auth is keyless).
func RunCommandEnv(ctx context.Context, out, errOut *os.File, extraEnv []string, name string, args ...string) error {
	if !binExists(name) {
		return fmt.Errorf("`%s` not found on PATH", name)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = out
	cmd.Stderr = errOut
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s exited with error: %w", name, err)
	}
	return nil
}
