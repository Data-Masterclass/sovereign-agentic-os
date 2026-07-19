// SPDX-License-Identifier: Apache-2.0
package install

import (
	"strings"
	"testing"
)

func gkeAnswers() Answers {
	a := Answers{Cloud: CloudGKE, Project: "my-proj", Domain: "example.com", TLS: true}
	a.ApplyDefaults()
	return a
}

func TestRenderInstallValuesDeterministic(t *testing.T) {
	a := gkeAnswers()
	if RenderInstallValues(a) != RenderInstallValues(a) {
		t.Fatal("RenderInstallValues is not deterministic")
	}
}

func TestRenderInstallValuesContent(t *testing.T) {
	a := gkeAnswers()
	out := RenderInstallValues(a)

	// Cloud + region.
	if !strings.Contains(out, "cloud: gke") {
		t.Error("missing cloud")
	}
	// Bucket present for cloud.
	if !strings.Contains(out, a.Bucket) {
		t.Error("missing bucket")
	}
	// Postgres engine + HA defaults for CNPG.
	if !strings.Contains(out, "engine: cnpg") || !strings.Contains(out, "instances: 3") {
		t.Error("missing cnpg engine / HA defaults")
	}
	if !strings.Contains(out, "walArchive") {
		t.Error("missing WAL archive to bucket")
	}
	// knn dimension.
	if !strings.Contains(out, "knnDimension: 3072") {
		t.Error("missing knnDimension")
	}
	// All three tier aliases present.
	for _, alias := range []string{"sovereign-reasoning", "sovereign-default", "sovereign-embed"} {
		if !strings.Contains(out, alias) {
			t.Errorf("missing tier alias %q", alias)
		}
	}
	// Model ids present.
	if !strings.Contains(out, "gemini-3.1-pro") {
		t.Error("missing reasoning model id")
	}
	// Ingress with TLS.
	if !strings.Contains(out, "os.example.com") || !strings.Contains(out, "letsencrypt-prod") {
		t.Error("missing ingress host / TLS issuer")
	}
}

func TestRenderNoSecrets(t *testing.T) {
	a := gkeAnswers()
	out := strings.ToLower(RenderInstallValues(a))
	for _, forbidden := range []string{"secret", "password", "api_key", "apikey", "token", "credential"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("rendered values contain a secret-like token %q", forbidden)
		}
	}
}

func TestRenderKindOmitsBucket(t *testing.T) {
	a := Answers{Cloud: CloudKind}
	a.ApplyDefaults()
	out := RenderInstallValues(a)
	if strings.Contains(out, "objectStorage:") {
		t.Error("kind should not render an objectStorage bucket block")
	}
}

func TestRenderExternalPostgres(t *testing.T) {
	a := Answers{Cloud: CloudEKS, Account: "111122223333", Postgres: PostgresExternal}
	a.ApplyDefaults()
	out := RenderInstallValues(a)
	if !strings.Contains(out, "enabled: false") {
		t.Error("external postgres should disable the bundled engine")
	}
	if strings.Contains(out, "instances: 3") {
		t.Error("external postgres should not render CNPG HA defaults")
	}
}

func TestHelmArgs(t *testing.T) {
	args := HelmArgs("agentic-os", "agentic-os", "charts/x", "values.gke.yaml", "install.yaml")
	joined := strings.Join(args, " ")
	if !strings.HasPrefix(joined, "upgrade --install agentic-os charts/x") {
		t.Errorf("unexpected helm args: %s", joined)
	}
	// The generated install.yaml must be layered AFTER the overlay so it wins.
	if !strings.Contains(joined, "-f values.gke.yaml -f install.yaml") {
		t.Errorf("overlay ordering wrong (install.yaml must follow the overlay): %s", joined)
	}
	// And --wait must be present so helm blocks until the release settles.
	if !strings.Contains(joined, "--wait") {
		t.Errorf("helm args missing --wait: %s", joined)
	}
}

func TestHelmArgsNoOverlay(t *testing.T) {
	args := HelmArgs("r", "ns", "chart", "", "install.yaml")
	if strings.Contains(strings.Join(args, " "), "-f  ") {
		t.Error("empty overlay should be skipped, not emitted as an empty -f")
	}
}

func TestPlannedCommands(t *testing.T) {
	a := gkeAnswers()
	cmds := PlannedCommands(a, "agentic-os", "agentic-os", "charts/x", "deploy/cloud/bootstrap-gke.sh", "install.yaml")
	if len(cmds) != 2 {
		t.Fatalf("expected bootstrap + helm, got %d: %v", len(cmds), cmds)
	}
	if !strings.Contains(cmds[0], "bootstrap-gke.sh") {
		t.Errorf("first planned command should be bootstrap: %s", cmds[0])
	}
	if !strings.HasPrefix(cmds[1], "helm upgrade --install") {
		t.Errorf("second planned command should be helm: %s", cmds[1])
	}
}
