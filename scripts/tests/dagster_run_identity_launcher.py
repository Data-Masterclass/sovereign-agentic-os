# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Does the run pod get WP-15's identity? Judged by dagster-k8s's OWN `launch_run`.

Run INSIDE the Dagster image:

    python3 -I dagster_run_identity_launcher.py <stock.yaml> <lock.yaml> <lock+identity.yaml> <identity overlay.yaml> <lock-down overlay.yaml>

The first three are `helm template` renders: the default, with the launcher lock-down, and with the
lock-down then the run-identity overlay. The last two are the overlay files themselves.

  R1  the launcher with both overlays is still the lock-down's: same class, `{}` / `[]` allow-lists;
  R2  a normal OS launch builds a Job whose pod runs as ServiceAccount `dagster-run` with the token
      NOT automounted (the code location's own context cannot override it: it is not propagated);
  R3  the identity pieces are in the pod: projected os-ui token, the runner's password key, the CA,
      the four env entries; and EVERYTHING the lock-down's run pod has is still there (env names,
      volumes, mounts, the repo-sync sidecar) — Helm replaces lists, so a restated list that lost an
      entry would drop it silently;
  R4  no runtime bearer in the run container's env;
  R5  the code location propagates no container context in that render;
  T1  TWIN, the layout this replaces: the same identity settings under the stock launcher's
      `k8sRunLauncher.runK8sConfig`, with the code location propagating its context, give the run pod
      the code location's ServiceAccount with the token automounted — the failure the test must see.
"""
from __future__ import annotations

import copy
import json
import sys

import yaml

sys.path.insert(0, "/tmp/t")
import dagster_launcher_lockdown as base  # noqa: E402  (the lock-down harness: real launch_run, Recorder, render loaders)

failures = base.failures
check = base.check

RUN_SA = "dagster-run"
CODE_SA = "agentic-os-dagster-user-deployments-user-deployments"
NORMAL = {"os/principal": "alice", "os/pinned": "sales=" + "a" * 40, "os/domain": "sales", "os/run_grant": "g1"}


def pod_of(jobs):
    return jobs[0][1]["spec"]["template"]["spec"]


def main() -> int:
    stock, lock, both = (base.load(p) for p in sys.argv[1:4])
    identity = yaml.safe_load(open(sys.argv[4]))
    lockov = yaml.safe_load(open(sys.argv[5]))
    s_rl, l_rl, b_rl = base.run_launcher(stock), base.run_launcher(lock), base.run_launcher(both)

    print("R. lock-down + run identity")
    check("R1 same upstream class and the lock-down's own allow-lists, untouched",
          (b_rl["module"], b_rl["class"]) == ("dagster_k8s", "K8sRunLauncher")
          and all(b_rl["config"].get(k) == l_rl["config"].get(k)
                  for k in ("only_allow_user_defined_k8s_config_fields", "only_allow_user_defined_env_vars")), str(b_rl)[:300])
    jobs, err = base.launch(b_rl["config"], None, NORMAL)
    check("R2a a normal OS launch under both overlays builds a Job", err is None and len(jobs) == 1, str(err))
    if not jobs:
        return 1
    pod = pod_of(jobs)
    check(f"R2b the run pod runs as ServiceAccount {RUN_SA}", pod.get("serviceAccountName") == RUN_SA, str(pod.get("serviceAccountName")))
    check("R2c its token is NOT automounted", pod.get("automountServiceAccountToken") is False, str(pod.get("automountServiceAccountToken")))
    main_c = pod["containers"][0]
    vols = {v["name"]: v for v in pod.get("volumes", [])}
    check("R3a projected token for os-ui (audience os-ui)",
          vols.get("os-ui-token", {}).get("projected", {}).get("sources", [{}])[0].get("serviceAccountToken", {}).get("audience") == "os-ui", json.dumps(vols.get("os-ui-token"))[:200])
    check("R3b only the runner's password key is mounted",
          vols.get("dagster-runner-trino", {}).get("secret", {}).get("items") == [{"key": "svc-dagster-runner", "path": "password"}], json.dumps(vols.get("dagster-runner-trino"))[:200])
    check("R3c the chart CA is mounted", "trino-ca" in vols)
    env = {e["name"]: e for e in main_c.get("env", [])}
    check("R3d the identity env reaches the run container",
          all(n in env for n in ("TRINO_TLS_PORT", "TRINO_RUNNER_USER", "TRINO_CA_FILE", "OS_UI_URL")), str(sorted(env)))
    # everything the lock-down's own run pod carries survives the identity overlay
    lrk = lockov["dagster"]["runLauncher"]["config"]["customRunLauncher"]["config"]["run_k8s_config"]
    missing_env = [e["name"] for e in lrk["container_config"]["env"] if e["name"] not in env]
    check("R3e every lock-down env entry is still in the run container", not missing_env, str(missing_env))
    missing_vol = [v["name"] for v in lrk["pod_spec_config"]["volumes"] if v["name"] not in vols]
    check("R3f every lock-down volume is still in the run pod", not missing_vol, str(missing_vol))
    mounts = {m["name"] for m in main_c.get("volumeMounts", [])}
    missing_m = [m["name"] for m in lrk["container_config"]["volume_mounts"] if m["name"] not in mounts]
    check("R3g every lock-down volume mount is still on the run container", not missing_m, str(missing_m))
    side = {c["name"] for c in pod["containers"][1:]}
    check("R3h the repo-sync sidecar is still in the run pod", {c["name"] for c in lrk["pod_spec_config"]["containers"]} <= side, str(side))
    check("R4 no AGENT_RUNTIME_TOKEN in the run container env", "AGENT_RUNTIME_TOKEN" not in env, str(sorted(env)))
    ctx, _ = base.code_location_context(next(v for k, v in both.items() if k[0] == "Deployment" and k[2] == base.CODE_LOCATION))
    check("R5 the code location propagates no container context", ctx is None, json.dumps(ctx)[:200])
    check("R5b the identity overlay sets only the run pod's container and pod spec",
          set(identity["dagster"]["runLauncher"]["config"]["customRunLauncher"]["config"]["run_k8s_config"]) == {"container_config", "pod_spec_config"})

    print("T. the twin: the layout this replaces")
    # Old layout: stock launcher, the identity settings under k8sRunLauncher.runK8sConfig, the code
    # location propagating its container context (read from the stock render).
    s_ctx, _ = base.code_location_context(next(v for k, v in stock.items() if k[0] == "Deployment" and k[2] == base.CODE_LOCATION))
    new_rk = identity["dagster"]["runLauncher"]["config"]["customRunLauncher"]["config"]["run_k8s_config"]
    cfg = copy.deepcopy(s_rl["config"])
    rk = cfg.setdefault("run_k8s_config", {})
    rk.setdefault("container_config", {}).setdefault("env", []).extend(
        e for e in new_rk["container_config"]["env"] if e["name"] in ("TRINO_TLS_PORT", "TRINO_RUNNER_USER", "TRINO_CA_FILE", "OS_UI_URL"))
    rk.setdefault("pod_spec_config", {})["service_account_name"] = RUN_SA
    rk["pod_spec_config"]["automount_service_account_token"] = False
    tj, terr = base.launch(cfg, s_ctx, {"os/principal": "alice", "os/pinned": NORMAL["os/pinned"]})
    check("T1a the old layout launches", terr is None and len(tj) == 1, str(terr))
    if tj:
        tp = pod_of(tj)
        check("T1b ... and its run pod gets the CODE LOCATION's ServiceAccount, not dagster-run",
              tp.get("serviceAccountName") == CODE_SA, str(tp.get("serviceAccountName")))
        check("T1c ... with the token automounted", tp.get("automountServiceAccountToken") is True, str(tp.get("automountServiceAccountToken")))
    print(f"\ndagster-run-identity launcher: {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
