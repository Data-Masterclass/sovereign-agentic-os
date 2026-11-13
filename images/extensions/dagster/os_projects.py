# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Pure helpers for the `sovereign` Dagster code location (engine rebuild B2).

FEATURE:    Discover the validated dbt project of every domain, read `os/schedules.yml`, derive
            the Dagster schedule / job / tag shapes, and decide quarantine + principal pauses —
            without importing Dagster, so `repo.py` stays a thin wiring file and this module is
            unit-tested with `python3 -m unittest` on any machine.
USER STORY: As a data engineer I want my domain's sync schedules to come from the repo
            (`os/schedules.yml`), run in UTC with Dagster's skip-missed-tick semantics, carry the
            dataset / principal / commit as run tags, and pause themselves after repeated failures
            or when the owning principal is deactivated — exactly what I would wire by hand.
ARCHITECTURE:
  - `discover()` lists `<checkout>/<domain>/current -> <sha>` (maintained by repo-sync.sh) or the
    commits pinned in `OS_PINNED_COMMITS` (how a K8s run pod, whose emptyDir starts EMPTY, learns
    which commit to check out — see `ensure_checkout`). A domain without a parsed manifest is
    skipped with a reason, never fatal: one broken repo cannot take the location down.
  - Everything here is a pure function of the file tree + env; the only subprocesses are `git`
    and `dbt parse`, both injected (`run=`) so tests never shell out.
  - Tag values are strings; `dagster-k8s/config` is JSON — the K8s run launcher reads the run
    pod's env from it (OS_PRINCIPAL = the Trino user dbt impersonates, OS_PINNED_COMMITS = the
    commits the run pod must check out).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

DEFAULT_CHECKOUT = "/repos-checkout"
DEFAULT_GIT_BASE = "git://os-repos"
#: Consecutive failures after which a schedule is paused (the OS's QUARANTINE_THRESHOLD).
QUARANTINE_THRESHOLD = 10
#: Weekly Iceberg maintenance (optimize + expire_snapshots), Sunday 03:00 UTC.
MAINTENANCE_CRON = "0 3 * * 0"

_DOMAIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_NAME_RE = re.compile(r"[^A-Za-z0-9_]")

Runner = Callable[[Sequence[str], Optional[str]], Tuple[int, str]]


def _run(cmd: Sequence[str], cwd: Optional[str] = None) -> Tuple[int, str]:
    """Default subprocess runner: (returncode, combined output). Never raises."""
    try:
        p = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, timeout=600)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001 — a failed tool call is data here, not an exception
        return 1, str(e)


def sanitize(name: str) -> str:
    """A Dagster-safe name (`^[A-Za-z0-9_]+$`)."""
    s = _NAME_RE.sub("_", name or "")
    return s if s and not s[0].isdigit() else f"_{s}"


# ------------------------------------------------------------------ schedules --


@dataclass(frozen=True)
class Schedule:
    dataset: str
    model: str
    select: str
    cron: str
    principal: str
    enabled: bool
    timezone: str = "UTC"


def _as_bool(v: object) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "yes", "1")


def _load_yaml(text: str) -> object:
    try:
        import yaml  # PyYAML ships with dbt-core in the image

        return yaml.safe_load(text)
    except ImportError:  # pragma: no cover — only on a machine without PyYAML
        return json.loads(text)


def parse_schedules(text: str) -> List[Schedule]:
    """`os/schedules.yml` → schedules. Unknown or malformed entries are dropped, never guessed."""
    doc = _load_yaml(text) or {}
    entries = doc.get("schedules", []) if isinstance(doc, dict) else []
    out: List[Schedule] = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        dataset = str(e.get("dataset") or "").strip()
        model = str(e.get("name") or "").strip()
        cron = str(e.get("cron") or "").strip()
        principal = str(e.get("principal") or "").strip()
        if not (dataset and model and cron and principal):
            continue
        if len(cron.split()) != 5:
            continue
        out.append(
            Schedule(
                dataset=dataset,
                model=model,
                select=str(e.get("select") or f"{model}+").strip(),
                cron=cron,
                principal=principal,
                enabled=_as_bool(e.get("enabled", True)),
                timezone=str(e.get("timezone") or "UTC"),
            )
        )
    return sorted(out, key=lambda s: s.dataset)


def schedule_name(domain: str, dataset: str) -> str:
    return f"{sanitize(domain)}__{sanitize(dataset)}"


def all_job_name(domain: str) -> str:
    """The per-domain job the OS launches with an explicit asset subset (Build / sync now)."""
    return f"{sanitize(domain)}__all"


def maintenance_job_name(domain: str, schema: str) -> str:
    return f"{sanitize(domain)}__maintenance__{sanitize(schema)}"


# -------------------------------------------------------------------- projects --


@dataclass
class Project:
    domain: str
    #: The checked-out commit directory (`<checkout>/<domain>/<sha>`), never the symlink.
    path: str
    sha: str
    manifest: str
    schedules: List[Schedule] = field(default_factory=list)
    #: Iceberg schema → OS principal that owns it (domain schema → domain; personal_<uid> → uid).
    schemas: Dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Skipped:
    domain: str
    reason: str


def parse_pinned(value: Optional[str]) -> Dict[str, str]:
    """`OS_PINNED_COMMITS="sales=<sha>,finance=<sha>"` → {domain: sha}. Bad entries are ignored."""
    out: Dict[str, str] = {}
    for part in (value or "").split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        dom, sha = part.split("=", 1)
        dom, sha = dom.strip(), sha.strip().lower()
        if _DOMAIN_RE.match(dom) and ".." not in dom and _SHA_RE.match(sha):
            out[dom] = sha
    return out


def pinned_env(projects: Iterable[Project]) -> str:
    return ",".join(f"{p.domain}={p.sha}" for p in sorted(projects, key=lambda p: p.domain))


def current_sha(domain_dir: str) -> Optional[str]:
    """Resolve `<domain>/current` (a symlink to `<sha>`) to the sha, or None."""
    link = os.path.join(domain_dir, "current")
    try:
        target = os.readlink(link)
    except OSError:
        return None
    sha = os.path.basename(target.rstrip("/"))
    return sha if _SHA_RE.match(sha) else None


def schemas_from_manifest(manifest_path: str, domain: str) -> Dict[str, str]:
    """Which Iceberg schemas this project writes, and which principal owns each.

    The domain schema is owned by the domain principal (what the OS uses for domain writes); a
    `personal_<uid>` schema by its uid, read from the models' `meta.os_owner` (the generator
    writes it). A schema whose owner cannot be determined is left out — maintenance never
    guesses a principal.
    """
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError):
        return {}
    out: Dict[str, str] = {}
    for node in (manifest.get("nodes") or {}).values():
        if node.get("resource_type") != "model":
            continue
        schema = str(node.get("schema") or "")
        if not schema:
            continue
        meta = dict((node.get("meta") or {}))
        meta.update((node.get("config") or {}).get("meta") or {})
        owner = str(meta.get("os_owner") or "")
        if schema.startswith("personal_"):
            if owner:
                out[schema] = owner
        else:
            out[schema] = domain
    return dict(sorted(out.items()))


def load_project(domain: str, sha_dir: str, sha: str) -> Tuple[Optional[Project], Optional[Skipped]]:
    manifest = os.path.join(sha_dir, "target", "manifest.json")
    if not os.path.isfile(manifest):
        return None, Skipped(domain, f"no target/manifest.json in {sha_dir} (dbt parse did not run or failed)")
    schedules: List[Schedule] = []
    sched_path = os.path.join(sha_dir, "os", "schedules.yml")
    if os.path.isfile(sched_path):
        try:
            with open(sched_path, encoding="utf-8") as fh:
                schedules = parse_schedules(fh.read())
        except Exception as e:  # noqa: BLE001
            return None, Skipped(domain, f"os/schedules.yml unreadable: {e}")
    return Project(domain=domain, path=sha_dir, sha=sha, manifest=manifest, schedules=schedules, schemas=schemas_from_manifest(manifest, domain)), None


def ensure_checkout(
    domain: str,
    sha: str,
    checkout: str = DEFAULT_CHECKOUT,
    git_base: str = DEFAULT_GIT_BASE,
    run: Runner = _run,
    env: Optional[Mapping[str, str]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Make `<checkout>/<domain>/<sha>` exist with a parsed manifest. Returns (dir, error).

    Used by a RUN POD, whose `/repos-checkout` emptyDir starts empty: clone the domain's repo from
    the read-only git daemon at the pinned commit and `dbt parse` it. In the user-code pod the
    sidecar has already done this and the directory exists, so this is a no-op there.
    """
    if not (_DOMAIN_RE.match(domain) and ".." not in domain and _SHA_RE.match(sha)):
        return None, f"refusing to check out '{domain}@{sha}': invalid name or sha"
    dom_dir = os.path.join(checkout, domain)
    sha_dir = os.path.join(dom_dir, sha)
    if os.path.isfile(os.path.join(sha_dir, "target", "manifest.json")):
        return sha_dir, None
    os.makedirs(dom_dir, exist_ok=True)
    if not os.path.isdir(os.path.join(sha_dir, ".git")):
        tmp = sha_dir + ".tmp"
        run(["rm", "-rf", tmp], None)
        code, out = run(["git", "clone", "--quiet", "--no-checkout", f"{git_base}/{domain}.git", tmp], None)
        if code != 0:
            return None, f"git clone {domain} failed: {out.strip()[:400]}"
        code, out = run(["git", "-C", tmp, "checkout", "--quiet", "--detach", sha], None)
        if code != 0:
            run(["rm", "-rf", tmp], None)
            return None, f"commit {sha} not in {domain}: {out.strip()[:400]}"
        os.replace(tmp, sha_dir)
    code, out = run(["dbt", "parse", "--profiles-dir", ".", "--no-use-colors", "--quiet"], sha_dir)
    if code != 0 or not os.path.isfile(os.path.join(sha_dir, "target", "manifest.json")):
        return None, f"dbt parse failed for {domain}@{sha[:7]}: {out.strip()[-600:]}"
    return sha_dir, None


def discover(
    checkout: str = DEFAULT_CHECKOUT,
    pinned: Optional[Mapping[str, str]] = None,
    git_base: str = DEFAULT_GIT_BASE,
    run: Runner = _run,
) -> Tuple[List[Project], List[Skipped]]:
    """Every loadable project. Pinned commits win; otherwise `<domain>/current` as repo-sync left it."""
    projects: List[Project] = []
    skipped: List[Skipped] = []
    seen = set()
    for domain, sha in sorted((pinned or {}).items()):
        seen.add(domain)
        sha_dir, err = ensure_checkout(domain, sha, checkout, git_base, run)
        if err:
            skipped.append(Skipped(domain, err))
            continue
        p, s = load_project(domain, sha_dir or "", sha)
        (projects.append(p) if p else skipped.append(s))  # type: ignore[arg-type]
    if os.path.isdir(checkout):
        for domain in sorted(os.listdir(checkout)):
            if domain in seen or domain.startswith(".") or not _DOMAIN_RE.match(domain):
                continue
            dom_dir = os.path.join(checkout, domain)
            if not os.path.isdir(dom_dir):
                continue
            sha = current_sha(dom_dir)
            if not sha:
                skipped.append(Skipped(domain, "no validated commit yet (repo-sync has not repointed `current`)"))
                continue
            p, s = load_project(domain, os.path.join(dom_dir, sha), sha)
            (projects.append(p) if p else skipped.append(s))  # type: ignore[arg-type]
    return projects, skipped


# ------------------------------------------------------------------------ tags --


def k8s_env_tag(env: Mapping[str, str]) -> str:
    """The `dagster-k8s/config` tag: env the K8s run launcher injects into the run pod."""
    return json.dumps(
        {"container_config": {"env": [{"name": k, "value": str(v)} for k, v in sorted(env.items())]}},
        separators=(",", ":"),
        sort_keys=True,
    )


def base_tags(domain: str, sha: str, pinned: str) -> Dict[str, str]:
    return {"os/domain": domain, "os/commit": sha, "os/pinned": pinned}


def schedule_tags(domain: str, s: Schedule, sha: str, pinned: str) -> Dict[str, str]:
    """Run tags for a scheduled sync: who (principal), what (dataset), from which commit."""
    tags = base_tags(domain, sha, pinned)
    tags.update(
        {
            "os/dataset": s.dataset,
            "os/principal": s.principal,
            "os/schedule": schedule_name(domain, s.dataset),
            "os/action": "scheduled sync",
            "dagster-k8s/config": k8s_env_tag({"OS_PRINCIPAL": s.principal, "OS_PINNED_COMMITS": pinned}),
        }
    )
    return tags


def maintenance_tags(domain: str, schema: str, principal: str, sha: str, pinned: str) -> Dict[str, str]:
    tags = base_tags(domain, sha, pinned)
    tags.update(
        {
            "os/principal": principal,
            "os/schema": schema,
            "os/action": "iceberg maintenance",
            "dagster-k8s/config": k8s_env_tag({"OS_PRINCIPAL": principal, "OS_PINNED_COMMITS": pinned}),
        }
    )
    return tags


def all_job_tags(domain: str, sha: str, pinned: str) -> Dict[str, str]:
    """The OS-launched job carries no principal of its own: the OS sets OS_PRINCIPAL per launch."""
    tags = base_tags(domain, sha, pinned)
    tags["dagster-k8s/config"] = k8s_env_tag({"OS_PINNED_COMMITS": pinned})
    return tags


# ---------------------------------------------------------------- quarantine --

TERMINAL_FAILURE = {"FAILURE"}
TERMINAL_SUCCESS = {"SUCCESS"}


def consecutive_failures(statuses_newest_first: Iterable[str]) -> int:
    """Trailing consecutive FAILUREs; CANCELED / in-flight runs are not evidence and are skipped."""
    n = 0
    for s in statuses_newest_first:
        s = str(s).upper()
        if s in TERMINAL_SUCCESS:
            break
        if s in TERMINAL_FAILURE:
            n += 1
    return n


def should_pause(statuses_newest_first: Iterable[str], threshold: int = QUARANTINE_THRESHOLD) -> bool:
    return consecutive_failures(statuses_newest_first) >= threshold


# ---------------------------------------------------------------- principals --


def fetch_index(url: str, token: Optional[str], timeout: float = 5.0) -> Optional[dict]:
    """`GET /api/data/projects` (cluster-internal, runtime bearer). None when unreachable."""
    if not url:
        return None
    req = urllib.request.Request(url, headers={"accept": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 — cluster-internal URL from env
            return json.loads(res.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — unreachable is a normal state for a sensor
        return None


def inactive_principals(index: Mapping[str, object]) -> set:
    """Principals the OS reports as inactive, from the index's per-domain `principals` list."""
    out = set()
    for d in index.get("domains", []) or []:  # type: ignore[union-attr]
        if not isinstance(d, dict):
            continue
        for p in d.get("principals", []) or []:
            if isinstance(p, dict) and p.get("id") and p.get("active") is False:
                out.add(str(p["id"]))
    return out


def schedules_to_pause(schedule_principals: Mapping[str, str], inactive: Iterable[str]) -> List[str]:
    """Schedules whose principal is inactive — pause-only; resuming is a human decision."""
    bad = set(inactive)
    return sorted(name for name, principal in schedule_principals.items() if principal in bad)
