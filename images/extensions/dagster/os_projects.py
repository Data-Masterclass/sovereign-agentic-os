# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Pure helpers for the `sovereign` Dagster code location — the platform wrapper (WP-49).

FEATURE:    Find each domain repo's own Dagster code location (`data/dagster/definitions.py`),
            check it is byte-for-byte what the OS generated, and decide the platform's run tags,
            quarantine and principal pauses — without importing Dagster, so `repo.py` stays a thin
            wiring file and this module is unit-tested with `python3 -m unittest` on any machine.
            For one release, a repo that is NOT migrated to the design-12 layout (no `os/layout.yml`)
            or carries no `os/generated.yml` keeps the LEGACY path: its schedules come from
            `os/schedules.yml` exactly as before WP-49, so no domain loses a schedule.
USER STORY: As a data engineer I want the schedules, assets and checks Dagster runs to be the plain
            Dagster code in my repo, runnable from a clone with `dagster dev`, while the platform
            only adds what a shared deployment needs: which commit a run pod checks out, the
            principal's environment, and pausing a failing or orphaned schedule.
ARCHITECTURE:
  - `discover()` lists `<checkout>/<domain>/current -> <sha>` (maintained by repo-sync.sh) or the
    commits pinned in `OS_PINNED_COMMITS` (how a K8s run pod, whose emptyDir starts EMPTY, learns
    which commit to check out — see `ensure_checkout`). A domain without a parsed manifest, or
    whose definitions do not match the recorded hash, is skipped with a reason, never fatal.
  - The dbt project directory comes from the repo's layout marker (`dbt_dir`, WP-55); the Dagster
    module path and the hash record mirror `os-ui/core/infra/data-layout.ts` (a test asserts it).
  - Tag values are strings. The run worker derives its env from the TAGS (`run_tag_env`:
    os/principal = the Trino user dbt impersonates and the dlt destination user, os/pinned = the
    commit the run pod must check out). No `dagster-k8s/config` tag is ever set: the launcher
    lock-down refuses it.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
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

#: Repository layout (component design 12, `os-ui/core/infra/repo-layout.ts`). A repo carrying the
#: marker `os/layout.yml` is v2, and the marker itself names its dbt project directory
#: (`dbt_project_dir:`, written by os-ui from its ONE config value `OS_DBT_PROJECT_DIR`, default
#: `data/dbt`) — so this image reads the setting from the repository, never from a second copy.
#: Without the marker (v1) the project is at the repo root. `os/` is at the repo root in both.
LAYOUT_MARKER = os.path.join("os", "layout.yml")
DOMAIN_REPO_PREFIX = "domain-"
DEFAULT_DBT_PROJECT_DIR = "data/dbt"
#: The repo's own Dagster code location (design 12; os-ui/core/infra/data-layout.ts), WP-49.
DAGSTER_DEFINITIONS_PATH = "data/dagster/definitions.py"
#: OS layer: sha256 of every generated native file the platform executes (artifact contract C5).
GENERATED_PATH = "os/generated.yml"


def _valid_rel_dir(raw: str) -> str:
    raw = raw.strip().strip("'\"").strip("/")
    if not raw or any(seg in ("", ".", "..") for seg in raw.split("/")):
        raise ValueError(f"dbt project dir {raw!r} is not a repo-relative directory")
    return raw


def dbt_dir(repo_dir: str) -> str:
    """The dbt project directory of a checked-out repo: the marker's `dbt_project_dir` (v2) or `<repo>` (v1)."""
    marker = os.path.join(repo_dir, LAYOUT_MARKER)
    if not os.path.isfile(marker):
        return repo_dir
    rel = DEFAULT_DBT_PROJECT_DIR
    with open(marker, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("dbt_project_dir:"):
                rel = line.split(":", 1)[1]
    return os.path.join(repo_dir, _valid_rel_dir(rel))
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_NAME_RE = re.compile(r"[^A-Za-z0-9_]")

#: A tool call: (argv, cwd, env) -> (returncode, combined output). `env=None` inherits; a dict
#: REPLACES the environment entirely (how `dbt_parse` keeps this container's secrets out of Jinja).
Runner = Callable[..., Tuple[int, str]]


#: Exit codes `_run` uses for a call that did not END in the tool's own verdict.
RC_TIMEOUT = 124
RC_NOT_RUN = 126


def _run(
    cmd: Sequence[str], cwd: Optional[str] = None, env: Optional[Mapping[str, str]] = None, timeout: float = 600,
) -> Tuple[int, str]:
    """Default subprocess runner: (returncode, combined output). Never raises.

    A timeout is RC_TIMEOUT and a call that could not start is RC_NOT_RUN, never 1, so a caller can
    tell "the tool said no" from "the tool did not finish" (a killed process keeps its negative rc).
    """
    try:
        p = subprocess.run(
            list(cmd), cwd=cwd, capture_output=True, text=True, timeout=timeout,
            env=(dict(env) if env is not None else None),
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return RC_TIMEOUT, f"{cmd[0]} did not finish within {timeout:g}s (timed out)"
    except Exception as e:  # noqa: BLE001 — a failed tool call is data here, not an exception
        return RC_NOT_RUN, str(e)


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
#: it is a RENDER-only placeholder — a real run gets its principal from its `os/principal` tag.
PARSE_ENV_FIXED: Dict[str, str] = {
    "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
    "OS_PRINCIPAL": "repo-sync",
    "TRINO_HOST": "trino",
    "TRINO_PORT": "8080",
    "TRINO_USER": "dbt-runner",
    "TRINO_CATALOG": "iceberg",
    # WP-15: a password-method profile names these with no default. `dbt parse` renders the
    # profile but never connects, so placeholders are enough — no credential reaches a parse.
    "DBT_ENV_SECRET_TRINO_PASSWORD": "parse-only-placeholder",
    "TRINO_CA_FILE": "/dev/null",
}


#: What a dbt RUN (build, run-operation) inherits from the run pod: dbt's own settings, the Trino
#: connection the generated profiles.yml reads, the principal, and what a process needs to start.
#: Exact names, never a prefix. Nothing else — the pod also holds the Dagster instance-database login and other credentials,
#: and a model can render any variable with `env_var()`. dagster-dbt adds its own `DBT_*` and
#: `DAGSTER_DBT_CLI` on top (dagster_dbt.core.resource.DbtCliResource.cli).
DBT_RUN_ENV_NAMES: Tuple[str, ...] = (
    # A process's basics.
    "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "USER", "PWD",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    # dbt's own settings a run passes.
    "DBT_PROFILES_DIR", "DBT_PROJECT_DIR", "DBT_TARGET", "DBT_SEND_ANONYMOUS_USAGE_STATS",
    # Exactly the variables the OS-generated profiles.yml reads (os-ui tabs/data/lib/dbt/project.ts),
    # by name: a new TRINO_* or DBT_ENV_* variable stays invisible until it is added here.
    "TRINO_HOST", "TRINO_PORT", "TRINO_USER", "TRINO_CATALOG", "TRINO_HTTP_SCHEME",
    "TRINO_TLS_PORT", "TRINO_RUNNER_USER", "TRINO_CA_FILE", "DBT_ENV_SECRET_TRINO_PASSWORD",
    "OS_PRINCIPAL",
)


#: Directories dbt writes (or fetches into) that a checked-out repository must never be trusted for.
BUILD_OUTPUT_DIRS: Tuple[str, ...] = ("target", "logs", "dbt_packages")


def dbt_cli_env(ambient: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """`dbt_run_env` plus `DBT_PARTIAL_PARSE=false`: a dbt RUN never uses a parse cache."""
    return {**dbt_run_env(ambient), "DBT_PARTIAL_PARSE": "false"}


def dbt_run_env(ambient: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """The allowlisted subset of `ambient` (default: this process's env) a dbt run may see."""
    src = os.environ if ambient is None else ambient
    return {k: v for k, v in src.items() if k in DBT_RUN_ENV_NAMES}


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
    """`dbt parse` in `project_dir` under `parse_env()` — writes `target/manifest.json`.

    Starts from nothing: a repository can carry `target/` (a pushed `partial_parse.msgpack` makes dbt
    use the SQL inside it instead of the files, a pushed `manifest.json` looks like a parsed project),
    `logs/` and `dbt_packages/` (fetched code). They are removed, and `--no-partial-parse` makes dbt
    ignore any cache regardless.
    """
    for sub in BUILD_OUTPUT_DIRS:
        shutil.rmtree(os.path.join(project_dir, sub), ignore_errors=True)
    return run(
        ["dbt", "--no-partial-parse", "parse", "--profiles-dir", ".", "--no-use-colors", "--quiet"],
        project_dir,
        parse_env(ambient),
    )


#: dbt's own "no" — what it prints when it refuses a project (dbt-core 1.9: "Encountered an error",
#: then the error kind such as "Parsing Error" / "Compilation Error" / "Runtime Error").
_DBT_REFUSAL = re.compile(r"Encountered an error|^\s*\w+ Error\b", re.M)


def is_dbt_refusal(code: int, output: str) -> bool:
    """True only when dbt itself ran to the end and refused the project: its exit code (1 = error,
    2 = unhandled/parse failure) AND its error text. A timeout, a signal (an OOM kill is -9) or a
    tool that never started is NOT a refusal — the same commit may parse on the next pass, so it
    must never be cached as failed (WP-03 verifier finding 8)."""
    return code in (1, 2) and bool(_DBT_REFUSAL.search(output or ""))


#: `--parse` exit codes for repo-sync: 0 parsed, 1 dbt refused (cache it), 75 did not finish (retry).
PARSE_OK, PARSE_REFUSED, PARSE_TRANSIENT = 0, 1, 75


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
    #: The OS-generated models of the schedule's owner (written by the OS): the run may select only these.
    models: Tuple[str, ...] = ()
    #: The same models as exact project file paths: what the selection uses. A bare model name that
    #: equals a directory name would select the whole directory (dbt's name/fqn method).
    paths: Tuple[str, ...] = ()
    #: The schedule's standing run grant (WP-15), written by the OS; '' when the OS issued none.
    run_grant: str = ""


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
                models=tuple(n for n in (str(x).strip() for x in (e.get("models") or [])) if re.match(r"^[A-Za-z0-9_]+$", n)),
                paths=tuple(p for p in (str(x).strip() for x in (e.get("paths") or [])) if re.match(r"^models/[A-Za-z0-9_./-]+\.sql$", p) and ".." not in p),
                run_grant=_grant_id(e.get("run_grant")),
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
    if len(principals) == 1:
        tags["os/principal"] = principals[0]
    tags.update(
        {
            "os/schedule": schedule,
            "os/action": "observe external sources",
            "os/sources": ",".join(f"{a.source}.{a.table}" for a in assets),
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
    #: WP-49: the repo's own `data/dagster/definitions.py`, verified against `os/generated.yml`.
    #: None ⇒ the LEGACY path (an unmigrated repo, or one the OS has not generated it for yet):
    #: `schedules` / `source_assets` from `os/*.yml` drive the wiring, as before WP-49.
    definitions: Optional[str] = None


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


def read_generated_owners(repo_dir: str) -> Optional[Dict[str, str]]:
    """`owners:` of `<repo>/os/generated.yml`: which owner each OS-generated model belongs to.

    `os/**` is unpushable, so no author can add a model here; a model's own `meta` can say anything and
    is never consulted. None when the file or the map is missing (not a native repo: cannot judge)."""
    try:
        with open(os.path.join(repo_dir, "os", "generated.yml"), encoding="utf-8") as fh:
            doc = _load_yaml(fh.read())
    except OSError:
        return None
    owners = doc.get("owners") if isinstance(doc, dict) else None
    if not isinstance(owners, dict):
        return None
    return {str(k): str(v) for k, v in owners.items()}


def out_of_lane_models(owners: Mapping[str, str], selected: Iterable[str], principal: str) -> List[str]:
    """Which of the `selected` dbt models are not an OS-generated model of `principal` (sorted).

    A run acts as its owner, so a model another person added downstream of the owner's landing table
    would run with the owner's rights. The allowed set is the OS-written owner map, the same set the
    schedules intersect their selection with."""
    return sorted({n for n in selected if owners.get(n) != principal})


def lane_check_for_run(checkout: str, tags: Mapping[str, object], selected: Iterable[str]) -> Optional[List[str]]:
    """`out_of_lane_models` for one run, against the owner map of the commit it pinned
    (`<checkout>/<domain>/<sha>`). None = cannot judge."""
    domain, sha, principal = (str(tags.get(k) or "") for k in ("os/domain", "os/commit", "os/principal"))
    if not (_DOMAIN_RE.match(domain) and ".." not in domain and _SHA_RE.match(sha) and _PRINCIPAL_RE.match(principal)):
        return None
    owners = read_generated_owners(os.path.join(checkout, domain, sha))
    return None if owners is None else out_of_lane_models(owners, selected, principal)


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


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


def recorded_hash(repo_dir: str, rel: str = DAGSTER_DEFINITIONS_PATH) -> Optional[str]:
    """The sha256 the OS recorded for a generated file in `os/generated.yml`, or None."""
    try:
        with open(os.path.join(repo_dir, GENERATED_PATH), encoding="utf-8") as fh:
            doc = _load_yaml(fh.read()) or {}
    except (OSError, ValueError):
        return None
    hashes = doc.get("sha256") if isinstance(doc, dict) else None
    value = hashes.get(rel) if isinstance(hashes, dict) else None
    return value if isinstance(value, str) and re.match(r"^[0-9a-f]{64}$", value) else None


def is_migrated(repo_dir: str) -> bool:
    """A v2 (design-12) repo carries the layout marker `os/layout.yml` (WP-55)."""
    return os.path.isfile(os.path.join(repo_dir, LAYOUT_MARKER))


def native_definitions(domain: str, repo_dir: str) -> Tuple[Optional[str], Optional[Skipped]]:
    """WP-49: the repo's own module when the repo is migrated AND the OS recorded its hash.

    Returns (path, None) for a module to import; (None, None) for the LEGACY path (no marker, no
    module or no record — the OS has not generated it for this repo yet); (None, Skipped) when a
    module is present but differs from the record (C5): it is refused, never imported, and the
    domain is NOT silently put on the legacy path either.
    """
    if not is_migrated(repo_dir):
        return None, None
    path = os.path.join(repo_dir, DAGSTER_DEFINITIONS_PATH)
    want = recorded_hash(repo_dir)
    if not os.path.isfile(path) or not want:
        return None, None
    got = sha256_file(path)
    if got != want:
        return None, Skipped(domain, f"{DAGSTER_DEFINITIONS_PATH} sha256 {got[:12]} differs from the OS-generated {want[:12]} — refusing to import it")
    return path, None


def load_project(domain: str, sha_dir: str, sha: str) -> Tuple[Optional[Project], Optional[Skipped]]:
    project_dir = dbt_dir(sha_dir)
    manifest = os.path.join(project_dir, "target", "manifest.json")
    if not os.path.isfile(manifest):
        return None, Skipped(domain, f"no target/manifest.json in {project_dir} (dbt parse did not run or failed)")
    definitions, refused = native_definitions(domain, sha_dir)
    if refused:
        return None, refused
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
            path=project_dir,
            sha=sha,
            manifest=manifest,
            schedules=schedules,
            schemas=schemas_from_manifest(manifest, domain),
            source_assets=source_assets,
            definitions=definitions,
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
    if os.path.isfile(os.path.join(dbt_dir(sha_dir), "target", "manifest.json")):
        return sha_dir, None
    os.makedirs(dom_dir, exist_ok=True)
    if not os.path.isdir(os.path.join(sha_dir, ".git")):
        tmp = sha_dir + ".tmp"
        run(["rm", "-rf", tmp], None)
        # The canonical name first (`domain-<domain>`), then the pre-layout alias `<domain>`.
        code, out = run(["git", "clone", "--quiet", "--no-checkout", f"{git_base}/{DOMAIN_REPO_PREFIX}{domain}.git", tmp], None)
        if code != 0:
            run(["rm", "-rf", tmp], None)
            code, out = run(["git", "clone", "--quiet", "--no-checkout", f"{git_base}/{domain}.git", tmp], None)
        if code != 0:
            return None, f"git clone {domain} failed: {out.strip()[:400]}"
        code, out = run(["git", "-C", tmp, "checkout", "--quiet", "--detach", sha], None)
        if code != 0:
            run(["rm", "-rf", tmp], None)
            return None, f"commit {sha} not in {domain}: {out.strip()[:400]}"
        for sub in BUILD_OUTPUT_DIRS:  # a checked-in target/ is never a parsed project
            shutil.rmtree(os.path.join(dbt_dir(tmp), sub), ignore_errors=True)
        os.replace(tmp, sha_dir)
    # `dbt parse` renders the repository's Jinja — it runs with an ALLOWLISTED environment
    # (`parse_env`), never this pod's, so no authored `{{ env_var(...) }}` can read a secret.
    code, out = dbt_parse(dbt_dir(sha_dir), run, env)
    if code != 0 or not os.path.isfile(os.path.join(dbt_dir(sha_dir), "target", "manifest.json")):
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


def run_tag_env(tags: Mapping[str, object]) -> Dict[str, str]:
    """The run worker's env, derived from the run's TAGS: the commits to check out (`os/pinned`)
    and, when the run has a principal, the identity dbt impersonates (`OS_PRINCIPAL`) and dlt's
    Trino destination user (dlt resolves `DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME` from the
    environment). A tag value is just a string; the run
    launcher lock-down allows no `dagster-k8s/config` tag at all. Invalid values are dropped."""
    env: Dict[str, str] = {}
    pinned = parse_pinned(str(tags.get("os/pinned") or ""))
    if pinned:
        env["OS_PINNED_COMMITS"] = ",".join(f"{d}={pinned[d]}" for d in sorted(pinned))
    principal = str(tags.get("os/principal") or "")
    if _PRINCIPAL_RE.match(principal):
        env["OS_PRINCIPAL"] = principal
        env["DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME"] = principal
    return env


def apply_run_tag_env(tags: Mapping[str, object], env) -> None:
    """Put `run_tag_env(tags)` into `env` (a mapping such as os.environ). The run's tags are the
    source: they replace a value the pod already holds."""
    env.update(run_tag_env(tags))


def _run_args_json(argv: Sequence[str]) -> Optional[str]:
    """The serialised `ExecuteRunArgs` / `ExecuteStepArgs` dagster passes to a run worker
    (`dagster api execute_run <json>`) or a step process (`dagster api execute_step <json>`)."""
    for i, a in enumerate(argv):
        if a in ("execute_run", "execute_step") and i + 1 < len(argv):
            return argv[i + 1]
    return None


def run_id_from_argv(argv: Sequence[str]) -> Optional[str]:
    """The run id in those arguments; None for any other process."""
    raw = _run_args_json(argv)
    if raw is None:
        return None
    try:
        body = json.loads(raw)
        # dagster's serdes keeps the legacy field name `pipeline_run_id` for the run id
        rid = body.get("run_id") or body.get("pipeline_run_id")
    except (ValueError, AttributeError):
        return None
    return str(rid) if rid else None


def apply_run_env_from_tags(argv: Optional[Sequence[str]] = None, env=None) -> bool:
    """A run worker (and its step processes) learns the run's pinned commit and principal from the
    run's TAGS: the launcher lock-down allows no per-run pod env (the lock-down allows no `dagster-k8s/config` tag). The run is read through the instance dagster itself hands the worker
    (`ExecuteRunArgs.instance_ref`, as `dagster api execute_run` does). Any other process (the code
    server, a sensor tick, `dagster dev`) has no such argument and keeps the env it was given:
    returns False. A failure to read the run is raised: a run worker without its pin loads no
    domain."""
    raw = _run_args_json(sys.argv if argv is None else argv)
    if raw is None:
        return False
    from dagster import DagsterInstance
    from dagster._serdes import deserialize_value

    args = deserialize_value(raw)
    ref = getattr(args, "instance_ref", None)
    with (DagsterInstance.from_ref(ref) if ref is not None else DagsterInstance.get()) as instance:
        run = instance.get_run_by_id(args.run_id)
        if run is None:
            raise RuntimeError(f"run {args.run_id} is not in the Dagster instance: cannot read its tags")
        tags = dict(run.tags)
    apply_run_tag_env(tags, os.environ if env is None else env)
    return True


def platform_run_tags(domain: str, sha: str, pinned: str, job_tags: Mapping[str, object]) -> Dict[str, str]:
    """Tags the platform adds to every SCHEDULED run of a repo's own definitions (WP-49).

    The principal is the one the repo's definitions name in the job's `os/principal` tag (the
    documented extension point, C2). A malformed principal is dropped, never passed on: it would
    become a Trino session user.
    """
    tags = base_tags(domain, sha, pinned)
    principal = str(job_tags.get("os/principal") or "")
    principal = principal if _PRINCIPAL_RE.match(principal) else ""
    if principal:
        tags["os/principal"] = principal
    return tags


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
        }
    )
    if s.run_grant:
        tags["os/run_grant"] = s.run_grant
    return tags


def maintenance_tags(domain: str, schema: str, principal: str, sha: str, pinned: str) -> Dict[str, str]:
    tags = base_tags(domain, sha, pinned)
    tags.update(
        {
            "os/principal": principal,
            "os/schema": schema,
            "os/action": "iceberg maintenance",
        }
    )
    return tags


def alert_job_name(domain: str, saved_query: str) -> str:
    """WP-50: the OS-launched job that evaluates one committed alert with MetricFlow."""
    return f"{sanitize(domain)}__alert_{sanitize(saved_query)}"


def alert_job_tags(domain: str, alert_id: str, sha: str, pinned: str) -> Dict[str, str]:
    """Like the `__all` job: no principal of its own — os-ui sets the owner's OS_PRINCIPAL per launch."""
    tags = base_tags(domain, sha, pinned)
    tags.update({"os/alert": alert_id, "os/action": "alert evaluation"})
    return tags


def all_job_tags(domain: str, sha: str, pinned: str) -> Dict[str, str]:
    """The OS-launched job carries no principal of its own: the OS sets OS_PRINCIPAL per launch."""
    tags = base_tags(domain, sha, pinned)
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


# -------------------------------------------------------------- run identity --
#
# WP-15 (design 01 R1–R3, 10 F3/F4). A run acts as its owner only after os-ui's
# `POST /api/runtime/run-grants/<id>/start` accepted it: os-ui verifies the caller's projected
# ServiceAccount token (TokenReview), reads the run back from Dagster by id, compares it with the
# grant, checks the owner still has access, activates the grant and waits until Trino's OPA holds
# the activation. Only then does dbt get the principal and the runner's Trino password.
#
# Identity mode is ON exactly when the chart mounted the runner's password file: without the
# password a run cannot authenticate as `svc-dagster-runner` at all, so there is nothing to switch
# off. With it, every run is checked — enforcement is not a run-config option.

_GRANT_ID_RE = re.compile(r"^rg_[a-z]+_[0-9a-f]{16,64}$")
PASSWORD_FILE = "/var/run/secrets/dagster-runner-trino/password"
RUN_TOKEN_FILE = "/var/run/secrets/os-ui/token"
DEFAULT_OS_UI_URL = "http://os-ui:3000"
START_TIMEOUT_SECONDS = 30.0


class UnauthorisedLaunch(Exception):
    """The run has no grant os-ui accepts: it must fail before any Trino query."""

    def __init__(self, reason: str):
        super().__init__(f"unauthorised launch: {reason}")


def _grant_id(v: object) -> str:
    s = str(v or "").strip()
    return s if _GRANT_ID_RE.match(s) else ""


def _env(env: Optional[Mapping[str, str]]) -> Mapping[str, str]:
    return os.environ if env is None else env


def run_identity_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    return os.path.isfile(_env(env).get("OS_TRINO_PASSWORD_FILE") or PASSWORD_FILE)


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def _post_grant(grant: str, action: str, run_id: str, token_file: str, env: Mapping[str, str]) -> Tuple[int, dict]:
    base = (env.get("OS_UI_URL") or DEFAULT_OS_UI_URL).rstrip("/")
    body = json.dumps({"run_id": run_id}).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/runtime/run-grants/{grant}/{action}",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {_read(token_file)}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=START_TIMEOUT_SECONDS) as res:  # noqa: S310 — cluster-internal URL
            return res.status, json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            return e.code, {}


def run_identity_env(run_id: str, tags: Mapping[str, str], env: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """The env dbt needs to act as the run's owner, after os-ui accepted the run grant.

    `{}` when identity mode is off (today's path). Raises `UnauthorisedLaunch` for a run without a
    grant, a refusal, an os-ui that cannot be reached, or an answer naming another principal than
    the run's tag. The principal is os-ui's answer (the grant row), never the tag alone.
    """
    e = _env(env)
    if not run_identity_enabled(e):
        return {}
    grant = _grant_id(tags.get("os/run_grant"))
    if not grant:
        raise UnauthorisedLaunch("the run carries no run grant (tag os/run_grant)")
    try:
        status, body = _post_grant(grant, "start", run_id, e.get("OS_RUN_TOKEN_FILE") or RUN_TOKEN_FILE, e)
    except Exception as ex:  # noqa: BLE001 — unreachable, timeout, no token: fail closed
        raise UnauthorisedLaunch(f"os-ui could not check the run grant ({type(ex).__name__}: {ex})") from None
    if status != 200:
        raise UnauthorisedLaunch(f"{body.get('error') or status}: {body.get('reason') or 'refused'}")
    principal = str(body.get("principal") or "")
    if not _PRINCIPAL_RE.match(principal) or principal != str(tags.get("os/principal") or ""):
        raise UnauthorisedLaunch("os-ui named another principal than the run")
    return {"OS_PRINCIPAL": principal, "DBT_ENV_SECRET_TRINO_PASSWORD": _read(e.get("OS_TRINO_PASSWORD_FILE") or PASSWORD_FILE)}


def _code_token_file(e: Mapping[str, str]) -> str:
    return e.get("OS_CODE_TOKEN_FILE") or RUN_TOKEN_FILE


def finish_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """The code server holds a projected token for os-ui (identity mode in the chart)."""
    return os.path.isfile(_code_token_file(_env(env)))


def finish_run_grant(run_id: str, tags: Mapping[str, str], env: Optional[Mapping[str, str]] = None) -> bool:
    """End a finished run's activation (the run-status sensor). False when there is nothing to end."""
    e = _env(env)
    grant = _grant_id(tags.get("os/run_grant"))
    if not grant:
        return False
    status, _ = _post_grant(grant, "finish", run_id, _code_token_file(e), e)
    return status == 200


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


#: The OS index snapshot repo-sync writes into the shared checkout (`repo-sync.sh index_domains`).
INDEX_FILE_MAX_AGE_SECONDS = 900


def read_index_file(path: str, max_age_seconds: int = INDEX_FILE_MAX_AGE_SECONDS) -> Optional[dict]:
    """repo-sync's snapshot of the OS index, or None when it is missing, unreadable or older than
    `max_age_seconds` — a stale snapshot is "unknown", never "everyone is active"."""
    if not path:
        return None
    try:
        if time.time() - os.path.getmtime(path) > max_age_seconds:
            return None
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("domains"), list) else None


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


# dbt 1.12 prefixes its log lines with the level ("[ERROR]: Encountered an error:"); 1.9 did not.
_LOG_NOISE = re.compile(r"keyring module not found|^\s*$|^(?:\[[A-Z]+\]:\s*)?Encountered an error:?\s*$", re.I)
_TS_PREFIX = re.compile(r"^\d\d:\d\d:\d\d\s+")


def parse_error_summary(output: str, limit: int = 400) -> str:
    """The ONE line repo-sync logs when `dbt parse` refuses a commit — the error kind and its message.

    Live incident 2026-11 (track H): the sidecar logged only "failed dbt parse — schedules keep
    running nothing", ~6,000 times, while the actual dbt error sat in `status.json` that nothing
    reads. dbt's message names files, models, columns and test names, never data values, so it is
    safe for the pod log. E.g. `Compilation Error: dbt found two data_tests with the name
    "not_null_gold_x_po_number" defined on column "po_number" in "models.gold_x".`
    """
    lines = [_TS_PREFIX.sub("", ln).strip() for ln in (output or "").splitlines()]
    lines = [ln for ln in lines if ln and not _LOG_NOISE.search(ln)]
    if not lines:
        return "no output from dbt parse"
    for i, ln in enumerate(lines):
        if re.search(r"error", ln, re.I):
            # dbt prints the error KIND on its own line ("Compilation Error") and the message next.
            msg = ln if len(ln.split()) > 3 or i + 1 >= len(lines) else f"{ln}: {lines[i + 1]}"
            return msg[:limit]
    return lines[-1][:limit]


def _main(argv: Sequence[str]) -> int:
    """`os_projects.py --parse <project-dir>` — `dbt parse` under the allowlisted environment.

    `repo-sync.sh` calls this instead of keeping its own `env -i` list, so the allowlist lives in
    exactly ONE place (review B2-review-H3).
    """
    if len(argv) == 3 and argv[1] == "--dbt-dir":
        sys.stdout.write(dbt_dir(argv[2]) + "\n")
        return 0
    if len(argv) == 3 and argv[1] == "--parse":
        timeout = float(os.environ.get("REPO_SYNC_PARSE_TIMEOUT") or 600)
        # `argv[2]` is the checked-out REPO; the project dir follows its layout.
        code, out = dbt_parse(dbt_dir(argv[2]), run=lambda cmd, cwd=None, env=None: _run(cmd, cwd, env, timeout=timeout))
        sys.stdout.write(out)
        if code == 0:
            return PARSE_OK
        return PARSE_REFUSED if is_dbt_refusal(code, out) else PARSE_TRANSIENT
    if len(argv) == 2 and argv[1] == "--error-summary":
        sys.stdout.write(parse_error_summary(sys.stdin.read()) + "\n")
        return 0
    if len(argv) == 2 and argv[1] == "--parse-env-names":
        sys.stdout.write("\n".join(sorted(parse_env({}))) + "\n")
        return 0
    sys.stderr.write("usage: os_projects.py --parse <repo-dir> | --dbt-dir <repo-dir> | --error-summary (stdin) | --parse-env-names\n")
    return 2


if __name__ == "__main__":  # pragma: no cover — exercised by repo-sync.sh
    raise SystemExit(_main(sys.argv))
