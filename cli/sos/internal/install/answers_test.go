// SPDX-License-Identifier: Apache-2.0
package install

import (
	"strings"
	"testing"
)

func TestParseCloud(t *testing.T) {
	for _, in := range []string{"gke", "EKS", " aks ", "stackit", "kind"} {
		if _, err := ParseCloud(in); err != nil {
			t.Errorf("ParseCloud(%q) unexpected error: %v", in, err)
		}
	}
	if _, err := ParseCloud("digitalocean"); err == nil {
		t.Error("ParseCloud accepted an unknown cloud")
	}
}

func TestApplyDefaultsFillsPerCloud(t *testing.T) {
	a := Answers{Cloud: CloudGKE, Project: "my-proj"}
	a.ApplyDefaults()
	if a.Region != "us-central1" {
		t.Errorf("region default = %q, want us-central1", a.Region)
	}
	if a.Postgres != PostgresCNPG {
		t.Errorf("postgres default = %q, want cnpg", a.Postgres)
	}
	if a.LLM.Reasoning != "gemini-3.1-pro" {
		t.Errorf("reasoning default = %q", a.LLM.Reasoning)
	}
	if a.KNNDimension != 3072 {
		t.Errorf("knnDimension default = %d, want 3072", a.KNNDimension)
	}
	if a.Bucket == "" || !strings.HasPrefix(a.Bucket, "sovereign-os-") {
		t.Errorf("bucket default = %q, want sovereign-os-* derived", a.Bucket)
	}
}

func TestApplyDefaultsNeverOverridesAdmin(t *testing.T) {
	a := Answers{
		Cloud:    CloudEKS,
		Account:  "111122223333",
		Region:   "eu-west-1",
		Bucket:   "custom-bucket-name",
		Postgres: PostgresExternal,
		LLM:      LLMTier{Reasoning: "x", Default: "y", Embed: "z"},
	}
	a.ApplyDefaults()
	if a.Region != "eu-west-1" || a.Bucket != "custom-bucket-name" || a.Postgres != PostgresExternal {
		t.Error("ApplyDefaults overrode admin-supplied values")
	}
	if a.LLM.Reasoning != "x" {
		t.Error("ApplyDefaults overrode admin LLM ids")
	}
}

func TestDefaultBucketIsDNSSafe(t *testing.T) {
	a := Answers{Cloud: CloudGKE, Project: "My_Weird.Project--Name"}
	a.ApplyDefaults()
	if !bucketRe.MatchString(a.Bucket) {
		t.Errorf("derived bucket %q is not DNS-safe", a.Bucket)
	}
}

func TestValidate(t *testing.T) {
	valid := func() Answers {
		a := Answers{Cloud: CloudGKE, Project: "p"}
		a.ApplyDefaults()
		return a
	}

	tests := []struct {
		name    string
		mutate  func(*Answers)
		wantErr string // substring, "" = no error
	}{
		{"happy gke", func(*Answers) {}, ""},
		{"missing project", func(a *Answers) { a.Project = "" }, "project"},
		{"bad region", func(a *Answers) { a.Region = "US East 1" }, "region"},
		{"bad bucket", func(a *Answers) { a.Bucket = "Bad_Bucket!" }, "bucket"},
		{"bad postgres", func(a *Answers) { a.Postgres = "postgres13" }, "postgres"},
		{"missing embed", func(a *Answers) { a.LLM.Embed = "" }, "LLM tier"},
		{"zero dim", func(a *Answers) { a.KNNDimension = 0 }, "knnDimension"},
		{"tls without domain", func(a *Answers) { a.TLS = true }, "domain"},
		{"bad domain", func(a *Answers) { a.Domain = "not a domain" }, "domain"},
		{"good domain+tls", func(a *Answers) { a.Domain = "os.example.com"; a.TLS = true }, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := valid()
			tt.mutate(&a)
			err := a.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
			}
		})
	}
}

func TestKindNeedsNoBucketOrScope(t *testing.T) {
	a := Answers{Cloud: CloudKind}
	a.ApplyDefaults()
	if err := a.Validate(); err != nil {
		t.Fatalf("kind should validate with no scope/bucket: %v", err)
	}
}

func TestScopeRequiredPerCloud(t *testing.T) {
	// EKS requires account; supplying a project (wrong field) must still fail.
	a := Answers{Cloud: CloudEKS, Project: "wrong-field"}
	a.ApplyDefaults()
	if err := a.Validate(); err == nil {
		t.Fatal("EKS without account should fail validation")
	}
}

func TestValuesFile(t *testing.T) {
	cases := map[Cloud]string{
		CloudGKE:     "values.gke.yaml",
		CloudEKS:     "values.eks.yaml",
		CloudAKS:     "values.aks.yaml",
		CloudStackit: "values.stackit-managed.yaml",
		CloudKind:    "values.local.yaml",
	}
	for c, want := range cases {
		if got := (Answers{Cloud: c}).ValuesFile(); got != want {
			t.Errorf("ValuesFile(%s) = %q, want %q", c, got, want)
		}
	}
}

func TestSummaryHasNoSecretsAndKeyFields(t *testing.T) {
	a := Answers{Cloud: CloudAKS, Subscription: "sub-123"}
	a.ApplyDefaults()
	s := a.Summary()
	for _, want := range []string{"aks", "sub-123", "postgres", "knnDim"} {
		if !strings.Contains(s, want) {
			t.Errorf("summary missing %q:\n%s", want, s)
		}
	}
}
