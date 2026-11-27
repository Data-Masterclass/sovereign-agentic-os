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
//     4. write the node pull Secret (dockerconfigjson for the registry's node-facing host) into each app namespace.
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
		if err := ValidatePushUser(u); err != nil {
			// One malformed Secret must not lock every other domain out: it is reported and left out.
			fmt.Fprintf(os.Stderr, "skip %s/%s: %v\n", pushNS, s.Metadata.Name, err)
			skipped++
			continue
		}
		users = append(users, u)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Name < users[j].Name })

	pullCred, err := k.getSecret(zotNS, pullCredSecret)
	if err != nil {
		return err
	}
	pullPassword := decode(pullCred, "password")
	if pullPassword == "" {
		if pullPassword, err = randomPassword(); err != nil {
			return err
		}
		if _, err := k.putSecret(secret{Metadata: meta{Name: pullCredSecret, Namespace: zotNS, Labels: map[string]string{"app.kubernetes.io/component": "zot"}},
			Type: "Opaque", Data: map[string]string{"username": base64Std(PullUser), "password": base64Std(pullPassword)}}); err != nil {
			return err
		}
	}
	all := append([]User{{Name: PullUser, Password: pullPassword}}, users...)

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
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "zot-users:", err)
		os.Exit(1)
	}
}
