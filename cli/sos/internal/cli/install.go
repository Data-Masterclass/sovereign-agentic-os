// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sovereign-os/sos/internal/install"
	"github.com/spf13/cobra"
)

// installOpts are the flags for `sos install`. Everything here can ALSO be asked
// interactively; flags let CI / power users skip prompts (and drive --defaults).
type installOpts struct {
	cloud        string
	project      string
	account      string
	subscription string
	region       string
	bucket       string
	postgres     string
	llmReasoning string
	llmDefault   string
	llmEmbed     string
	knnDimension int
	domain       string
	tls          bool

	defaults bool // non-interactive: accept every default, no prompts
	dryRun   bool // emit values + planned commands, run nothing
	yes      bool // skip the final confirmation

	release   string
	namespace string
	chartPath string
	outFile   string // where to write install.yaml
	bootstrap string // dir holding bootstrap-<cloud>.sh
}

func newInstallCmd() *cobra.Command {
	o := &installOpts{}
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Interactive wizard to install the OS on GKE/EKS/AKS (or kind/stackit)",
		Long: `install is a frictionless wizard for standing up the Sovereign Agentic OS on
managed Kubernetes. It asks the minimal config (cloud, account/region, bucket,
Postgres mode, LLM tiers, optional domain), defaults everything else per cloud,
then: preflight -> per-cloud bootstrap (keyless identity + bucket + managed LLM)
-> helm upgrade --install with a generated install.yaml -> post-install health.

It is a THIN orchestrator: it shells out to the bootstrap scripts, kubectl and
helm — it never reimplements them, and it never writes or logs a secret (cloud
auth is keyless via Workload Identity / Pod Identity / Entra Workload ID).

  sos install                 # interactive
  sos install --defaults      # non-interactive (CI): accept every default
  sos install --dry-run       # print the install.yaml + planned commands only`,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runInstall(cmd.Context(), o)
		},
	}

	f := cmd.Flags()
	f.StringVar(&o.cloud, "cloud", "", "target cloud: gke|eks|aks|stackit|kind")
	f.StringVar(&o.project, "project", "", "GKE project id")
	f.StringVar(&o.account, "account", "", "AWS account id (EKS)")
	f.StringVar(&o.subscription, "subscription", "", "Azure/STACKIT subscription id")
	f.StringVar(&o.region, "region", "", "cloud region (defaulted per cloud)")
	f.StringVar(&o.bucket, "bucket", "", "object-storage bucket/container (generated if empty)")
	f.StringVar(&o.postgres, "postgres", "", "postgres mode: cnpg|plain|external (default cnpg on cloud)")
	f.StringVar(&o.llmReasoning, "llm-reasoning", "", "model id for the sovereign-reasoning tier")
	f.StringVar(&o.llmDefault, "llm-default", "", "model id for the sovereign-default tier")
	f.StringVar(&o.llmEmbed, "llm-embed", "", "model id for the sovereign-embed tier")
	f.IntVar(&o.knnDimension, "knn-dimension", 0, "vector dimension (must match the embed model)")
	f.StringVar(&o.domain, "domain", "", "base domain for ingress (optional)")
	f.BoolVar(&o.tls, "tls", false, "enable cert-manager TLS (requires --domain)")

	f.BoolVar(&o.defaults, "defaults", false, "non-interactive: accept every default")
	f.BoolVar(&o.dryRun, "dry-run", false, "print values + planned commands, run nothing")
	f.BoolVar(&o.yes, "yes", false, "skip the confirmation prompt")

	f.StringVar(&o.release, "release", "agentic-os", "helm release name")
	f.StringVar(&o.namespace, "namespace", "agentic-os", "kubernetes namespace")
	f.StringVar(&o.chartPath, "chart", "charts/sovereign-agentic-os", "path to the umbrella chart")
	f.StringVar(&o.outFile, "out", "install.yaml", "path to write the generated values overlay")
	f.StringVar(&o.bootstrap, "bootstrap-dir", "deploy/cloud", "directory holding bootstrap-<cloud>.sh")
	return cmd
}

// --- small terminal helpers (mirror install.sh's ask/ok style) --------------

func heading(s string) { fmt.Printf("\033[1;36m%s\033[0m\n", s) }
func okLine(s string)  { fmt.Printf("\033[1;32m✓ %s\033[0m\n", s) }
func warnLine(s string) { fmt.Printf("\033[1;33m! %s\033[0m\n", s) }

// ask prompts on stdin; returns def if the user just presses Enter. In
// --defaults mode it returns def without prompting.
func ask(r *bufio.Reader, q, def string, defaultsMode bool) string {
	if defaultsMode {
		return def
	}
	if def != "" {
		fmt.Printf("\033[1m%s\033[0m [%s]: ", q, def)
	} else {
		fmt.Printf("\033[1m%s\033[0m: ", q)
	}
	line, _ := r.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

// collectAnswers builds Answers from flags first, then fills gaps interactively
// (unless --defaults). It applies per-cloud defaults + validates before return.
func collectAnswers(o *installOpts) (install.Answers, error) {
	r := bufio.NewReader(os.Stdin)

	// 1. cloud — required, drives every default.
	cloudStr := o.cloud
	if cloudStr == "" {
		cloudStr = ask(r, "Target cloud (gke|eks|aks|stackit|kind)", "gke", o.defaults)
	}
	cloud, err := install.ParseCloud(cloudStr)
	if err != nil {
		return install.Answers{}, err
	}
	d, _ := install.DefaultsFor(cloud)

	a := install.Answers{Cloud: cloud}

	// 2. account scope (only the one this cloud uses).
	switch cloud {
	case install.CloudGKE:
		a.Project = o.project
		if a.Project == "" {
			a.Project = ask(r, "GKE project id", "", o.defaults)
		}
	case install.CloudEKS:
		a.Account = o.account
		if a.Account == "" {
			a.Account = ask(r, "AWS account id", "", o.defaults)
		}
	case install.CloudAKS:
		a.Subscription = o.subscription
		if a.Subscription == "" {
			a.Subscription = ask(r, "Azure subscription id", "", o.defaults)
		}
	case install.CloudStackit:
		a.Subscription = o.subscription
		if a.Subscription == "" {
			a.Subscription = ask(r, "STACKIT project id (optional)", "", o.defaults)
		}
	}

	// 3. region.
	a.Region = o.region
	if a.Region == "" {
		a.Region = ask(r, "Region", d.Region, o.defaults)
	}

	// 4. bucket (offer a generated default once we know the scope).
	if cloud != install.CloudKind {
		a.Bucket = o.bucket
		if a.Bucket == "" {
			// Pre-apply defaults to derive the suggested bucket name.
			tmp := a
			tmp.ApplyDefaults()
			a.Bucket = ask(r, "Warehouse bucket name", tmp.Bucket, o.defaults)
		}
	}

	// 5. postgres mode.
	pg := o.postgres
	if pg == "" {
		pg = ask(r, "Postgres mode (cnpg|plain|external)", string(d.Postgres), o.defaults)
	}
	a.Postgres = install.PostgresMode(pg)

	// LLM tiers — defaulted per cloud, overridable via flags/prompts.
	a.LLM.Reasoning = firstNonEmpty(o.llmReasoning, promptIf(r, "sovereign-reasoning model id", d.LLM.Reasoning, o.defaults))
	a.LLM.Default = firstNonEmpty(o.llmDefault, promptIf(r, "sovereign-default model id", d.LLM.Default, o.defaults))
	a.LLM.Embed = firstNonEmpty(o.llmEmbed, promptIf(r, "sovereign-embed model id", d.LLM.Embed, o.defaults))

	// knn dimension.
	if o.knnDimension > 0 {
		a.KNNDimension = o.knnDimension
	} else {
		dimStr := ask(r, "Embedding (kNN) dimension", strconv.Itoa(d.KNNDimension), o.defaults)
		n, convErr := strconv.Atoi(strings.TrimSpace(dimStr))
		if convErr != nil {
			return install.Answers{}, fmt.Errorf("kNN dimension %q is not a number", dimStr)
		}
		a.KNNDimension = n
	}

	// Optional domain/TLS.
	a.Domain = o.domain
	if a.Domain == "" && !o.defaults {
		a.Domain = ask(r, "Base domain for ingress (optional, blank = none)", "", false)
	}
	a.TLS = o.tls
	if a.Domain != "" && !o.tls && !o.defaults {
		a.TLS = strings.EqualFold(ask(r, "Enable TLS via cert-manager? (yes/no)", "yes", false), "yes")
	}

	a.ApplyDefaults()
	if err := a.Validate(); err != nil {
		return install.Answers{}, err
	}
	return a, nil
}

func promptIf(r *bufio.Reader, q, def string, defaultsMode bool) string {
	return ask(r, q, def, defaultsMode)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// runInstall is the whole flow: collect -> render -> (dry-run stop) -> preflight
// -> bootstrap -> helm -> health verify.
func runInstall(ctx context.Context, o *installOpts) error {
	heading("Sovereign Agentic OS — install wizard")
	fmt.Println("Minimal config; everything else is defaulted per cloud and validated.")
	fmt.Println()

	a, err := collectAnswers(o)
	if err != nil {
		return err
	}

	heading("\nPlanned install")
	fmt.Print(a.Summary())

	values := install.RenderInstallValues(a)

	bootstrapPath := bootstrapScriptFor(a.Cloud, o.bootstrap)
	planned := install.PlannedCommands(a, o.release, o.namespace, o.chartPath, bootstrapPath, o.outFile)

	fmt.Println("\nGenerated install.yaml:")
	fmt.Println("------------------------------------------------------------")
	fmt.Print(values)
	fmt.Println("------------------------------------------------------------")

	fmt.Println("\nPlanned commands:")
	for _, c := range planned {
		fmt.Printf("  $ %s\n", c)
	}

	if o.dryRun {
		okLine("\nDry run — nothing was executed. Re-run without --dry-run to apply.")
		return nil
	}

	// Confirm before touching the cluster.
	if !o.yes && !o.defaults {
		r := bufio.NewReader(os.Stdin)
		if !strings.EqualFold(ask(r, "\nProceed with install?", "no", false), "yes") {
			return fmt.Errorf("aborted by user")
		}
	}

	// Write install.yaml (0644 — no secrets; it is meant to be committed/inspected).
	if err := os.WriteFile(o.outFile, []byte(values), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", o.outFile, err)
	}
	okLine(fmt.Sprintf("Wrote %s", o.outFile))

	// --- Preflight ---
	heading("\nPreflight")
	for _, p := range install.Preflights(a.Cloud) {
		if err := p.Run(ctx); err != nil {
			return fmt.Errorf("preflight failed [%s]: %w", p.Name, err)
		}
		okLine(p.Name)
	}

	// --- Bootstrap (per-cloud irreducible prerequisites) ---
	if bootstrapPath != "" {
		heading(fmt.Sprintf("\nBootstrap (%s)", bootstrapPath))
		if _, statErr := os.Stat(bootstrapPath); statErr != nil {
			return fmt.Errorf("bootstrap script not found at %s — run from the repo root or pass --bootstrap-dir", bootstrapPath)
		}
		env := bootstrapEnv(a)
		fmt.Printf("Running: bash %s (env: %s)\n", bootstrapPath, strings.Join(redactKeys(env), " "))
		if err := runBootstrap(ctx, bootstrapPath, env); err != nil {
			return fmt.Errorf("bootstrap failed: %w", err)
		}
		okLine("Bootstrap complete")
	} else {
		warnLine(fmt.Sprintf("No cloud bootstrap for %q (local/managed path handles prerequisites)", a.Cloud))
	}

	// --- Helm install ---
	heading("\nHelm upgrade --install")
	helmArgs := install.HelmArgs(o.release, o.namespace, o.chartPath, a.ValuesFile(), o.outFile)
	fmt.Printf("Running: helm %s\n", strings.Join(helmArgs, " "))
	if err := install.RunCommand(ctx, os.Stdout, os.Stderr, "helm", helmArgs...); err != nil {
		return fmt.Errorf("helm install failed: %w", err)
	}
	okLine("Helm release applied")

	// --- Post-install health verify ---
	heading("\nHealth verify")
	if err := healthVerify(ctx, o.namespace); err != nil {
		return err
	}

	okLine("\nInstall complete.")
	fmt.Println("NOTE: the per-tier embed+chat smoke test (one embed + one chat per tier) runs")
	fmt.Println("inside the cluster via `helm test` — run it once the cluster is reachable:")
	fmt.Printf("  $ helm test %s -n %s\n", o.release, o.namespace)
	return nil
}

// bootstrapScriptFor returns the bootstrap script path for the cloud, or "" if
// none applies (kind/stackit use the existing local/managed paths).
func bootstrapScriptFor(c install.Cloud, dir string) string {
	switch c {
	case install.CloudGKE, install.CloudEKS, install.CloudAKS:
		return filepath.Join(dir, fmt.Sprintf("bootstrap-%s.sh", c))
	default:
		return ""
	}
}

// bootstrapEnv maps the answers to the env vars the bootstrap scripts read. NO
// secrets — only ids, regions and names (auth is keyless / from the cloud CLI).
func bootstrapEnv(a install.Answers) []string {
	env := []string{
		"SOS_REGION=" + a.Region,
		"SOS_BUCKET=" + a.Bucket,
		"SOS_LLM_REASONING=" + a.LLM.Reasoning,
		"SOS_LLM_DEFAULT=" + a.LLM.Default,
		"SOS_LLM_EMBED=" + a.LLM.Embed,
	}
	switch a.Cloud {
	case install.CloudGKE:
		env = append(env, "SOS_PROJECT="+a.Project)
	case install.CloudEKS:
		env = append(env, "SOS_ACCOUNT="+a.Account)
	case install.CloudAKS:
		env = append(env, "SOS_SUBSCRIPTION="+a.Subscription)
	}
	return env
}

// redactKeys returns just the KEY names (not values) for a safe echo of the env.
func redactKeys(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			out = append(out, kv[:i])
		}
	}
	return out
}

// runBootstrap execs `bash <script>` with the answer-derived env appended to the
// current environment, streaming output. Kept thin: the script does the work.
func runBootstrap(ctx context.Context, script string, extraEnv []string) error {
	return install.RunCommandEnv(ctx, os.Stdout, os.Stderr, extraEnv, "bash", script)
}

// healthVerify polls pods to Ready and reports honestly what could not be done
// offline. The full per-tier embed+chat smoke test lives in `helm test` (it
// needs in-cluster network to hit LiteLLM) — we point the operator at it rather
// than pretend the CLI can run it from outside.
func healthVerify(ctx context.Context, namespace string) error {
	// A best-effort readiness wait: pods should already be Ready after helm --wait,
	// this surfaces any that are not with a clear message.
	err := install.RunCommand(ctx, os.Stdout, os.Stderr,
		"kubectl", "wait", "--for=condition=Ready", "pods", "--all",
		"-n", namespace, "--timeout=300s")
	if err != nil {
		return fmt.Errorf("some pods did not become Ready in the namespace %q — inspect with `kubectl get pods -n %s`: %w", namespace, namespace, err)
	}
	okLine("All pods Ready")
	warnLine("Per-tier embed+chat smoke test is a TODO for the CLI (needs in-cluster network) — run `helm test`.")
	return nil
}
