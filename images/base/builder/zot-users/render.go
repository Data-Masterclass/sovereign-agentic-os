// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder registry identities (workstream C1, spec 6.2).
// USER STORY: As a platform owner I want each domain to push only to its own Zot repositories, nodes to pull with a
//   read-only identity, and no password ever stored in clear in Zot's configuration.
// ARCHITECTURE: pure rendering, no I/O: from the per-domain push users (os-ui writes one random-password Secret per
//   domain) and the pull user, render Zot's htpasswd (bcrypt, golang.org/x/crypto) and the `http.accessControl`
//   block of Zot's config (https://zotregistry.dev/latest/articles/authn-authz/). An existing bcrypt hash is kept
//   when it still verifies the password, so an unchanged input renders a byte-identical Secret (no Zot reload).

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// PullUser is the read-only identity the nodes pull app images with (imagePullSecret in apps-dev/apps-prod).
const PullUser = "pull"

// KeeperUser is the retention keeper: it tags every digest a pod in apps-dev/apps-prod runs `keep-<digest>` and
// removes such a tag when nothing runs it any more (Zot's retention keeps `keep-*` and `release-*`). Its password lives
// only in the zot-pull Secret, read only by this Job.
const KeeperUser = "keeper"

// User is one htpasswd identity.
type User struct {
	Name     string
	Password string
	// Repository is the repository prefix the user may push to (`apps/<domain>`); empty for the pull user.
	Repository string
}

var (
	pushUserRE = regexp.MustCompile(`^push-[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	// OCI distribution repository grammar for one path component, under the fixed `apps/` root.
	repositoryRE = regexp.MustCompile(`^apps/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$`)
)

// ValidatePushUser refuses a user name or repository prefix outside the closed shapes above, a password too short to
// be one os-ui generated, and any binding other than os-ui's naming rule (core/adapters/zot/client.ts): user
// `push-<key>` may own exactly `apps/<key>`, and only from the Secret `zot-push-<key>`.
func ValidatePushUser(u User, secretName string) error {
	if !pushUserRE.MatchString(u.Name) {
		return fmt.Errorf("push user %q: name must match %s", u.Name, pushUserRE)
	}
	if !repositoryRE.MatchString(u.Repository) {
		return fmt.Errorf("push user %q: repository %q must be apps/<domain> (OCI grammar)", u.Name, u.Repository)
	}
	if want := "apps/" + strings.TrimPrefix(u.Name, "push-"); u.Repository != want {
		return fmt.Errorf("push user %q: repository %q must be %q", u.Name, u.Repository, want)
	}
	if want := "zot-" + u.Name; secretName != want {
		return fmt.Errorf("push user %q: comes from Secret %q, must be %q", u.Name, secretName, want)
	}
	if len(u.Password) < 24 {
		return fmt.Errorf("push user %q: password shorter than 24 characters", u.Name)
	}
	return nil
}

// ParseHtpasswd reads `user:hash` lines (blank lines and comments ignored).
func ParseHtpasswd(s string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if i := strings.IndexByte(line, ':'); i > 0 {
			out[line[:i]] = line[i+1:]
		}
	}
	return out
}

// RenderHtpasswd renders one bcrypt line per user, sorted by name. A previous hash that still verifies the same
// password is reused, so the output only changes when a password does.
func RenderHtpasswd(users []User, previous map[string]string, cost int) (string, error) {
	sorted := append([]User(nil), users...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	var b strings.Builder
	seen := map[string]bool{}
	for _, u := range sorted {
		if seen[u.Name] {
			return "", fmt.Errorf("user %q listed twice", u.Name)
		}
		seen[u.Name] = true
		if strings.ContainsAny(u.Name, ":\n") || u.Password == "" {
			return "", fmt.Errorf("user %q: invalid name or empty password", u.Name)
		}
		hash := previous[u.Name]
		if hash == "" || bcrypt.CompareHashAndPassword([]byte(hash), []byte(u.Password)) != nil {
			h, err := bcrypt.GenerateFromPassword([]byte(u.Password), cost)
			if err != nil {
				return "", err
			}
			hash = string(h)
		}
		fmt.Fprintf(&b, "%s:%s\n", u.Name, hash)
	}
	return b.String(), nil
}

// RenderConfig fills the template's `http.auth.htpasswd.path` and adds one access-control entry per push user:
// `apps/<domain>/**` → that domain's push user (read, create, update) and the pull user (read). `apps/**` gives the
// pull user read on everything below apps/ (Zot applies the most specific matching pattern, so each domain entry
// repeats it). The template's own repository entries (the base-image mirror) are kept; a generated pattern that
// collides with one is an error.
func RenderConfig(template []byte, htpasswdPath string, users []User) ([]byte, error) {
	var cfg map[string]any
	if err := json.Unmarshal(template, &cfg); err != nil {
		return nil, fmt.Errorf("config template: %w", err)
	}
	httpCfg, _ := cfg["http"].(map[string]any)
	if httpCfg == nil {
		return nil, errors.New("config template: no http block")
	}
	httpCfg["auth"] = map[string]any{"htpasswd": map[string]any{"path": htpasswdPath}}
	ac, _ := httpCfg["accessControl"].(map[string]any)
	if ac == nil {
		ac = map[string]any{}
	}
	repos, _ := ac["repositories"].(map[string]any)
	if repos == nil {
		repos = map[string]any{}
	}
	add := func(pattern string, entry map[string]any) error {
		if _, ok := repos[pattern]; ok {
			return fmt.Errorf("access pattern %q is already in the template", pattern)
		}
		repos[pattern] = entry
		return nil
	}
	pullRead := map[string]any{"users": []string{PullUser}, "actions": []string{"read"}}
	keeper := map[string]any{"users": []string{KeeperUser}, "actions": []string{"read", "create", "delete"}}
	if err := add("apps/**", map[string]any{"policies": []any{pullRead, keeper}, "defaultPolicy": []string{}}); err != nil {
		return nil, err
	}
	for _, u := range users {
		if u.Name == PullUser || u.Name == KeeperUser {
			continue
		}
		push := map[string]any{"users": []string{u.Name}, "actions": []string{"read", "create", "update"}}
		if err := add(u.Repository+"/**", map[string]any{"policies": []any{push, pullRead, keeper}, "defaultPolicy": []string{}}); err != nil {
			return nil, err
		}
	}
	ac["repositories"] = repos
	// No admin identity: nobody may delete through the API; retention and GC are Zot's own (config template).
	ac["adminPolicy"] = map[string]any{"users": []string{}, "actions": []string{}}
	httpCfg["accessControl"] = ac
	// encoding/json sorts map keys: the output is deterministic for the same input.
	return json.MarshalIndent(cfg, "", "  ")
}

// DockerConfigJSON renders a kubernetes.io/dockerconfigjson payload for one registry host.
func DockerConfigJSON(host, user, password string) ([]byte, error) {
	auth := base64Std(user + ":" + password)
	return json.Marshal(map[string]any{"auths": map[string]any{host: map[string]string{"username": user, "password": password, "auth": auth}}})
}

// DedupePushUsers keeps the first user of each name and of each repository (the input is sorted by Secret name) and
// returns the rest as rejected: a duplicate must never lock every domain out by failing the whole reconcile.
func DedupePushUsers(users []User) (kept, rejected []User) {
	names, repos := map[string]bool{}, map[string]bool{}
	for _, u := range users {
		if names[u.Name] || repos[u.Repository] {
			rejected = append(rejected, u)
			continue
		}
		names[u.Name], repos[u.Repository] = true, true
		kept = append(kept, u)
	}
	return kept, rejected
}

// RunningImage parses a pod's image or imageID: `<host>/apps/<key>/<slug>@sha256:<64 hex>` for one of `hosts`.
func RunningImage(ref string, hosts []string) (repo, digest string, ok bool) {
	ref = strings.TrimPrefix(ref, "docker-pullable://")
	at := strings.LastIndex(ref, "@")
	if at < 0 {
		return "", "", false
	}
	name, d := ref[:at], ref[at+1:]
	if !digestRE.MatchString(d) {
		return "", "", false
	}
	for _, h := range hosts {
		if h != "" && strings.HasPrefix(name, h+"/") {
			r := strings.TrimPrefix(name, h+"/")
			if appRepoRE.MatchString(r) {
				return r, d, true
			}
		}
	}
	return "", "", false
}

// KeepTag is the tag that pins a running digest.
func KeepTag(digest string) string { return "keep-" + strings.TrimPrefix(digest, "sha256:") }

// StaleKeepTags lists the keep-* tags of a repository whose digest no pod runs any more.
func StaleKeepTags(tags []string, wanted map[string]bool) []string {
	var out []string
	for _, t := range tags {
		if strings.HasPrefix(t, "keep-") && !wanted[t] {
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

var (
	digestRE  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	appRepoRE = regexp.MustCompile(`^apps/[a-z0-9]([a-z0-9-]*[a-z0-9])?/[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
)
