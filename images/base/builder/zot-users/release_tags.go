// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder release retention (workstream H, spec 6.2) - the keeper applies the `release-<env>-<id>` tags.
// USER STORY: As an app builder I want every digest a release record names to stay in the registry, so a rollback to a
//   release no pod runs any more still finds its image, without os-ui ever holding a registry write credential.
// ARCHITECTURE: pure parsing and validation, no I/O. os-ui's rollout (os-ui/tabs/software/lib/releases/rollout.ts)
//   records the tags each env must keep on the app's Deployment, annotation `soa.dev/release-tags` = JSON
//   {"release-<env>-<id>": "sha256:<64 hex>"} (core/adapters/zot/client.ts `releasePins`). The keeper (main.go
//   `keepReleases`) lists the Deployments of apps-dev/apps-prod, and for each one:
//     - the repository is derived from the Deployment's OWN container image (`<registry host>/apps/<key>/<slug>@…`,
//       the image the apps admission policy admitted), never from the annotation; a Deployment whose containers name
//       no app repository, or two different ones, is skipped;
//     - every tag must be `release-<env>-r<14 digits><4 hex>` (C2's `newReleaseId`) with <env> = the env of the
//       namespace the Deployment lives in (a Dev Deployment can never pin a release-prod-* tag), every value a digest;
//     - at most MaxReleasePins pins per Deployment (the rollout writes 10).
//   The keeper then PUTs the digest's existing manifest under the tag in THAT repository with its own identity (a
//   digest the repository does not hold is a no-op). Release tags are never removed: retention keeps release-* for
//   good, and a domain push user can never write one (Zot condition PushTagCondition, render.go).

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
)

// ReleaseTagsAnnotation is os-ui's RELEASE_PINS_ANNOTATION (core/adapters/zot/client.ts).
const ReleaseTagsAnnotation = "soa.dev/release-tags"

// MaxReleasePins bounds the pins one Deployment may ask for (the rollout writes the newest 10).
const MaxReleasePins = 20

var releaseTagRE = regexp.MustCompile(`^release-(dev|prod)-r[0-9]{14}[0-9a-f]{4}$`)

// ReleasePin is one tag to apply: repository, tag, digest.
type ReleasePin struct {
	Repository, Tag, Digest string
}

// DeploymentImages is what the keeper reads of one Deployment.
type DeploymentImages struct {
	Namespace, Name string
	Annotations     map[string]string
	Images          []string
}

// EnvOfNamespace maps the configured app namespaces to their env; any other namespace has none.
func EnvOfNamespace(ns, devNS, prodNS string) string {
	switch {
	case ns != "" && ns == devNS:
		return "dev"
	case ns != "" && ns == prodNS:
		return "prod"
	}
	return ""
}

// DeploymentRepository is the one app repository the Deployment's containers run (hosts: the registry's in-cluster
// and node-facing hosts). The image must be pinned by digest (`…@sha256:`), as every release overlay writes it.
func DeploymentRepository(images []string, hosts []string) (string, error) {
	repo := ""
	for _, img := range images {
		r, _, ok := RunningImage(img, hosts)
		if !ok {
			continue
		}
		if repo != "" && r != repo {
			return "", fmt.Errorf("containers run two app repositories (%s, %s)", repo, r)
		}
		repo = r
	}
	if repo == "" {
		return "", errors.New("no container runs an app repository of this registry by digest")
	}
	return repo, nil
}

// ReleasePinsOf validates one Deployment's annotation and returns the pins to apply, sorted by tag. Without the
// annotation it returns nothing. Any invalid entry refuses the WHOLE annotation (it was not written by the rollout).
func ReleasePinsOf(d DeploymentImages, devNS, prodNS string, hosts []string) ([]ReleasePin, error) {
	raw, ok := d.Annotations[ReleaseTagsAnnotation]
	if !ok {
		return nil, nil
	}
	env := EnvOfNamespace(d.Namespace, devNS, prodNS)
	if env == "" {
		return nil, fmt.Errorf("%s/%s: namespace is not an app env namespace", d.Namespace, d.Name)
	}
	var tags map[string]string
	if err := json.Unmarshal([]byte(raw), &tags); err != nil {
		return nil, fmt.Errorf("%s/%s: %s is not a JSON object of tag -> digest: %v", d.Namespace, d.Name, ReleaseTagsAnnotation, err)
	}
	if len(tags) == 0 {
		return nil, nil
	}
	if len(tags) > MaxReleasePins {
		return nil, fmt.Errorf("%s/%s: %d release tags, at most %d", d.Namespace, d.Name, len(tags), MaxReleasePins)
	}
	repo, err := DeploymentRepository(d.Images, hosts)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %v", d.Namespace, d.Name, err)
	}
	pins := make([]ReleasePin, 0, len(tags))
	for tag, digest := range tags {
		m := releaseTagRE.FindStringSubmatch(tag)
		if m == nil {
			return nil, fmt.Errorf("%s/%s: tag %q is not release-<dev|prod>-<release id>", d.Namespace, d.Name, tag)
		}
		if m[1] != env {
			return nil, fmt.Errorf("%s/%s: tag %q belongs to %s, the Deployment runs in %s", d.Namespace, d.Name, tag, m[1], env)
		}
		if !digestRE.MatchString(digest) {
			return nil, fmt.Errorf("%s/%s: tag %q: %q is not a sha256 digest", d.Namespace, d.Name, tag, digest)
		}
		pins = append(pins, ReleasePin{Repository: repo, Tag: tag, Digest: digest})
	}
	sort.Slice(pins, func(i, j int) bool { return pins[i].Tag < pins[j].Tag })
	return pins, nil
}
