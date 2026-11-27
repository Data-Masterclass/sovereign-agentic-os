// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder release retention (workstream H) - tests of the release-tag parsing and validation.
// USER STORY: As a platform owner I want proof that the keeper only ever tags a release digest in the repository the
//   Deployment itself runs, with a tag of the Deployment's own env, and refuses anything the rollout did not write.
// ARCHITECTURE: go test, run by the image build (images/base/builder/Dockerfile) before the binary is copied.

package main

import (
	"fmt"
	"strings"
	"testing"
)

const (
	hostIn  = "zot.agentic-platform.svc:5000"
	hostOut = "registry.example"
	repoA   = "apps/sales-1a2b3c4d/shop"
	tagDev  = "release-dev-r20261127120000ab12"
)

var (
	dA = "sha256:" + strings.Repeat("a", 64)
	dB = "sha256:" + strings.Repeat("b", 64)
)

func dep(ns, ann string, images ...string) DeploymentImages {
	a := map[string]string{}
	if ann != "" {
		a[ReleaseTagsAnnotation] = ann
	}
	return DeploymentImages{Namespace: ns, Name: "app-sales-shop-0011aabb", Annotations: a, Images: images}
}

func pinsOf(d DeploymentImages) ([]ReleasePin, error) {
	return ReleasePinsOf(d, "apps-dev", "apps-prod", []string{hostIn, hostOut})
}

func TestReleasePinsOfDev(t *testing.T) {
	ann := `{"` + tagDev + `":"` + dA + `","release-dev-r20261127110000cd34":"` + dB + `"}`
	pins, err := pinsOf(dep("apps-dev", ann, hostOut+"/"+repoA+"@"+dA))
	if err != nil {
		t.Fatal(err)
	}
	if len(pins) != 2 || pins[0].Tag != "release-dev-r20261127110000cd34" || pins[0].Digest != dB || pins[1].Digest != dA {
		t.Fatalf("pins = %+v", pins)
	}
	for _, p := range pins {
		if p.Repository != repoA {
			t.Fatalf("repository %q, want the Deployment's own %q", p.Repository, repoA)
		}
	}
}

func TestReleasePinsOfProdInClusterHostAndImageID(t *testing.T) {
	pins, err := pinsOf(dep("apps-prod", `{"release-prod-r20261127120000ab12":"`+dA+`"}`, hostIn+"/"+repoA+"@"+dA))
	if err != nil || len(pins) != 1 || pins[0].Repository != repoA || pins[0].Tag != "release-prod-r20261127120000ab12" {
		t.Fatalf("pins = %+v, err = %v", pins, err)
	}
}

func TestReleasePinsOfNoAnnotationOrEmpty(t *testing.T) {
	for _, ann := range []string{"", "{}"} {
		pins, err := pinsOf(dep("apps-dev", ann, hostOut+"/"+repoA+"@"+dA))
		if err != nil || len(pins) != 0 {
			t.Fatalf("%q: pins = %+v, err = %v", ann, pins, err)
		}
	}
}

func TestReleasePinsOfRefusals(t *testing.T) {
	img := hostOut + "/" + repoA + "@" + dA
	one := `{"` + tagDev + `":"` + dA + `"}`
	cases := map[string]DeploymentImages{
		"prod tag on a Dev Deployment": dep("apps-dev", `{"release-prod-r20261127120000ab12":"`+dA+`"}`, img),
		"dev tag on a Prod Deployment": dep("apps-prod", one, img),
		"namespace outside the envs":   dep("agentic-os", one, img),
		"keep-* is the keeper's own":   dep("apps-dev", `{"keep-`+strings.Repeat("a", 64)+`":"`+dA+`"}`, img),
		"plain tag":                    dep("apps-dev", `{"latest":"`+dA+`"}`, img),
		"id not C2's shape":            dep("apps-dev", `{"release-dev-rdev1":"`+dA+`"}`, img),
		"id with a path":               dep("apps-dev", `{"release-dev-r20261127120000ab12/../x":"`+dA+`"}`, img),
		"capital hex":                  dep("apps-dev", `{"release-dev-r20261127120000AB12":"`+dA+`"}`, img),
		"digest not sha256":            dep("apps-dev", `{"`+tagDev+`":"sha512:`+strings.Repeat("a", 128)+`"}`, img),
		"digest short":                 dep("apps-dev", `{"`+tagDev+`":"sha256:abc"}`, img),
		"not JSON":                     dep("apps-dev", tagDev+"="+dA, img),
		"JSON list":                    dep("apps-dev", `["`+tagDev+`"]`, img),
		"image of a foreign registry":  dep("apps-dev", one, "evil.example/"+repoA+"@"+dA),
		"image by tag, not digest":     dep("apps-dev", one, hostOut+"/"+repoA+":latest"),
		"image outside apps/":          dep("apps-dev", one, hostOut+"/library/node@"+dA),
		"two app repositories":         dep("apps-dev", one, img, hostOut+"/apps/hr-99887766/shop@"+dB),
		"no container image at all":    dep("apps-dev", one),
	}
	for name, d := range cases {
		if pins, err := pinsOf(d); err == nil {
			t.Errorf("%s: accepted %+v", name, pins)
		}
	}
	var many []string
	for i := 0; i <= MaxReleasePins; i++ {
		many = append(many, fmt.Sprintf(`"release-dev-r202611271200%02d%04x":"%s"`, i, i, dA))
	}
	if pins, err := pinsOf(dep("apps-dev", "{"+strings.Join(many, ",")+"}", img)); err == nil {
		t.Errorf("more than %d pins accepted: %d", MaxReleasePins, len(pins))
	}
}

func TestEnvOfNamespace(t *testing.T) {
	if EnvOfNamespace("apps-dev", "apps-dev", "apps-prod") != "dev" || EnvOfNamespace("apps-prod", "apps-dev", "apps-prod") != "prod" {
		t.Fatal("configured namespaces")
	}
	if EnvOfNamespace("", "", "apps-prod") != "" || EnvOfNamespace("apps-x", "apps-dev", "apps-prod") != "" {
		t.Fatal("unconfigured namespaces have no env")
	}
}

// A domain push user may never write a release-* (or keep-*) tag: the rendered Zot policy carries the condition on
// every domain's push entry; only the keeper (no condition, its own entry on apps/**) writes them.
func TestPushUsersCannotWriteReleaseTags(t *testing.T) {
	if !strings.Contains(PushTagCondition, `req.reference.startsWith("release-")`) {
		t.Fatal("PushTagCondition must refuse release-*")
	}
	out, err := RenderConfig([]byte(tmpl), "/etc/zot/htpasswd", []User{{"push-sales", strings.Repeat("a", 32), "apps/sales"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `req.reference.startsWith(\"release-\")`) {
		t.Fatalf("no release-* condition for push users:\n%s", out)
	}
}
