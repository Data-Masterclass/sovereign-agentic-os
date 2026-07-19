// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

// Package install holds the pure logic for `sos install`: the minimal set of
// admin answers, their validation + defaulting, and the render of a small
// install.yaml values overlay. It deliberately contains NO I/O and NO shelling
// out — the cobra command in internal/cli is the thin orchestrator that runs
// preflight, the per-cloud bootstrap script, `helm upgrade --install` and the
// post-install health verify around this package. Keeping the decisions here
// makes them unit-testable without a cloud cluster (see answers_test.go /
// values_test.go), which matters because the flow cannot be live-verified.
package install

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Cloud is the target platform. `kind` is the local escape hatch (no cloud
// identity/bucket bootstrap); `stackit` reuses the existing managed overlay.
type Cloud string

const (
	CloudGKE     Cloud = "gke"
	CloudEKS     Cloud = "eks"
	CloudAKS     Cloud = "aks"
	CloudStackit Cloud = "stackit"
	CloudKind    Cloud = "kind"
)

// Clouds is the enum, in menu order, for prompts + validation messages.
var Clouds = []Cloud{CloudGKE, CloudEKS, CloudAKS, CloudStackit, CloudKind}

// PostgresMode is the datastore engine. cnpg = bundled CloudNativePG (the cloud
// default, per the report §1); plain = self-contained StatefulSet (the local /
// STACKIT default); external = a managed Postgres the admin points us at.
type PostgresMode string

const (
	PostgresCNPG     PostgresMode = "cnpg"
	PostgresPlain    PostgresMode = "plain"
	PostgresExternal PostgresMode = "external"
)

// LLMTier holds the three model ids LiteLLM aliases route to. These are the ONLY
// model-shaped inputs; everything else about serving is wired by the overlay.
type LLMTier struct {
	Reasoning string `yaml:"reasoning"` // -> sovereign-reasoning
	Default   string `yaml:"default"`   // -> sovereign-default
	Embed     string `yaml:"embed"`     // -> sovereign-embed
}

// Answers is the MINIMAL config an admin supplies: 3–5 real inputs, everything
// else defaulted from the cloud and validated. It is what gets written to
// install.yaml (never any secret) and what the values render consumes.
type Answers struct {
	Cloud Cloud `yaml:"cloud"`

	// Cloud account scope. Exactly one is used per cloud (project=GKE,
	// account=EKS, subscription=AKS/stackit); kind ignores all three.
	Project      string `yaml:"project,omitempty"`      // GKE project id
	Account      string `yaml:"account,omitempty"`      // EKS AWS account id
	Subscription string `yaml:"subscription,omitempty"` // AKS/stackit subscription id

	Region string `yaml:"region"`

	// Bucket is the object-storage bucket/container that holds the warehouse +
	// Postgres WAL archive. Defaulted from the account scope if left blank.
	Bucket string `yaml:"bucket"`

	Postgres PostgresMode `yaml:"postgres"`

	LLM LLMTier `yaml:"llm"`

	// KNNDimension pins the vector dimension (must match the embed model). A
	// mismatch forces an OpenSearch reindex, so we pin it per install.
	KNNDimension int `yaml:"knnDimension"`

	// Domain/TLS are optional; empty means "no ingress host / use cluster IP".
	Domain string `yaml:"domain,omitempty"`
	TLS    bool   `yaml:"tls,omitempty"`
}

// CloudDefaults captures the report §2 per-cloud pins so the wizard only has to
// ask for the account scope + region and can fill the rest. Fields are exported
// so the cobra command (another package) can offer them as prompt defaults.
type CloudDefaults struct {
	Region       string
	LLM          LLMTier
	KNNDimension int
	Postgres     PostgresMode
}

// defaultsByCloud mirrors docs/research/cloud-install-gke-eks-aks.md §2. The
// model ids are the report's recommended tier pins and are overridable.
var defaultsByCloud = map[Cloud]CloudDefaults{
	CloudGKE: {
		Region: "us-central1",
		LLM: LLMTier{
			Reasoning: "gemini-3.1-pro",
			Default:   "gemini-2.5-flash",
			Embed:     "gemini-embedding-001",
		},
		KNNDimension: 3072,
		Postgres:     PostgresCNPG,
	},
	CloudEKS: {
		Region: "us-east-1",
		LLM: LLMTier{
			Reasoning: "us.anthropic.claude-sonnet-4-5",
			Default:   "us.amazon.nova-pro",
			Embed:     "amazon.titan-embed-text-v2",
		},
		KNNDimension: 1024, // Titan v2 default dim
		Postgres:     PostgresCNPG,
	},
	CloudAKS: {
		Region: "eastus",
		LLM: LLMTier{
			Reasoning: "gpt-5.4",
			Default:   "gpt-5.4-mini",
			Embed:     "text-embedding-3-large",
		},
		KNNDimension: 3072,
		Postgres:     PostgresCNPG,
	},
	CloudStackit: {
		Region: "eu01",
		LLM: LLMTier{
			Reasoning: "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8",
			Default:   "gpt-oss-20b",
			Embed:     "Qwen/Qwen3-VL-Embedding-8B",
		},
		KNNDimension: 4096,
		Postgres:     PostgresPlain, // STACKIT SNA networking hangs CNPG initdb
	},
	CloudKind: {
		Region: "local",
		LLM: LLMTier{
			Reasoning: "sovereign-mock",
			Default:   "sovereign-mock",
			Embed:     "sovereign-mock",
		},
		KNNDimension: 768,
		Postgres:     PostgresPlain,
	},
}

// DefaultsFor returns the per-cloud defaults, or false if the cloud is unknown.
func DefaultsFor(c Cloud) (CloudDefaults, bool) {
	d, ok := defaultsByCloud[c]
	return d, ok
}

// ParseCloud validates + normalises a cloud string.
func ParseCloud(s string) (Cloud, error) {
	c := Cloud(strings.ToLower(strings.TrimSpace(s)))
	if _, ok := defaultsByCloud[c]; ok {
		return c, nil
	}
	return "", fmt.Errorf("unknown cloud %q — must be one of: %s", s, cloudList())
}

func cloudList() string {
	out := make([]string, len(Clouds))
	for i, c := range Clouds {
		out[i] = string(c)
	}
	return strings.Join(out, ", ")
}

// scopeField returns the account-scope value the given cloud actually uses, plus
// a human label for error messages. kind/stackit have no required scope.
func (a Answers) scopeField() (value, label string, required bool) {
	switch a.Cloud {
	case CloudGKE:
		return a.Project, "project (GKE project id)", true
	case CloudEKS:
		return a.Account, "account (AWS account id)", true
	case CloudAKS:
		return a.Subscription, "subscription (Azure subscription id)", true
	case CloudStackit:
		return a.Subscription, "subscription (STACKIT project id)", false
	default: // kind
		return "", "", false
	}
}

// bucketRe is a conservative DNS-safe bucket/container name (works across S3,
// GCS and ADLS container naming). Lowercase alnum + single hyphens, 3–63 chars.
var bucketRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)

// regionRe keeps regions to the shapes the three clouds use (no spaces/slashes).
var regionRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}$`)

// ApplyDefaults fills every unset field from the per-cloud defaults. It is
// idempotent and MUST run before Validate/Render. It never overrides a value the
// admin supplied (so `--set`/prompt answers win).
func (a *Answers) ApplyDefaults() {
	d, ok := defaultsByCloud[a.Cloud]
	if !ok {
		return // Validate will reject the unknown cloud
	}
	if a.Region == "" {
		a.Region = d.Region
	}
	if a.Postgres == "" {
		a.Postgres = d.Postgres
	}
	if a.LLM.Reasoning == "" {
		a.LLM.Reasoning = d.LLM.Reasoning
	}
	if a.LLM.Default == "" {
		a.LLM.Default = d.LLM.Default
	}
	if a.LLM.Embed == "" {
		a.LLM.Embed = d.LLM.Embed
	}
	if a.KNNDimension == 0 {
		a.KNNDimension = d.KNNDimension
	}
	if a.Bucket == "" {
		a.Bucket = a.defaultBucket()
	}
}

// defaultBucket derives a deterministic, DNS-safe default bucket name from the
// account scope so re-running the wizard is stable. Falls back to the cloud name.
func (a Answers) defaultBucket() string {
	scope, _, _ := a.scopeField()
	seed := sanitiseSeed(scope)
	if seed == "" {
		seed = string(a.Cloud)
	}
	name := fmt.Sprintf("sovereign-os-%s", seed)
	if len(name) > 63 {
		name = name[:63]
	}
	return strings.Trim(name, "-")
}

// sanitiseSeed lowercases and strips a scope id down to bucket-safe characters.
func sanitiseSeed(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// Validate returns the FIRST honest, actionable error (naming the exact missing
// or bad field) or nil. Run after ApplyDefaults.
func (a Answers) Validate() error {
	if _, ok := defaultsByCloud[a.Cloud]; !ok {
		return fmt.Errorf("cloud is required — must be one of: %s", cloudList())
	}
	if v, label, required := a.scopeField(); required && strings.TrimSpace(v) == "" {
		return fmt.Errorf("%s is required for cloud %q", label, a.Cloud)
	}
	if a.Region == "" {
		return fmt.Errorf("region is required for cloud %q", a.Cloud)
	}
	if !regionRe.MatchString(a.Region) {
		return fmt.Errorf("region %q is not a valid region name (lowercase letters, digits, hyphens)", a.Region)
	}
	if a.Cloud != CloudKind {
		if a.Bucket == "" {
			return fmt.Errorf("bucket is required for cloud %q", a.Cloud)
		}
		if !bucketRe.MatchString(a.Bucket) {
			return fmt.Errorf("bucket %q is not a valid object-storage name (3–63 chars, lowercase alnum and single hyphens, no leading/trailing hyphen)", a.Bucket)
		}
	}
	switch a.Postgres {
	case PostgresCNPG, PostgresPlain, PostgresExternal:
	default:
		return fmt.Errorf("postgres mode %q is invalid — must be cnpg, plain or external", a.Postgres)
	}
	if a.LLM.Reasoning == "" || a.LLM.Default == "" || a.LLM.Embed == "" {
		return fmt.Errorf("all three LLM tier model ids (reasoning, default, embed) are required")
	}
	if a.KNNDimension <= 0 {
		return fmt.Errorf("knnDimension must be a positive integer (got %d)", a.KNNDimension)
	}
	if a.TLS && a.Domain == "" {
		return fmt.Errorf("TLS requested but no domain given — set a domain or disable TLS")
	}
	if a.Domain != "" && !isPlausibleDomain(a.Domain) {
		return fmt.Errorf("domain %q does not look like a hostname (e.g. os.example.com)", a.Domain)
	}
	return nil
}

var domainRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`)

func isPlausibleDomain(s string) bool {
	return domainRe.MatchString(strings.ToLower(s))
}

// ValuesFile is the per-cloud overlay filename the chart ships (values.gke.yaml
// etc). kind/stackit reuse existing overlays already in the repo.
func (a Answers) ValuesFile() string {
	switch a.Cloud {
	case CloudStackit:
		return "values.stackit-managed.yaml"
	case CloudKind:
		return "values.local.yaml"
	default:
		return fmt.Sprintf("values.%s.yaml", a.Cloud)
	}
}

// Summary is a short, secret-free recap for the wizard + the bootstrap handoff.
func (a Answers) Summary() string {
	var b strings.Builder
	scope, label, _ := a.scopeField()
	fmt.Fprintf(&b, "cloud:      %s\n", a.Cloud)
	if label != "" && scope != "" {
		fmt.Fprintf(&b, "%-11s %s\n", strings.SplitN(label, " ", 2)[0]+":", scope)
	}
	fmt.Fprintf(&b, "region:     %s\n", a.Region)
	if a.Cloud != CloudKind {
		fmt.Fprintf(&b, "bucket:     %s\n", a.Bucket)
	}
	fmt.Fprintf(&b, "postgres:   %s\n", a.Postgres)
	fmt.Fprintf(&b, "llm:        reasoning=%s default=%s embed=%s\n", a.LLM.Reasoning, a.LLM.Default, a.LLM.Embed)
	fmt.Fprintf(&b, "knnDim:     %d\n", a.KNNDimension)
	if a.Domain != "" {
		fmt.Fprintf(&b, "domain:     %s (tls=%v)\n", a.Domain, a.TLS)
	}
	return b.String()
}

// sortedTierNames is a tiny helper used by the values render so output is stable.
func sortedTierNames(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
