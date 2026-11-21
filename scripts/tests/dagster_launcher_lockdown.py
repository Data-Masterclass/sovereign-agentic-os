# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Parity of the Dagster run-launcher lock-down overlay, judged by dagster-k8s's OWN code.

Run INSIDE the Dagster image (it imports the dagster_k8s the image ships):

    python3 -I dagster_launcher_lockdown.py <stock render.yaml> <lock-down render.yaml>

<stock> is `helm template agentic-os charts/sovereign-agentic-os -n agentic-os`, <lock-down> the same
with `-f values.dagster-launcher-lockdown.yaml`. Exit 0 only when ALL of these hold:

  A. render parity: the two renders differ in nothing but the instance ConfigMap's `run_launcher`,
     the code location's DAGSTER_CLI_API_GRPC_CONTAINER_CONTEXT env (the lock-down turns
     `includeConfigInLaunchedRuns` off) and the pods' checksum annotations;
  B. config parity: the lock-down launcher is dagster_k8s.K8sRunLauncher with EVERY stock config key
     at its stock value, plus the two documented `only_allow_*` keys at exactly the allowed values,
     plus a `run_k8s_config` that equals — after dagster-k8s's own normalisation
     (K8sContainerContext.create_from_config) — what the code location used to propagate;
  C. launch parity: dagster-k8s's real K8sRunLauncher.launch_run (only the Kubernetes API call is
     captured) builds the SAME Job for a normal OS launch under both configs;
  D. lock-down: the same real launch_run refuses a tag that sets an image, a volume, a service
     account or a command ("violated the allowed list"), creates no Job, and drops a tag env var
     that is not on the list — while the STOCK launcher accepts those tags (the twin: proves the
     checks see a real difference, not a test that always passes).
"""
from __future__ import annotations

import copy
import json
import os
import sys
import shutil

import yaml

sys.path.insert(0, "/opt/dagster/app")  # the image's own os_projects (the tag the OS sends)

import kubernetes  # noqa: E402
from dagster import DagsterInstance  # noqa: E402
from dagster._core.code_pointer import FileCodePointer  # noqa: E402
from dagster._core.launcher import LaunchRunContext  # noqa: E402
from dagster._core.origin import JobPythonOrigin, RepositoryPythonOrigin  # noqa: E402
from dagster._core.storage.dagster_run import DagsterRun  # noqa: E402
from dagster_k8s import K8sRunLauncher  # noqa: E402
from dagster_k8s.container_context import K8sContainerContext  # noqa: E402
from dagster_k8s.job import UserDefinedDagsterK8sConfig  # noqa: E402

import os_projects  # noqa: E402

INSTANCE_CM = "agentic-os-dagster-instance"
CODE_LOCATION = "agentic-os-dagster-user-deployments-sovereign"
CONTEXT_ENV = "DAGSTER_CLI_API_GRPC_CONTAINER_CONTEXT"
DAGSTER_PODS = {CODE_LOCATION, "agentic-os-dagster-webserver", "agentic-os-dagster-daemon"}

# The contract: what a run tag may still set. `container_config.env` + `.resources`, and env names
# exactly those the OS itself puts in `dagster-k8s/config` (os_projects.run_pod_env, launch.ts).
ALLOWED_FIELDS = {"container_config": {"env": True, "resources": True}}
ALLOWED_ENV = sorted(["OS_PINNED_COMMITS", "OS_PRINCIPAL", "DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME"])

failures: list[str] = []


def ok(name: str) -> None:
    print(f"  ok   {name}")


def bad(name: str, detail: str = "") -> None:
    failures.append(name)
    print(f"  FAIL {name}\n     {detail[:1500]}")


def check(name: str, cond: bool, detail: str = "") -> None:
    ok(name) if cond else bad(name, detail)


def load(path: str) -> dict:
    out = {}
    for d in yaml.safe_load_all(open(path)):
        if d:
            out[(d.get("kind"), d["metadata"].get("namespace"), d["metadata"]["name"])] = d
    return out


def strip_checksums(d: dict) -> dict:
    d = copy.deepcopy(d)
    ann = d.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations") or {}
    for k in [k for k in ann if k.startswith("checksum/")]:
        del ann[k]
    return d


def code_location_context(dep: dict) -> tuple[dict | None, dict]:
    """(the container context the code location propagates, the Deployment without that env).

    `--fixed-server-id` is the subchart's hash of the deployment's values, like the checksum
    annotations: it changes with any value, so it is compared as present, not by value."""
    dep = copy.deepcopy(dep)
    main = dep["spec"]["template"]["spec"]["containers"][0]
    args = main.get("args", [])
    if "--fixed-server-id" in args:
        args[args.index("--fixed-server-id") + 1] = "<hash>"
    ctx = None
    kept = []
    for e in main.get("env", []):
        if e["name"] == CONTEXT_ENV:
            ctx = json.loads(e["value"])
        else:
            kept.append(e)
    main["env"] = kept
    return ctx, dep


def run_launcher(docs: dict) -> dict:
    return yaml.safe_load(docs[("ConfigMap", None, INSTANCE_CM)]["data"]["dagster.yaml"])["run_launcher"]


# ── A. render parity ────────────────────────────────────────────────────────────────────────────
def render_parity(stock: dict, lock: dict):
    check("A1 same set of rendered objects", set(stock) == set(lock),
          f"only stock: {sorted(set(stock) - set(lock))} only lock-down: {sorted(set(lock) - set(stock))}")
    stock_ctx = lock_ctx = None
    for key in sorted(set(stock) & set(lock), key=str):
        s, l = stock[key], lock[key]
        kind, _, name = key
        if kind == "ConfigMap" and name == INSTANCE_CM:
            sy = yaml.safe_load(s["data"]["dagster.yaml"])
            ly = yaml.safe_load(l["data"]["dagster.yaml"])
            sy.pop("run_launcher"), ly.pop("run_launcher")
            check("A2 dagster.yaml differs only in run_launcher", sy == ly)
            s, l = {**s, "data": {}}, {**l, "data": {}}
        if kind == "Secret":  # chart-generated random values differ per render; keys must not
            s, l = ({**x, "data": sorted(x.get("data") or {}), "stringData": sorted(x.get("stringData") or {})}
                    for x in (s, l))
        if kind == "Deployment" and name in DAGSTER_PODS:
            s, l = strip_checksums(s), strip_checksums(l)
        if kind == "Deployment" and name == CODE_LOCATION:
            stock_ctx, s = code_location_context(s)
            lock_ctx, l = code_location_context(l)
            check("A3 stock code location propagates its container context", stock_ctx is not None)
            check("A4 lock-down code location propagates NO container context (includeConfigInLaunchedRuns off)",
                  lock_ctx is None, json.dumps(lock_ctx)[:300])
        if s != l:
            bad(f"A5 {kind}/{name} is identical in both renders",
                json.dumps(diff(s, l), default=str)[:1500])
    if not [f for f in failures if f.startswith("A5")]:
        ok("A5 every other rendered object is identical")
    return stock_ctx


def diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        out = {}
        for k in set(a) | set(b):
            if a.get(k) != b.get(k):
                out.update(diff(a.get(k), b.get(k), f"{path}.{k}"))
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = {}
        for i, (x, y) in enumerate(zip(a, b)):
            if x != y:
                out.update(diff(x, y, f"{path}[{i}]"))
        return out
    if isinstance(a, str) and isinstance(b, str) and len(a) > 200:  # show where long strings part
        i = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        return {path: [a[max(0, i - 80):i + 120], b[max(0, i - 80):i + 120]]}
    return {path: [a, b]}


# ── B. config parity ────────────────────────────────────────────────────────────────────────────
def config_parity(stock_rl: dict, lock_rl: dict, stock_ctx: dict):
    check("B1 stock is dagster_k8s.K8sRunLauncher",
          (stock_rl["module"], stock_rl["class"]) == ("dagster_k8s", "K8sRunLauncher"), str(stock_rl)[:200])
    check("B2 lock-down is the SAME upstream class, dagster_k8s.K8sRunLauncher (CustomRunLauncher)",
          (lock_rl["module"], lock_rl["class"]) == ("dagster_k8s", "K8sRunLauncher"), str(lock_rl)[:200])
    s, l = stock_rl["config"], lock_rl["config"]
    extra = set(l) - set(s) - {"only_allow_user_defined_k8s_config_fields", "only_allow_user_defined_env_vars"}
    check("B3 lock-down adds no config key but the two only_allow_* keys", not extra, str(sorted(extra)))
    for k in sorted(set(s) - {"run_k8s_config"}):
        check(f"B4 stock key {k} kept at its stock value", l.get(k) == s[k], f"stock {s[k]!r} lock-down {l.get(k)!r}")
    check("B5 only_allow_user_defined_k8s_config_fields is exactly container_config.{env,resources}",
          l.get("only_allow_user_defined_k8s_config_fields") == ALLOWED_FIELDS,
          str(l.get("only_allow_user_defined_k8s_config_fields")))
    check("B6 only_allow_user_defined_env_vars is exactly the OS's run-pod env names",
          sorted(l.get("only_allow_user_defined_env_vars") or []) == ALLOWED_ENV,
          str(l.get("only_allow_user_defined_env_vars")))
    pod_env = sorted(os_projects.run_pod_env("p", "d=0" * 1))
    check("B7 the allowed env names are exactly what os_projects.run_pod_env puts in the tag",
          pod_env == ALLOWED_ENV, str(pod_env))
    srk, lrk = dict(s.get("run_k8s_config") or {}), dict(l.get("run_k8s_config") or {})
    check("B8 run pod metadata (labels) kept at its stock value",
          lrk.pop("pod_template_spec_metadata", None) == srk.pop("pod_template_spec_metadata", None))
    check("B9 stock run_k8s_config has nothing else", not srk, str(srk))
    # What the code location used to propagate, normalised by dagster-k8s itself, vs the operator copy.
    propagated = K8sContainerContext.create_from_config(stock_ctx)
    moved = K8sContainerContext(run_k8s_config=UserDefinedDagsterK8sConfig.from_dict(lrk))
    p, m = propagated.run_k8s_config.to_dict(), moved.run_k8s_config.to_dict()
    check("B10 the operator run_k8s_config equals what the code location propagated (upstream-normalised)",
          p == m, json.dumps(diff(p, m), default=str))
    check("B11 the code location's namespace is the launcher's job_namespace",
          propagated.namespace == l.get("job_namespace"), f"{propagated.namespace} vs {l.get('job_namespace')}")


# ── C/D. the real launch_run ────────────────────────────────────────────────────────────────────
class Recorder:
    """Stands in for the Kubernetes API ONLY: captures the Job dagster-k8s would create."""

    def __init__(self):
        self.jobs = []

    def create_namespaced_job_with_retries(self, body, namespace):
        self.jobs.append((namespace, kubernetes.client.ApiClient().sanitize_for_serialization(body)))


KUBECONFIG = """apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:1"}}]
users: [{name: u, user: {token: x}}]
contexts: [{name: c, context: {cluster: c, user: u}}]
current-context: c
"""


def launcher_from(cfg: dict, home: str) -> K8sRunLauncher:
    cfg = dict(cfg)
    # In-cluster config cannot load outside a pod; a throwaway kubeconfig to a closed port instead.
    # The client is replaced by the Recorder below, so nothing is ever sent.
    kc = os.path.join(home, "kubeconfig")
    open(kc, "w").write(KUBECONFIG)
    cfg.update(load_incluster_config=False, kubeconfig_file=kc)
    # Through dagster's own config schema, as the instance does.
    from dagster._config import process_config
    res = process_config(K8sRunLauncher.config_type(), cfg)
    if not res.success:
        raise SystemExit(f"run_launcher config is invalid for dagster-k8s: {res.errors}")
    launcher = K8sRunLauncher.from_config_value(None, res.value)
    launcher._api_client = Recorder()  # noqa: SLF001
    return launcher


def launch(cfg: dict, container_context: dict | None, tags: dict) -> tuple[list, str | None]:
    """The real launch_run of one run; returns (jobs created, refusal message or None)."""
    # One fixed DAGSTER_HOME path for every launch: the Job's args carry the instance ref.
    home = "/tmp/wp15lock-home"
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    if True:
        instance = DagsterInstance.local_temp(home)
        launcher = launcher_from(cfg, home)
        launcher.register_instance(instance)
        origin = JobPythonOrigin(
            job_name="j",
            repository_origin=RepositoryPythonOrigin(
                executable_path="/usr/local/bin/python",
                code_pointer=FileCodePointer("/opt/dagster/app/repo.py", "defs"),
                container_image="ghcr.io/data-masterclass/sovereign-os/dagster@sha256:" + "0" * 64,
                container_context=container_context,
            ),
        )
        run = instance.add_run(DagsterRun(job_name="j", run_id="0" * 8 + "-0000-0000-0000-" + "0" * 12,
                                          tags=tags, job_code_origin=origin))
        try:
            launcher.launch_run(LaunchRunContext(dagster_run=run, workspace=None))
            err = None
        except Exception as e:  # the launcher's refusal is an Exception with upstream's text
            err = str(e)
        jobs = json.loads(json.dumps(launcher._api_client.jobs).replace(home, "<home>"))  # noqa: SLF001
        return [origin_context_out(j) for j in jobs], err


def origin_context_out(job):
    """The run worker's args carry the serialised run origin, and with it the code location's
    container context (stock) or none (lock-down: includeConfigInLaunchedRuns off). That one field
    is the intended difference; it is lifted out to `origin_container_context` and checked alone."""
    c = job[1]["spec"]["template"]["spec"]["containers"][0]
    for i, a in enumerate(c.get("args") or []):
        if a.startswith('{"__class__": "ExecuteRunArgs"'):
            a = json.loads(a)
            # serdes stores JobPythonOrigin under its legacy field name
            ro = (a.get("job_origin") or a["pipeline_origin"])["repository_origin"]
            job[1]["origin_container_context"] = ro.get("container_context")
            ro["container_context"] = None
            c["args"][i] = json.dumps(a, sort_keys=True)
    return job


def env_names(job) -> list[str]:
    return [e["name"] for e in job[1]["spec"]["template"]["spec"]["containers"][0].get("env", [])]


def k8s_tag(cfg: dict) -> dict:
    return {"dagster-k8s/config": json.dumps(cfg)}


FORBIDDEN = {
    "container_config.image": {"container_config": {"image": "busybox:1.36"}},
    "container_config.command": {"container_config": {"command": ["/bin/sh", "-c", "true"]}},
    "pod_spec_config.volumes": {"pod_spec_config": {"volumes": [{"name": "h", "host_path": {"path": "/"}}]}},
    "pod_spec_config.service_account_name": {"pod_spec_config": {"service_account_name": "default"}},
}


def launch_checks(stock_cfg: dict, lock_cfg: dict, stock_ctx: dict):
    normal = {"dagster-k8s/config": os_projects.k8s_env_tag(os_projects.run_pod_env("alice", "sales=" + "a" * 40))}
    sj, serr = launch(stock_cfg, stock_ctx, normal)
    lj, lerr = launch(lock_cfg, None, normal)
    check("C1 stock launches a normal OS run", serr is None and len(sj) == 1, str(serr))
    check("C2 lock-down launches a normal OS run", lerr is None and len(lj) == 1, str(lerr))
    if sj and lj:
        check("C3a the stock run origin carries the code location's container context",
              sj[0][1].pop("origin_container_context", None) is not None)
        check("C3b the lock-down run origin carries none", lj[0][1].pop("origin_container_context", 0) is None)
        check("C3 the run Job is IDENTICAL under both launchers (namespace + full spec)", sj == lj,
              json.dumps(diff(sj[0][1], lj[0][1]), default=str))
        names = env_names(lj[0])
        check("C4 the run pod carries the tag env and the operator env",
              {"OS_PINNED_COMMITS", "OS_PRINCIPAL", "TRINO_HOST", "AGENT_RUNTIME_TOKEN"} <= set(names), str(names))

    for field, cfg in FORBIDDEN.items():
        jobs, err = launch(lock_cfg, None, k8s_tag(cfg))
        check(f"D1 lock-down refuses a tag that sets {field}",
              err is not None and "violated the allowed list" in err and field in err and not jobs,
              f"err={err!r} jobs={len(jobs)}")
        sjobs, serr = launch(stock_cfg, stock_ctx, k8s_tag(cfg))
        check(f"D1-twin the STOCK launcher creates a Job for the same {field} tag",
              serr is None and len(sjobs) == 1, f"err={serr!r}")
    allc = {"container_config": {**FORBIDDEN["container_config.image"]["container_config"],
                                 **FORBIDDEN["container_config.command"]["container_config"]},
            "pod_spec_config": {**FORBIDDEN["pod_spec_config.volumes"]["pod_spec_config"],
                                **FORBIDDEN["pod_spec_config.service_account_name"]["pod_spec_config"]}}
    sjobs, _ = launch(stock_cfg, stock_ctx, k8s_tag(allc))
    if sjobs:
        spec = sjobs[0][1]["spec"]["template"]["spec"]
        check("D1-twin the stock Job really carries the tag's image, command, hostPath and service account",
              spec["containers"][0]["image"] == "busybox:1.36"
              and spec["containers"][0].get("command") == ["/bin/sh", "-c", "true"]
              and any(v.get("hostPath") == {"path": "/"} for v in spec.get("volumes", []))
              and spec.get("serviceAccountName") == "default", json.dumps(spec)[:600])

    extra = {"container_config": {"env": [{"name": "OS_PRINCIPAL", "value": "alice"},
                                          {"name": "PYTHONPATH", "value": "/tmp/not-allowed"}]}}
    jobs, err = launch(lock_cfg, None, k8s_tag(extra))
    check("D2 lock-down drops a tag env var that is not on the list (PYTHONPATH) and keeps an allowed one",
          err is None and jobs and "PYTHONPATH" not in env_names(jobs[0]) and "OS_PRINCIPAL" in env_names(jobs[0]),
          f"err={err!r} env={env_names(jobs[0]) if jobs else None}")
    sjobs, serr = launch(stock_cfg, stock_ctx, k8s_tag(extra))
    check("D2-twin the STOCK launcher passes PYTHONPATH into the run pod",
          serr is None and sjobs and "PYTHONPATH" in env_names(sjobs[0]), f"err={serr!r}")
    res = {"container_config": {"resources": {"limits": {"memory": "2Gi"}}}}
    jobs, err = launch(lock_cfg, None, k8s_tag(res))
    check("D3 lock-down still accepts container_config.resources from a tag",
          err is None and jobs and jobs[0][1]["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["memory"] == "2Gi",
          f"err={err!r}")


def main() -> int:
    stock, lock = load(sys.argv[1]), load(sys.argv[2])
    print("A. render parity")
    stock_ctx = render_parity(stock, lock)
    stock_rl, lock_rl = run_launcher(stock), run_launcher(lock)
    if stock_ctx is None:
        bad("stock code location context", "not found; nothing to compare")
        return 1
    print("B. config parity")
    config_parity(stock_rl, lock_rl, stock_ctx)
    print("C/D. dagster-k8s launch_run (real; only the Kubernetes API call is captured)")
    launch_checks(stock_rl["config"], lock_rl["config"], stock_ctx)
    print(f"\ndagster-launcher-lockdown parity: {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
