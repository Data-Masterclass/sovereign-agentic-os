// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder registry identities (workstream C1, spec 6.2) - the `zot-users` Job.
// USER STORY: As a platform owner I want a new domain's push credential to work in Zot within minutes of os-ui
//   creating it, without os-ui ever holding Zot's configuration or a bcrypt dependency.
// ARCHITECTURE: one run = one reconcile, started by the chart's CronJob or by os-ui creating a Job from it:
//     1. list the push Secrets os-ui wrote in the build namespace (label soa.dev/zot-push=true; keys username,
//        password; annotation soa.dev/zot-repository = apps/<domain>);
//     2. read (or create, once, with a random password) the pull Secret in Zot's namespace;
//     3. render Zot's htpasswd + config.json (render.go) into the Secret Zot mounts; Zot hot-reloads both files;
//     4. write the node pull Secret (dockerconfigjson for the registry's node-facing host) into each app namespace;
//     5. retention keeper: tag every running digest keep-<hex>, and apply the release-<env>-<id> tags recorded on the
//        app Deployments of apps-dev/apps-prod (release_tags.go), both with the keeper's own identity.
//   Talks to the Kubernetes API with the pod's ServiceAccount over plain REST (no client library); writes only when
//   content changed; never prints a password or hash.

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func base64Std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

type secret struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   meta              `json:"metadata"`
	Type       string            `json:"type,omitempty"`
	Data       map[string]string `json:"data,omitempty"`
}

type meta struct {
	Name            string            `json:"name"`
	Namespace       string            `json:"namespace,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	Annotations     map[string]string `json:"annotations,omitempty"`
	ResourceVersion string            `json:"resourceVersion,omitempty"`
}

type kube struct {
	base   string
	token  string
	client *http.Client
}

const saDir = "/var/run/secrets/kubernetes.io/serviceaccount"

func inCluster() (*kube, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not in a cluster (KUBERNETES_SERVICE_HOST unset)")
	}
	token, err := os.ReadFile(saDir + "/token")
	if err != nil {
		return nil, err
	}
	ca, err := os.ReadFile(saDir + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("service account ca.crt holds no certificate")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return &kube{
		base:   "https://" + host + ":" + port,
		token:  strings.TrimSpace(string(token)),
		client: &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}},
	}, nil
}

func (k *kube) do(method, path string, body any, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, k.base+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := k.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode >= 300 {
		if res.StatusCode == http.StatusNotFound {
			return res.StatusCode, nil
		}
		// The API's Status message names the object and the verb, never a Secret's data.
		var st struct{ Message string }
		_ = json.Unmarshal(data, &st)
		return res.StatusCode, fmt.Errorf("%s %s: HTTP %d: %s", method, path, res.StatusCode, st.Message)
	}
	if out != nil {
		return res.StatusCode, json.Unmarshal(data, out)
	}
	return res.StatusCode, nil
}

func secretPath(ns, name string) string {
	p := "/api/v1/namespaces/" + url.PathEscape(ns) + "/secrets"
	if name != "" {
		p += "/" + url.PathEscape(name)
	}
	return p
}

func (k *kube) getSecret(ns, name string) (*secret, error) {
	var s secret
	code, err := k.do(http.MethodGet, secretPath(ns, name), nil, &s)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound {
		return nil, nil
	}
	return &s, nil
}

// putSecret creates the Secret or replaces its data/type/labels when they differ. Returns whether it wrote.
func (k *kube) putSecret(want secret) (bool, error) {
	have, err := k.getSecret(want.Metadata.Namespace, want.Metadata.Name)
	if err != nil {
		return false, err
	}
	want.APIVersion, want.Kind = "v1", "Secret"
	if have == nil {
		_, err := k.do(http.MethodPost, secretPath(want.Metadata.Namespace, ""), want, nil)
		return err == nil, err
	}
	if have.Type == want.Type && equalMaps(have.Data, want.Data) && labelsContain(have.Metadata.Labels, want.Metadata.Labels) {
		return false, nil
	}
	want.Metadata.ResourceVersion = have.Metadata.ResourceVersion
	_, err = k.do(http.MethodPut, secretPath(want.Metadata.Namespace, want.Metadata.Name), want, nil)
	return err == nil, err
}

// ensurePullSecretOnDefaultSA adds the pull Secret to the namespace's `default` ServiceAccount (spec 6.2: app pods
// pull with it without naming it). A JSON merge patch would replace the whole list, so the current list is read and
// the name appended only when absent; Kubernetes creates `default` itself, so a missing one is waited out by the
// next run rather than created here.
func (k *kube) ensurePullSecretOnDefaultSA(ns, name string) error {
	var sa struct {
		Metadata         meta                `json:"metadata"`
		ImagePullSecrets []map[string]string `json:"imagePullSecrets"`
	}
	path := "/api/v1/namespaces/" + url.PathEscape(ns) + "/serviceaccounts/default"
	code, err := k.do(http.MethodGet, path, nil, &sa)
	if err != nil {
		return err
	}
	if code == http.StatusNotFound {
		fmt.Printf("zot-users: %s/default ServiceAccount not there yet\n", ns)
		return nil
	}
	for _, s := range sa.ImagePullSecrets {
		if s["name"] == name {
			return nil
		}
	}
	patch := map[string]any{"metadata": map[string]any{"resourceVersion": sa.Metadata.ResourceVersion},
		"imagePullSecrets": append(sa.ImagePullSecrets, map[string]string{"name": name})}
	if err := k.patchMerge(path, patch); err != nil {
		return err
	}
	fmt.Printf("zot-users: %s/default ServiceAccount pulls with %s\n", ns, name)
	return nil
}

func (k *kube) patchMerge(path string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPatch, k.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	req.Header.Set("Content-Type", "application/merge-patch+json")
	res, err := k.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		var st struct{ Message string }
		_ = json.Unmarshal(data, &st)
		return fmt.Errorf("PATCH %s: HTTP %d: %s", path, res.StatusCode, st.Message)
	}
	return nil
}

// ensurePassword returns the identity's password from its Secret (keys username, password), creating a random one once.
// Any other key (an older layout kept the keeper's password beside the pull password) is dropped on rewrite.
func (k *kube) ensurePassword(ns, name, user string) (string, error) {
	s, err := k.getSecret(ns, name)
	if err != nil {
		return "", err
	}
	pw := decode(s, "password")
	if pw == "" {
		if pw, err = randomPassword(); err != nil {
			return "", err
		}
	}
	want := map[string]string{"username": base64Std(user), "password": base64Std(pw)}
	if s == nil || !equalMaps(s.Data, want) {
		if _, err := k.putSecret(secret{Metadata: meta{Name: name, Namespace: ns, Labels: map[string]string{"app.kubernetes.io/component": "zot"}},
			Type: "Opaque", Data: want}); err != nil {
			return "", err
		}
	}
	return pw, nil
}

func equalMaps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func labelsContain(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

func decode(s *secret, key string) string {
	if s == nil {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(s.Data[key])
	if err != nil {
		return ""
	}
	return string(b)
}

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func randomPassword() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func run() error {
	pushNS := env("PUSH_NAMESPACE", "agentic-build")
	zotNS := env("ZOT_NAMESPACE", "")
	authSecret := env("AUTH_SECRET", "zot-auth")
	pullCredSecret := env("PULL_CREDENTIAL_SECRET", "zot-pull")
	pullSecretName := env("PULL_SECRET_NAME", "app-registry-pull")
	pullNamespaces := strings.Fields(strings.ReplaceAll(env("PULL_NAMESPACES", ""), ",", " "))
	registryHost := env("REGISTRY_PULL_HOST", "")
	templatePath := env("CONFIG_TEMPLATE", "/etc/zot-template/config.json")
	htpasswdPath := env("HTPASSWD_PATH", "/etc/zot/htpasswd")
	if zotNS == "" {
		return errors.New("ZOT_NAMESPACE is required")
	}
	tmpl, err := os.ReadFile(templatePath)
	if err != nil {
		return err
	}
	k, err := inCluster()
	if err != nil {
		return err
	}

	var list struct{ Items []secret }
	if _, err := k.do(http.MethodGet, secretPath(pushNS, "")+"?labelSelector="+url.QueryEscape("soa.dev/zot-push=true"), nil, &list); err != nil {
		return err
	}
	var users []User
	skipped := 0
	for i := range list.Items {
		s := &list.Items[i]
		u := User{Name: decode(s, "username"), Password: decode(s, "password"), Repository: s.Metadata.Annotations["soa.dev/zot-repository"]}
		if err := ValidatePushUser(u, s.Metadata.Name); err != nil {
			// One malformed Secret must not lock every other domain out: it is reported and left out.
			fmt.Fprintf(os.Stderr, "skip %s/%s: %v\n", pushNS, s.Metadata.Name, err)
			skipped++
			continue
		}
		users = append(users, u)
	}
	users, dups := DedupePushUsers(users)
	for _, u := range dups {
		fmt.Fprintf(os.Stderr, "skip duplicate push user %s / repository %s (kept the first)\n", u.Name, u.Repository)
		skipped++
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Name < users[j].Name })

	// The pull identity (read-only; os-ui may read this Secret to check a digest) and the retention keeper (tag and
	// untag; its own Secret, readable by this ServiceAccount only) never share a Secret.
	pullPassword, err := k.ensurePassword(zotNS, pullCredSecret, PullUser)
	if err != nil {
		return err
	}
	keeperPassword, err := k.ensurePassword(zotNS, env("KEEPER_CREDENTIAL_SECRET", "zot-keeper"), KeeperUser)
	if err != nil {
		return err
	}
	all := append([]User{{Name: PullUser, Password: pullPassword}, {Name: KeeperUser, Password: keeperPassword}}, users...)

	prev, err := k.getSecret(zotNS, authSecret)
	if err != nil {
		return err
	}
	htpasswd, err := RenderHtpasswd(all, ParseHtpasswd(decode(prev, "htpasswd")), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	cfg, err := RenderConfig(tmpl, htpasswdPath, users)
	if err != nil {
		return err
	}
	wrote, err := k.putSecret(secret{Metadata: meta{Name: authSecret, Namespace: zotNS, Labels: map[string]string{"app.kubernetes.io/component": "zot"}},
		Type: "Opaque", Data: map[string]string{"htpasswd": base64Std(htpasswd), "config.json": base64Std(string(cfg))}})
	if err != nil {
		return err
	}
	fmt.Printf("zot-users: %d push user(s), %d skipped; %s/%s %s\n", len(users), skipped, zotNS, authSecret, map[bool]string{true: "updated", false: "unchanged"}[wrote])

	if registryHost != "" {
		dcj, err := DockerConfigJSON(registryHost, PullUser, pullPassword)
		if err != nil {
			return err
		}
		for _, ns := range pullNamespaces {
			w, err := k.putSecret(secret{Metadata: meta{Name: pullSecretName, Namespace: ns, Labels: map[string]string{"app.kubernetes.io/component": "zot"}},
				Type: "kubernetes.io/dockerconfigjson", Data: map[string]string{".dockerconfigjson": base64Std(string(dcj))}})
			if err != nil {
				return err
			}
			fmt.Printf("zot-users: %s/%s %s\n", ns, pullSecretName, map[bool]string{true: "updated", false: "unchanged"}[w])
			if env("PATCH_DEFAULT_SA", "true") == "true" {
				if err := k.ensurePullSecretOnDefaultSA(ns, pullSecretName); err != nil {
					return err
				}
			}
		}
		// The image scan (scan-image, build namespace) reads the pushed digest with the read-only pull identity,
		// never with a push credential. No ServiceAccount is patched there: only the scan step mounts it.
		if scanNS := env("SCAN_PULL_NAMESPACE", ""); scanNS != "" {
			dcjInCluster, err := DockerConfigJSON(env("REGISTRY_HOST", registryHost), PullUser, pullPassword)
			if err != nil {
				return err
			}
			w, err := k.putSecret(secret{Metadata: meta{Name: pullSecretName, Namespace: scanNS, Labels: map[string]string{"app.kubernetes.io/component": "zot"}},
				Type: "kubernetes.io/dockerconfigjson", Data: map[string]string{".dockerconfigjson": base64Std(string(dcjInCluster))}})
			if err != nil {
				return err
			}
			fmt.Printf("zot-users: %s/%s %s\n", scanNS, pullSecretName, map[bool]string{true: "updated", false: "unchanged"}[w])
		}
	}
	// Retention keeper: never let GC take a digest that runs. Failures are reported, never fatal (Zot may still be
	// reloading the config this run wrote; the next run retries).
	if regHost := env("REGISTRY_HOST", ""); regHost != "" && env("KEEP_RUNNING", "true") == "true" {
		if err := keepRunning(k, regHost, []string{registryHost, regHost}, pullNamespaces, keeperPassword); err != nil {
			fmt.Fprintln(os.Stderr, "zot-users: keeper:", err)
		}
		// Release retention (spec 6.2): the release-<env>-<id> tags os-ui's rollout recorded on each app Deployment.
		if devNS, prodNS := env("APPS_DEV_NAMESPACE", ""), env("APPS_PROD_NAMESPACE", ""); devNS != "" || prodNS != "" {
			if err := keepReleases(k, regHost, []string{registryHost, regHost}, devNS, prodNS, keeperPassword); err != nil {
				fmt.Fprintln(os.Stderr, "zot-users: release tags:", err)
			}
		}
	}
	return nil
}

// keepReleases applies the release tags recorded on the app Deployments (release_tags.go validates them). One
// Deployment with an invalid annotation is reported and skipped; it never stops the others.
func keepReleases(k *kube, regHost string, hosts []string, devNS, prodNS, password string) error {
	z := &zot{base: "http://" + regHost, user: KeeperUser, password: password, client: &http.Client{Timeout: 20 * time.Second}}
	tagged, refused := 0, 0
	for _, ns := range []string{devNS, prodNS} {
		if ns == "" {
			continue
		}
		var list struct {
			Items []struct {
				Metadata meta
				Spec     struct {
					Template struct {
						Spec struct {
							Containers, InitContainers []struct{ Image string }
						}
					}
				}
			}
		}
		if _, err := k.do(http.MethodGet, "/apis/apps/v1/namespaces/"+url.PathEscape(ns)+"/deployments", nil, &list); err != nil {
			return err
		}
		for _, d := range list.Items {
			var images []string
			for _, c := range append(d.Spec.Template.Spec.Containers, d.Spec.Template.Spec.InitContainers...) {
				images = append(images, c.Image)
			}
			pins, err := ReleasePinsOf(DeploymentImages{Namespace: ns, Name: d.Metadata.Name, Annotations: d.Metadata.Annotations, Images: images}, devNS, prodNS, hosts)
			if err != nil {
				fmt.Fprintln(os.Stderr, "zot-users: release tags: skip", err)
				refused++
				continue
			}
			for _, p := range pins {
				if err := z.tag(p.Repository, p.Digest, p.Tag); err != nil {
					return err
				}
				tagged++
			}
		}
	}
	fmt.Printf("zot-users: keeper: %d release tag(s) applied, %d Deployment annotation(s) refused\n", tagged, refused)
	return nil
}

func keepRunning(k *kube, regHost string, hosts, namespaces []string, password string) error {
	wanted := map[string]map[string]bool{} // repo -> keep tags
	digests := map[string]map[string]bool{}
	for _, ns := range namespaces {
		var pods struct {
			Items []struct {
				Spec struct {
					Containers, InitContainers []struct{ Image string }
				}
				Status struct {
					ContainerStatuses, InitContainerStatuses []struct{ ImageID string }
				}
			}
		}
		if _, err := k.do(http.MethodGet, "/api/v1/namespaces/"+url.PathEscape(ns)+"/pods", nil, &pods); err != nil {
			return err
		}
		for _, p := range pods.Items {
			var refs []string
			for _, c := range append(p.Spec.Containers, p.Spec.InitContainers...) {
				refs = append(refs, c.Image)
			}
			for _, c := range append(p.Status.ContainerStatuses, p.Status.InitContainerStatuses...) {
				refs = append(refs, c.ImageID)
			}
			for _, r := range refs {
				if repo, d, ok := RunningImage(r, hosts); ok {
					if wanted[repo] == nil {
						wanted[repo], digests[repo] = map[string]bool{}, map[string]bool{}
					}
					wanted[repo][KeepTag(d)] = true
					digests[repo][d] = true
				}
			}
		}
	}
	z := &zot{base: "http://" + regHost, user: KeeperUser, password: password, client: &http.Client{Timeout: 20 * time.Second}}
	tagged := 0
	for repo, ds := range digests {
		for d := range ds {
			if err := z.tag(repo, d, KeepTag(d)); err != nil {
				return err
			}
			tagged++
		}
	}
	repos, err := z.catalog()
	if err != nil {
		return err
	}
	removed := 0
	for _, repo := range repos {
		if !strings.HasPrefix(repo, "apps/") {
			continue
		}
		tags, err := z.tags(repo)
		if err != nil {
			return err
		}
		for _, t := range StaleKeepTags(tags, wanted[repo]) {
			if err := z.deleteTag(repo, t); err != nil {
				return err
			}
			removed++
		}
	}
	fmt.Printf("zot-users: keeper: %d running digest(s) pinned, %d stale keep tag(s) removed\n", tagged, removed)
	return nil
}

type zot struct {
	base, user, password string
	client               *http.Client
}

const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"

func (z *zot) req(method, path, ctype string, body []byte) (*http.Response, []byte, error) {
	req, err := http.NewRequest(method, z.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.SetBasicAuth(z.user, z.password)
	req.Header.Set("Accept", manifestAccept)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := z.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res, data, nil
}

// tag puts the manifest of `digest` under `tag` (the OCI distribution API: GET by digest, PUT by tag).
func (z *zot) tag(repo, digest, tag string) error {
	res, body, err := z.req(http.MethodGet, "/v2/"+repo+"/manifests/"+digest, "", nil)
	if err != nil {
		return err
	}
	if res.StatusCode == http.StatusNotFound {
		return nil // runs from a digest this registry does not hold: nothing to pin
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s@%s: HTTP %d", repo, digest, res.StatusCode)
	}
	res, _, err = z.req(http.MethodPut, "/v2/"+repo+"/manifests/"+tag, res.Header.Get("Content-Type"), body)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		return fmt.Errorf("PUT %s:%s: HTTP %d", repo, tag, res.StatusCode)
	}
	return nil
}

func (z *zot) catalog() ([]string, error) {
	res, body, err := z.req(http.MethodGet, "/v2/_catalog?n=10000", "", nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET catalog: HTTP %d", res.StatusCode)
	}
	var c struct{ Repositories []string }
	return c.Repositories, json.Unmarshal(body, &c)
}

func (z *zot) tags(repo string) ([]string, error) {
	res, body, err := z.req(http.MethodGet, "/v2/"+repo+"/tags/list", "", nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s tags: HTTP %d", repo, res.StatusCode)
	}
	var t struct{ Tags []string }
	return t.Tags, json.Unmarshal(body, &t)
}

func (z *zot) deleteTag(repo, tag string) error {
	res, _, err := z.req(http.MethodDelete, "/v2/"+repo+"/manifests/"+tag, "", nil)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusAccepted && res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("DELETE %s:%s: HTTP %d", repo, tag, res.StatusCode)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "zot-users:", err)
		os.Exit(1)
	}
}
