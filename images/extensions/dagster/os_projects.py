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

import hashlib
import json
import os
import re
import subprocess
import sys
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

#: A tool call: (argv, cwd, env) -> (returncode, combined output). `env=None` inherits; a dict
#: REPLACES the environment entirely (how `dbt_parse` keeps this container's secrets out of Jinja).
Runner = Callable[..., Tuple[int, str]]


def _run(cmd: Sequence[str], cwd: Optional[str] = None, env: Optional[Mapping[str, str]] = None) -> Tuple[int, str]:
    """Default subprocess runner: (returncode, combined output). Never raises."""
    try:
        p = subprocess.run(
            list(cmd), cwd=cwd, capture_output=True, text=True, timeout=600,
            env=(dict(env) if env is not None else None),
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001 — a failed tool call is data here, not an exception
        return 1, str(e)


def sanitize(name: str) -> str:
    """A Dagster-safe name (`^[A-Za-z0-9_]+$`). LOSSY: `sales-eu` and `sales.eu` both give
    `sales_eu` — use `sanitize_all` whenever several names share one namespace."""
    s = _NAME_RE.sub("_", name or "")
    return s if s and not s[0].isdigit() else f"_{s}"


def sanitize_all(names: Iterable[str]) -> Dict[str, str]:
    """`{original: unique Dagster-safe name}` — review B2-review-M2.

    `sanitize` maps `-` and `.` to `_`, so two domains can collapse onto ONE Dagster name and
    `Definitions(...)` then raises on the duplicate job/schedule — taking the WHOLE code location
    down, not just the colliding domain. Resolution is deterministic and stable: sorted order
    decides, the first claimant keeps the plain form and every later one gets a short digest of its
    ORIGINAL name appended (so a name never changes because an unrelated domain appeared).
    """
    out: Dict[str, str] = {}
    taken: set = set()
    for name in sorted(set(str(n) for n in names)):
        base = sanitize(name)
        candidate = base
        if candidate in taken:
            digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:6]
            candidate = f"{base}_{digest}"
            n = 2
            while candidate in taken:  # pragma: no cover — a sha256 prefix collision
                candidate = f"{base}_{digest}_{n}"
                n += 1
        taken.add(candidate)
        out[name] = candidate
    return out


# ------------------------------------------------------------- dbt parse env --

#: Names carried over from the ambient environment when dbt RENDERS a repository (`dbt parse`).
#: Nothing else is: `dbt parse` evaluates `{{ env_var(...) }}` from the repo's own files, so every
#: variable this process holds would otherwise be readable by authored Jinja — including
#: AGENT_RUNTIME_TOKEN, the cluster-internal bearer the sidecar and the code-server pod carry.
#: Review B2-review-H3. The SINGLE source of truth: `repo-sync.sh` shells out to `--parse` here
#: rather than keeping a second `env -i` list that could drift.
PARSE_ENV_PASSTHROUGH: Tuple[str, ...] = ("PATH", "HOME", "LANG", "DBT_PROFILES_DIR")

#: Fixed values dbt needs to render the generated `profiles.yml`. `OS_PRINCIPAL` is the only
#: `env_var()` with NO default (tabs/data/lib/dbt/project.ts), so parse fails loudly without it;
#: it is a RENDER-only placeholder — a real run gets its principal from `dagster-k8s/config`.
PARSE_ENV_FIXED: Dict[str, str] = {
    "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
    "OS_PRINCIPAL": "repo-sync",
    "TRINO_HOST": "trino",
    "TRINO_PORT": "8080",
    "TRINO_USER": "dbt-runner",
    "TRINO_CATALOG": "iceberg",
}


def parse_env(ambient: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """The COMPLETE environment `dbt parse` runs with — an allowlist, never the inherited one."""
    src = os.environ if ambient is None else ambient
    out: Dict[str, str] = {}
    for name in PARSE_ENV_PASSTHROUGH:
        value = src.get(name)
        if value:
            out[name] = str(value)
    out.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    out.setdefault("HOME", "/tmp")
    out.update(PARSE_ENV_FIXED)
    return out


def dbt_parse(
    project_dir: str,
    run: Runner = _run,
    ambient: Optional[Mapping[str, str]] = None,
) -> Tuple[int, str]:
    """`dbt parse` in `project_dir` under `parse_env()` — writes `target/manifest.json`."""
    return run(
        ["dbt", "parse", "--profiles-dir", ".", "--no-use-colors", "--quiet"],
        project_dir,
        parse_env(ambient),
    )


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
        # Same bound as a source asset's principal: it becomes `OS_PRINCIPAL` in the run pod and the
        # Trino session user for the whole scheduled build (B3-review-L-2).
        if not _PRINCIPAL_RE.match(principal):
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
    """`<domain>__<dataset>`. `sanitize` is idempotent, so pass either the raw domain or the
    collision-free name `sanitize_all` assigned it — `repo.py` passes the latter, and the
    `os/schedule` tag must carry the SAME string (that is how the sensors find the schedule)."""
    return f"{sanitize(domain)}__{sanitize(dataset)}"


def all_job_name(domain: str) -> str:
    """The per-domain job the OS launches with an explicit asset subset (Build / sync now)."""
    return f"{sanitize(domain)}__all"


def maintenance_job_name(domain: str, schema: str) -> str:
    return f"{sanitize(domain)}__maintenance__{sanitize(schema)}"


# --------------------------------------------------------------- source assets --

#: A Trino identifier the OS generator writes. Anything else is REFUSED, not quoted-and-hoped:
#: `observe_sql` interpolates these into SQL, so the allowlist is the whole defence.
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")

#: The shape of an OS principal (a domain name or a uid) — the SAME pattern as
#: `os-ui/core/infra/trino-rules.ts` OS_PRINCIPAL_PATTERN and the chart's
#: `trino.accessControl.principalPattern`.
#:
#: Review B3-review-L-2 asked for `_IDENT_RE` here. That would be WRONG: a principal is not a SQL
#: identifier and legitimately contains `-` and `.` (`sales-eu`), which `_IDENT_RE` rejects — it
#: would drop real datasets. What the validation is actually for is that `principal` becomes the
#: Trino session user (`_trino_rows`) and an `OS_PRINCIPAL` env value in a run tag, so it must not
#: carry whitespace, a newline or a quote. This pattern is exactly that bound, and the one the
#: generated `rules.json` already enforces on the other side.
_PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class SourceAsset:
    """One external (federated) table a sync reads — `os/sources.yml`, engine rebuild B3.

    The Dagster asset key is `[<domain>, <source>, <table>]`: exactly the key dagster-dbt derives
    for the dbt source under the OS's prefixing translator, so OBSERVING this asset describes the
    very node the silver model depends on instead of creating a parallel one.
    """

    source: str
    table: str
    schema: str
    dataset: str
    principal: str
    #: The model that reads it (the sync landing) — the downstream edge in the asset graph.
    downstream: str
    observe: str  # "max_updated" | "row_count"
    cron: str
    database: Optional[str] = None
    updated_column: Optional[str] = None
    #: Minutes after which the source counts as late; None ⇒ no freshness claim.
    freshness_minutes: Optional[int] = None
    enabled: bool = True


def parse_source_assets(text: str) -> List[SourceAsset]:
    """`os/sources.yml` → source assets. An entry the probe could not safely query is DROPPED.

    Dropped, not degraded: an entry whose catalog/schema/table/column is not a plain identifier
    cannot be interpolated into the observation SQL, and a half-built probe is worse than none.
    """
    doc = _load_yaml(text) or {}
    entries = doc.get("source_assets", []) if isinstance(doc, dict) else []
    out: List[SourceAsset] = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        source = str(e.get("source") or "").strip()
        table = str(e.get("table") or "").strip()
        schema = str(e.get("schema") or "").strip()
        dataset = str(e.get("dataset") or "").strip()
        principal = str(e.get("principal") or "").strip()
        downstream = str(e.get("downstream") or "").strip()
        observe = str(e.get("observe") or "").strip()
        cron = str(e.get("cron") or "").strip()
        database = str(e.get("database") or "").strip() or None
        updated = str(e.get("updated_column") or "").strip() or None
        if not (source and table and schema and dataset and principal and downstream and cron):
            continue
        if observe not in ("max_updated", "row_count"):
            continue
        if observe == "max_updated" and not updated:
            continue
        if not all(_IDENT_RE.match(v) for v in (table, schema, *( [database] if database else [] ), *( [updated] if updated else [] ))):
            continue
        # The principal reaches Trino as the session user and a run-pod env value — validate its
        # SHAPE and DROP the entry otherwise, never sanitize it into a different identity (L-2).
        if not _PRINCIPAL_RE.match(principal):
            continue
        fresh = e.get("freshness_minutes")
        minutes = int(fresh) if isinstance(fresh, int) and fresh > 0 else None
        out.append(
            SourceAsset(
                source=source,
                table=table,
                schema=schema,
                dataset=dataset,
                principal=principal,
                downstream=downstream,
                observe=observe,
                cron=cron,
                database=database,
                updated_column=updated,
                freshness_minutes=minutes,
                enabled=_as_bool(e.get("enabled", True)),
            )
        )
    return sorted(out, key=lambda a: (a.source, a.table))


def observe_job_name(domain: str, cron: str) -> str:
    """`<domain>__observe_<digest>` — the job that OBSERVES every enabled source sharing one cron.

    Engine rebuild B3 created the observable source assets but put them in no job and no schedule,
    so nothing ever observed them: the freshness checks had no observation to measure and the asset
    graph showed a node that never got a data version (B3-review-M-3). One job per DISTINCT cron
    (an observation is one `select count(*)`, so grouping is pure saving), named from a digest of
    the cron so the name is stable when an unrelated source is added or removed.
    """
    return f"{sanitize(domain)}__observe_{hashlib.sha256(cron.encode('utf-8')).hexdigest()[:6]}"


def observe_crons(assets: Iterable[SourceAsset]) -> Dict[str, List[SourceAsset]]:
    """`{cron: [enabled source assets on it]}`, cron-sorted. DISABLED sources are left out — their
    asset still exists (the graph and the lineage view keep the node) but nothing schedules it."""
    out: Dict[str, List[SourceAsset]] = {}
    for a in sorted(assets, key=lambda x: (x.source, x.table)):
        if not a.enabled:
            continue
        out.setdefault(a.cron, []).append(a)
    return {cron: out[cron] for cron in sorted(out)}


def observe_tags(domain: str, assets: Sequence[SourceAsset], sha: str, pinned: str, schedule: str) -> Dict[str, str]:
    """Run tags for an observation. `OS_PRINCIPAL` is set only when every source in the group has
    the SAME principal — the probe connects as `a.principal` itself, so the env is informational,
    and a wrong single value would be worse than none."""
    tags = base_tags(domain, sha, pinned)
    principals = sorted({a.principal for a in assets})
    env = {"OS_PINNED_COMMITS": pinned}
    if len(principals) == 1:
        tags["os/principal"] = principals[0]
        env["OS_PRINCIPAL"] = principals[0]
    tags.update(
        {
            "os/schedule": schedule,
            "os/action": "observe external sources",
            "os/sources": ",".join(f"{a.source}.{a.table}" for a in assets),
            "dagster-k8s/config": k8s_env_tag(env),
        }
    )
    return tags


def source_asset_key(domain: str, a: SourceAsset) -> List[str]:
    """`[<domain>, <source>, <table>]` — the key dagster-dbt gives the dbt source."""
    return [domain, a.source, a.table]


def observe_sql(a: SourceAsset) -> str:
    """The ONE read an observation performs, as the asset's own principal.

    `max_updated` → the newest cursor value plus the row count (the same column the incremental
    model filters on, so "the source moved" and "the sync has work" are the same fact).
    `row_count`   → the row count alone, which is all a non-timestamp cursor supports.
    Every identifier was allowlisted by `parse_source_assets`; nothing user-authored reaches here.
    """
    rel = ".".join(p for p in (a.database, a.schema, a.table) if p)
    if a.observe == "max_updated" and a.updated_column:
        return f'select max("{a.updated_column}") as max_updated, count(*) as row_count from {rel}'
    return f"select count(*) as row_count from {rel}"


def freshness_seconds(a: SourceAsset) -> Optional[int]:
    """The freshness window in seconds, or None when the generator made no claim."""
    return a.freshness_minutes * 60 if a.freshness_minutes else None


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
    #: `os/sources.yml` — the federated tables a sync reads, as OBSERVABLE source assets (B3).
    source_assets: List["SourceAsset"] = field(default_factory=list)


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


def pinned_one(domain: str, sha: str) -> str:
    """`OS_PINNED_COMMITS` for ONE domain — what a run pod of that domain's job needs.

    Review B2-review-L4: baking the WHOLE workspace's pin list into every run tag made each run
    pod clone and `dbt parse` every domain before it could start (cold-start cost linear in the
    number of domains). A schedule, a maintenance job and an OS launch each touch exactly one
    domain, so they pin exactly that one.
    """
    return f"{domain}={sha}"


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
    source_assets: List[SourceAsset] = []
    src_path = os.path.join(sha_dir, "os", "sources.yml")
    if os.path.isfile(src_path):
        try:
            with open(src_path, encoding="utf-8") as fh:
                source_assets = parse_source_assets(fh.read())
        except Exception as e:  # noqa: BLE001 — one unreadable file must not drop the domain
            source_assets = []
            del e
    return (
        Project(
            domain=domain,
            path=sha_dir,
            sha=sha,
            manifest=manifest,
            schedules=schedules,
            schemas=schemas_from_manifest(manifest, domain),
            source_assets=source_assets,
        ),
        None,
    )


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

    `env` is the AMBIENT environment `parse_env` filters (default `os.environ`) — the parse itself
    never inherits it.
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
    # `dbt parse` renders the repository's Jinja — it runs with an ALLOWLISTED environment
    # (`parse_env`), never this pod's, so no authored `{{ env_var(...) }}` can read a secret.
    code, out = dbt_parse(sha_dir, run, env)
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


def schedule_tags(domain: str, s: Schedule, sha: str, pinned: str, schedule: Optional[str] = None) -> Dict[str, str]:
    """Run tags for a scheduled sync: who (principal), what (dataset), from which commit.

    `schedule` is the schedule's REAL Dagster name (the quarantine sensor pauses by it); it
    defaults to `schedule_name(domain, dataset)` and differs only for a sanitize collision.
    """
    tags = base_tags(domain, sha, pinned)
    tags.update(
        {
            "os/dataset": s.dataset,
            "os/principal": s.principal,
            "os/schedule": schedule or schedule_name(domain, s.dataset),
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
#: The statuses a FINISHED run can have. `consecutive_failures` counts over TERMINAL runs only —
#: review B2-review-L3: a query that returns in-flight runs too silently shortens the window
#: (10 failures plus one STARTED run reads as 9), so the caller must FILTER, not post-filter.
TERMINAL_STATUSES = ("SUCCESS", "FAILURE", "CANCELED")


def consecutive_failures(statuses_newest_first: Iterable[str]) -> int:
    """Trailing consecutive FAILUREs; CANCELED / in-flight runs are not evidence and are skipped.

    Pass TERMINAL runs only (see `TERMINAL_STATUSES`): a list truncated by in-flight runs
    under-counts, which would leave a dead schedule running forever.
    """
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


# ----------------------------------------------------------------- timezones --


def safe_timezone(name: Optional[str], default: str = "UTC") -> str:
    """A tz name `ZoneInfo` actually knows, else `default` (review B2-review-L1).

    `os/schedules.yml` carries an author-supplied `timezone`; Dagster raises on an unknown one at
    definition time, which would take the whole code location down for one bad repo. An unknown
    name degrades to UTC — the value the OS has always scheduled in — and the caller logs it.
    """
    want = (name or "").strip()
    if not want:
        return default
    try:
        from zoneinfo import ZoneInfo, available_timezones

        if want in available_timezones():
            return want
        ZoneInfo(want)  # some platforms resolve names the set does not enumerate
        return want
    except Exception:  # noqa: BLE001 — an unknown or unavailable tz is data, not an exception
        return default


# --------------------------------------------------------------- definitions --


def partition_definitions(
    bundles: Sequence[Tuple[str, dict]],
    build: Callable[[dict], object],
    merge: Callable[[dict, dict], dict],
    empty: Callable[[], dict],
) -> Tuple[object, List[Skipped]]:
    """Build ONE object out of per-domain bundles, dropping only the domains that break it.

    Review B2-review-M2: `Definitions(...)` validates globally (duplicate job / schedule / asset
    names, bad selections), so a single malformed domain raised there and the ENTIRE code location
    failed to load — every other domain's schedules with it. The happy path is still one `build`
    call; only when that raises do we probe domain by domain and report the offenders.
    """
    allowed = empty()
    for _, bundle in bundles:
        allowed = merge(allowed, bundle)
    try:
        return build(allowed), []
    except Exception:  # noqa: BLE001 — fall back to per-domain probing below
        pass
    accepted = empty()
    skipped: List[Skipped] = []
    for domain, bundle in bundles:
        trial = merge(accepted, bundle)
        try:
            build(trial)
        except Exception as e:  # noqa: BLE001 — per-domain gating is the point
            skipped.append(Skipped(domain, f"{type(e).__name__}: {e}"))
            continue
        accepted = trial
    # Built LAST from exactly the accepted set, so anything the caller derives from the build
    # (the sensor's schedule→principal map) describes what actually loaded.
    return build(accepted), skipped


# ---------------------------------------------------------------------- cli --


def _main(argv: Sequence[str]) -> int:
    """`os_projects.py --parse <project-dir>` — `dbt parse` under the allowlisted environment.

    `repo-sync.sh` calls this instead of keeping its own `env -i` list, so the allowlist lives in
    exactly ONE place (review B2-review-H3).
    """
    if len(argv) == 3 and argv[1] == "--parse":
        code, out = dbt_parse(argv[2])
        sys.stdout.write(out)
        return code
    if len(argv) == 2 and argv[1] == "--parse-env-names":
        sys.stdout.write("\n".join(sorted(parse_env({}))) + "\n")
        return 0
    sys.stderr.write("usage: os_projects.py --parse <project-dir> | --parse-env-names\n")
    return 2


if __name__ == "__main__":  # pragma: no cover — exercised by repo-sync.sh
    raise SystemExit(_main(sys.argv))
