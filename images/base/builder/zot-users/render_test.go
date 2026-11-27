// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder registry identities (workstream C1) - tests of the pure rendering.
// USER STORY: As a platform owner I want proof that one domain's push user can never be granted another domain's
//   repositories, and that an unchanged input never churns Zot's Secret.
// ARCHITECTURE: go test, run by the image build (images/base/builder/Dockerfile) before the binary is copied.

package main

import (
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

const tmpl = `{"distSpecVersion":"1.1.1","storage":{"rootDirectory":"/var/lib/registry"},"http":{"address":"0.0.0.0","port":"5000",
"accessControl":{"repositories":{"library/**":{"anonymousPolicy":["read"]}}}}}`

func TestValidatePushUser(t *testing.T) {
	pw := strings.Repeat("a", 32)
	ok := []User{{"push-sales", pw, "apps/sales"}, {"push-a-b", pw, "apps/a-b"}, {"push-sales-1a2b3c4d", pw, "apps/sales-1a2b3c4d"}}
	for _, u := range ok {
		if err := ValidatePushUser(u, "zot-"+u.Name); err != nil {
			t.Errorf("%v refused: %v", u.Name, err)
		}
	}
	bad := []User{
		{"pull", pw, "apps/sales"},             // not a push user
		{"push-Sales", pw, "apps/sales"},       // capitals
		{"push-sales", pw, "apps/**"},          // a glob would widen the grant
		{"push-sales", pw, "apps/sales/../hr"}, // traversal
		{"push-sales", pw, "library/sales"},    // outside apps/
		{"push-sales", pw, "apps/sales/x"},     // deeper than apps/<domain>
		{"push-sales", "short", "apps/sales"},  // weak password
		{"push-sales:x", pw, "apps/sales"},     // htpasswd separator
		{"push-sales", pw, "apps/hr"},          // a user claiming another domain's repository
	}
	for _, u := range bad {
		if err := ValidatePushUser(u, "zot-"+u.Name); err == nil {
			t.Errorf("%+v accepted", u)
		}
	}
	// the Secret name is part of the binding: another domain's Secret cannot carry this user
	if err := ValidatePushUser(User{"push-sales", pw, "apps/sales"}, "zot-push-hr"); err == nil {
		t.Error("push-sales from Secret zot-push-hr accepted")
	}
}

func TestDedupePushUsers(t *testing.T) {
	in := []User{{"push-a", "1", "apps/a"}, {"push-a", "2", "apps/a"}, {"push-b", "3", "apps/b"}}
	kept, rejected := DedupePushUsers(in)
	if len(kept) != 2 || len(rejected) != 1 || kept[0].Password != "1" {
		t.Fatalf("kept %+v rejected %+v", kept, rejected)
	}
}

func TestRunningImageAndKeepTags(t *testing.T) {
	d := "sha256:" + strings.Repeat("a", 64)
	hosts := []string{"registry.dev.example.com", "zot.agentic-os.svc.cluster.local:5000"}
	for _, ref := range []string{"registry.dev.example.com/apps/sales-1a2b3c4d/shop@" + d, "zot.agentic-os.svc.cluster.local:5000/apps/sales-1a2b3c4d/shop@" + d} {
		repo, got, ok := RunningImage(ref, hosts)
		if !ok || repo != "apps/sales-1a2b3c4d/shop" || got != d {
			t.Errorf("%s: %q %q %v", ref, repo, got, ok)
		}
	}
	for _, ref := range []string{"docker.io/library/node@" + d, "registry.dev.example.com/apps/x/y:latest", "evil.example/apps/x/y@" + d, "registry.dev.example.com/library/node@" + d} {
		if _, _, ok := RunningImage(ref, hosts); ok {
			t.Errorf("%s accepted", ref)
		}
	}
	if KeepTag(d) != "keep-"+strings.Repeat("a", 64) {
		t.Fatal(KeepTag(d))
	}
	stale := StaleKeepTags([]string{"keep-1", "keep-2", "release-dev-1", "abc"}, map[string]bool{"keep-1": true})
	if strings.Join(stale, ",") != "keep-2" {
		t.Fatalf("stale %v", stale)
	}
}

func TestRenderHtpasswdReusesHashes(t *testing.T) {
	users := []User{{"push-b", "pw-b-0123456789abcdefghij", "apps/b"}, {"pull", "pw-pull-0123456789abcdef", ""}}
	first, err := RenderHtpasswd(users, nil, bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first, "pull:$2") || !strings.Contains(first, "\npush-b:$2") {
		t.Fatalf("sorted bcrypt lines expected, got %q", first)
	}
	second, _ := RenderHtpasswd(users, ParseHtpasswd(first), bcrypt.MinCost)
	if first != second {
		t.Fatal("unchanged input must render byte-identical output")
	}
	users[0].Password = "a-new-password-0123456789"
	third, _ := RenderHtpasswd(users, ParseHtpasswd(first), bcrypt.MinCost)
	h := ParseHtpasswd(third)["push-b"]
	if bcrypt.CompareHashAndPassword([]byte(h), []byte("a-new-password-0123456789")) != nil {
		t.Fatal("a changed password must be re-hashed")
	}
	if strings.Contains(third, "a-new-password") {
		t.Fatal("clear-text password in htpasswd")
	}
	if _, err := RenderHtpasswd([]User{users[0], users[0]}, nil, bcrypt.MinCost); err == nil {
		t.Fatal("duplicate user accepted")
	}
}

func TestRenderConfigPerDomainGrants(t *testing.T) {
	users := []User{{"push-sales", "x", "apps/sales"}, {"push-hr", "y", "apps/hr"}}
	out, err := RenderConfig([]byte(tmpl), "/etc/zot/htpasswd", users)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		HTTP struct {
			Auth          map[string]map[string]string
			AccessControl struct {
				Repositories map[string]struct {
					Policies        []struct{ Users, Actions []string }
					AnonymousPolicy []string
				}
				AdminPolicy struct{ Users []string }
			}
		}
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.HTTP.Auth["htpasswd"]["path"] != "/etc/zot/htpasswd" {
		t.Fatal("htpasswd path not set")
	}
	repos := cfg.HTTP.AccessControl.Repositories
	if len(repos["library/**"].AnonymousPolicy) != 1 {
		t.Fatal("template mirror entry lost")
	}
	sales := repos["apps/sales/**"]
	if len(sales.Policies) != 3 || sales.Policies[0].Users[0] != "push-sales" || strings.Join(sales.Policies[0].Actions, ",") != "read,create,update" {
		t.Fatalf("sales grant wrong: %+v", sales)
	}
	for pattern, r := range repos {
		for _, p := range r.Policies {
			for _, u := range p.Users {
				if u == "push-sales" && pattern != "apps/sales/**" {
					t.Fatalf("push-sales granted on %s", pattern)
				}
				if u == "push-sales" && strings.Contains(strings.Join(p.Actions, ","), "delete") {
					t.Fatalf("push-sales may delete on %s", pattern)
				}
				if u == "pull" && strings.Join(p.Actions, ",") != "read" {
					t.Fatalf("pull granted %v on %s", p.Actions, pattern)
				}
			}
		}
	}
	keeperOK := false
	for _, p := range repos["apps/sales/**"].Policies {
		if p.Users[0] == "keeper" {
			keeperOK = strings.Join(p.Actions, ",") == "read,create,delete"
		}
	}
	if !keeperOK {
		t.Fatal("the retention keeper must be able to tag and untag in every app repository")
	}
	if len(cfg.HTTP.AccessControl.AdminPolicy.Users) != 0 {
		t.Fatal("no admin identity expected")
	}
	again, _ := RenderConfig([]byte(tmpl), "/etc/zot/htpasswd", users)
	if string(again) != string(out) {
		t.Fatal("config render not deterministic")
	}
	if _, err := RenderConfig([]byte(`{"http":{"accessControl":{"repositories":{"apps/**":{}}}}}`), "/x", nil); err == nil {
		t.Fatal("a template pattern colliding with a generated one must fail")
	}
}

func TestDockerConfigJSON(t *testing.T) {
	b, err := DockerConfigJSON("registry.example:443", "pull", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"auth":"cHVsbDpzZWNyZXQ="`) {
		t.Fatalf("unexpected %s", b)
	}
}
