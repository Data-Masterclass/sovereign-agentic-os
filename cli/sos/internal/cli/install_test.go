// SPDX-License-Identifier: Apache-2.0
package cli

import (
	"strings"
	"testing"

	"github.com/sovereign-os/sos/internal/install"
)

func TestBootstrapScriptFor(t *testing.T) {
	cases := map[install.Cloud]string{
		install.CloudGKE:     "deploy/cloud/bootstrap-gke.sh",
		install.CloudEKS:     "deploy/cloud/bootstrap-eks.sh",
		install.CloudAKS:     "deploy/cloud/bootstrap-aks.sh",
		install.CloudStackit: "", // managed path — no cloud bootstrap here
		install.CloudKind:    "",
	}
	for c, want := range cases {
		got := bootstrapScriptFor(c, "deploy/cloud")
		if got != want {
			t.Errorf("bootstrapScriptFor(%s) = %q, want %q", c, got, want)
		}
	}
}

func TestBootstrapEnvPerCloud(t *testing.T) {
	a := install.Answers{Cloud: install.CloudGKE, Project: "proj-1"}
	a.ApplyDefaults()
	env := bootstrapEnv(a)
	joined := strings.Join(env, " ")
	if !strings.Contains(joined, "SOS_PROJECT=proj-1") {
		t.Errorf("GKE env missing project: %v", env)
	}
	if !strings.Contains(joined, "SOS_BUCKET=") || !strings.Contains(joined, "SOS_REGION=") {
		t.Errorf("env missing bucket/region: %v", env)
	}
	if strings.Contains(joined, "SOS_ACCOUNT=") || strings.Contains(joined, "SOS_SUBSCRIPTION=") {
		t.Errorf("GKE env leaked another cloud's scope: %v", env)
	}
}

func TestRedactKeysHidesValues(t *testing.T) {
	env := []string{"SOS_PROJECT=acme-analytics-proj", "SOS_REGION=us-central1"}
	keys := redactKeys(env)
	joined := strings.Join(keys, " ")
	if strings.Contains(joined, "acme-analytics-proj") || strings.Contains(joined, "us-central1") {
		t.Errorf("redactKeys leaked a value: %v", keys)
	}
	if !strings.Contains(joined, "SOS_PROJECT") || !strings.Contains(joined, "SOS_REGION") {
		t.Errorf("redactKeys dropped a key name: %v", keys)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "  ", "x", "y"); got != "x" {
		t.Errorf("firstNonEmpty = %q, want x", got)
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Errorf("firstNonEmpty of empties = %q, want empty", got)
	}
}

func TestPreflightsIncludeCloudCLI(t *testing.T) {
	names := func(c install.Cloud) string {
		var b strings.Builder
		for _, p := range install.Preflights(c) {
			b.WriteString(p.Name)
			b.WriteString("|")
		}
		return b.String()
	}
	if !strings.Contains(names(install.CloudGKE), "gcloud") {
		t.Error("GKE preflight missing gcloud check")
	}
	if !strings.Contains(names(install.CloudEKS), "aws") {
		t.Error("EKS preflight missing aws check")
	}
	if !strings.Contains(names(install.CloudAKS), "az") {
		t.Error("AKS preflight missing az check")
	}
	// Common checks always present.
	if !strings.Contains(names(install.CloudKind), "helm present") {
		t.Error("kind preflight missing helm check")
	}
}
