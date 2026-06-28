#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""
Sovereign Agentic OS — Admin Console.

A single-pane dashboard over the whole stack: live status per component, on/off
toggling (scale 0<->1 via the k8s API), addresses + logins + how-to-use, and the
per-component docs (which also feed the future help agent). Stdlib only; talks to
the in-cluster k8s API with the pod's ServiceAccount.
"""
import json
import os
import ssl
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

NS = os.environ.get("NAMESPACE", "agentic-os")
PORT = int(os.environ.get("PORT", "8080"))
DOCS_DIR = os.environ.get("DOCS_DIR", "/docs")
K8S = "https://kubernetes.default.svc"
SA = "/var/run/secrets/kubernetes.io/serviceaccount"

# --- component registry (single source of truth) ---------------------------
# kind: deploy | sts | cluster | job ; toggle: can scale 0<->1 from the UI
REG = [
  # Infrastructure / data tier
  dict(id="minio", name="MinIO (object storage)", layer="Infrastructure", kind="deploy", workload="minio",
       svc="minio", port=9001, ui=True, login="agentic-os-local / agentic-os-local-secret", toggle=True,
       summary="S3 object storage for the Iceberg lakehouse + Langfuse blobs."),
  dict(id="postgres", name="PostgreSQL (CloudNativePG)", layer="Infrastructure", kind="cluster", workload="pg",
       svc="pg-rw", port=5432, ui=False, login="per-database role (see doc)", toggle=False,
       summary="Operator-managed Postgres backing Langfuse, LiteLLM, Dagster, the warehouse, Polaris, Superset."),
  dict(id="valkey", name="Valkey (cache)", layer="Infrastructure", kind="deploy", workload="valkey",
       svc="valkey", port=6379, ui=False, login="password: valkey-local-dev", toggle=True,
       summary="Redis-protocol queue/cache for Langfuse (BSD-3, not Redis)."),
  dict(id="clickhouse", name="ClickHouse (analytics)", layer="Infrastructure", kind="deploy", workload="clickhouse",
       svc="clickhouse", port=8123, ui=False, login="langfuse / clickhouse-local-dev", toggle=True,
       summary="Langfuse v3 analytics backend."),
  # Layer 1 — agent core
  dict(id="langfuse", name="Langfuse (observability)", layer="Layer 1 — Agent core", kind="deploy",
       workload="agentic-os-langfuse-web", svc="agentic-os-langfuse-web", port=3000, ui=True,
       login="admin@datamasterclass.com / langfuse-local-dev-admin", toggle=True,
       summary="Traces every agent action; the default Administrator console."),
  dict(id="litellm", name="LiteLLM (model + MCP gateway)", layer="Layer 1 — Agent core", kind="deploy",
       workload="agentic-os-litellm", svc="agentic-os-litellm", port=4000, ui=True, url_path="/ui",
       login="admin / litellm-admin-local-dev  (master key sk-litellm-local-dev-master)", toggle=True,
       summary="One governed endpoint for models + MCP tools; per-key cost caps."),
  dict(id="mock-model", name="Mock model (local LLM)", layer="Layer 1 — Agent core", kind="deploy",
       workload="mock-model", svc="mock-model", port=8080, ui=False, login="none", toggle=True,
       summary="Tiny offline OpenAI-compatible stub LiteLLM routes to (sovereign demo)."),
  dict(id="opensearch", name="OpenSearch (retrieval)", layer="Layer 1 — Agent core", kind="sts",
       workload="opensearch-master", svc="opensearch", port=9200, ui=False, login="none (security disabled locally)",
       toggle=True, summary="Vector + lexical retrieval backbone for RAG."),
  dict(id="sample-agent", name="Sample RAG agent", layer="Layer 1 — Agent core", kind="deploy",
       workload="sample-agent", svc="sample-agent", port=8000, ui=False, login="none",
       toggle=True, summary="LangGraph agent: retrieve (OpenSearch) -> generate (LiteLLM) -> trace."),
  dict(id="poet-agent", name="Poet agent", layer="Layer 1 — Agent core", kind="deploy",
       workload="poet-agent", svc="poet-agent", port=8000, ui=False, login="none",
       toggle=True, summary="Second LangGraph agent: writes a poem file each run."),
  # Layer 2 — context
  dict(id="opa", name="OPA (policy)", layer="Layer 2 — Context", kind="deploy", workload="opa",
       svc="opa", port=8181, ui=False, login="none", toggle=True,
       summary="Default-deny tool authorization at the MCP/tool boundary."),
  dict(id="haystack", name="Haystack (RAG pipeline)", layer="Layer 2 — Context", kind="deploy",
       workload="haystack", svc="haystack", port=8000, ui=False, login="none", toggle=True,
       summary="RAG retrieval pipeline over OpenSearch, embedding via LiteLLM."),
  dict(id="dagster", name="Dagster (orchestrator)", layer="Layer 2 — Context", kind="deploy",
       workload="agentic-os-dagster-webserver", svc="agentic-os-dagster-webserver", port=80, ui=True,
       login="none", toggle=True, summary="Orchestrates dbt + ingestion + metadata crawls."),
  dict(id="dbt", name="dbt (transforms)", layer="Layer 2 — Context", kind="job", workload="",
       svc="", port=0, ui=False, login="n/a (runs as a Job / Dagster asset)", toggle=False,
       summary="Builds the analytics warehouse (seed -> staging -> mart)."),
  dict(id="cube", name="Cube (metrics)", layer="Layer 2 — Context", kind="deploy", workload="cube",
       svc="cube", port=4000, ui=True, login="none (dev playground)", toggle=True,
       summary="Semantic/metrics layer over the dbt warehouse."),
  dict(id="docling", name="Docling (doc parsing)", layer="Layer 2 — Context", kind="deploy", workload="docling",
       svc="docling", port=5001, ui=False, login="none", toggle=True,
       summary="Parses uploaded documents into markdown for the knowledge index. (Off by default locally.)"),
  dict(id="openmetadata", name="OpenMetadata (catalog)", layer="Layer 2 — Context", kind="deploy",
       workload="openmetadata", svc="openmetadata", port=8585, ui=True,
       login="admin@open-metadata.org / admin", toggle=True,
       summary="Catalog + lineage. (Off by default locally for RAM.)"),
  dict(id="opensearch-dashboards", name="OpenSearch Dashboards", layer="Layer 2 — Context", kind="deploy",
       workload="opensearch-dashboards", svc="opensearch-dashboards", port=5601, ui=True, login="none",
       toggle=True, summary="Search/visualization UI over OpenSearch. (Off by default locally.)"),
  # Layer 3 — self-service
  dict(id="polaris", name="Polaris (Iceberg catalog)", layer="Layer 3 — Self-service", kind="deploy",
       workload="polaris", svc="polaris", port=8182, ui=False,
       login="OAuth2 root / polaris-local-dev-secret", toggle=True,
       summary="Iceberg REST catalog for the lakehouse."),
  dict(id="query-tool", name="DuckDB query tool (MCP)", layer="Layer 3 — Self-service", kind="deploy",
       workload="query-tool", svc="query-tool", port=8000, ui=False,
       login="via LiteLLM MCP (sk-litellm-local-dev-master)", toggle=True,
       summary="Default query engine: DuckDB over Iceberg; an MCP tool in LiteLLM."),
  dict(id="superset", name="Superset (dashboards/BI)", layer="Layer 3 — Self-service", kind="deploy",
       workload="agentic-os-superset", svc="agentic-os-superset", port=8088, ui=True,
       login="admin / superset-admin-local-dev", toggle=True,
       summary="Dashboards on the dbt warehouse / Cube."),
  dict(id="forgejo", name="Forgejo (git)", layer="Layer 3 — Self-service", kind="deploy", workload="forgejo",
       svc="forgejo-http", port=3000, ui=True, login="gitea_admin / forgejo-admin-local-dev", toggle=True,
       summary="Self-hosted git for the Software golden path."),
  dict(id="argocd", name="Argo CD (GitOps)", layer="Layer 3 — Self-service", kind="deploy",
       workload="argocd-server", svc="argocd-server", port=80, ui=True,
       login="admin / (kubectl get secret argocd-initial-admin-secret)", toggle=False,
       summary="Deploys apps from Forgejo repos into per-domain namespaces."),
  dict(id="ci-runner", name="CI runner (Forgejo Actions)", layer="Layer 3 — Self-service", kind="deploy",
       workload="ci-runner", svc="", port=0, ui=False, login="none (registered to Forgejo)", toggle=True,
       summary="Executes CI workflows on push (act_runner + DinD); completes push -> CI -> deploy."),
  # Security baseline
  dict(id="egress-proxy", name="Egress proxy", layer="Security baseline", kind="deploy", workload="egress-proxy",
       svc="egress-proxy", port=3128, ui=False, login="none", toggle=True,
       summary="The single outbound chokepoint (allowlist forward proxy)."),
  dict(id="web-fetch", name="Governed web_fetch tool", layer="Security baseline", kind="deploy",
       workload="web-fetch", svc="web-fetch", port=8000, ui=False, login="none (OPA-gated)", toggle=True,
       summary="The only sanctioned path to the web: OPA-authorized, proxied, sanitized."),
  # Layer 4 — Science / ML (opt-in; off by default — heavy)
  dict(id="mlflow", name="MLflow (experiments/registry)", layer="Layer 4 — Science", kind="deploy",
       workload="mlflow", svc="mlflow", port=5000, ui=True, login="none (in-cluster)", toggle=True,
       summary="ML experiment tracking + model registry; artifacts in object storage."),
  dict(id="jupyterhub", name="JupyterHub (notebooks)", layer="Layer 4 — Science", kind="deploy",
       workload="hub", svc="proxy-public", port=80, ui=True, login="any user / jupyter-local-dev",
       toggle=True, summary="Multi-user notebooks (Zero-to-JupyterHub). Off by default (heavy)."),
  dict(id="featureform", name="Featureform (feature store)", layer="Layer 4 — Science", kind="deploy",
       workload="featureform", svc="featureform", port=7878, ui=False, login="none", toggle=True,
       summary="Feature store (MPL-2.0, optional); online store = Valkey. Off by default."),
  dict(id="ml-agent", name="ML agent (LangGraph)", layer="Layer 4 — Science", kind="deploy",
       workload="ml-agent", svc="ml-agent", port=8000, ui=False, login="none", toggle=True,
       summary="Plans features->train->deploy via LiteLLM; lists the model registry. Off by default."),
  # Platform / front door
  dict(id="os-ui", name="OS UI (front door)", layer="Platform", kind="deploy", workload="os-ui",
       svc="os-ui", port=3000, ui=True, login="none (open locally)", toggle=True,
       summary="The Next.js front door: Home / Agents / Structured Data / Monitoring / Dashboards."),
  dict(id="admin-console", name="Admin Console (this app)", layer="Platform", kind="deploy",
       workload="admin-console", svc="admin-console", port=8080, ui=True, login="none (open locally)",
       toggle=False, summary="This dashboard: stack status, on/off, addresses, logins + docs."),
]
BY_ID = {c["id"]: c for c in REG}

# --- k8s API helpers -------------------------------------------------------
def _ctx():
    return ssl.create_default_context(cafile=f"{SA}/ca.crt")

def _token():
    with open(f"{SA}/token") as f:
        return f.read().strip()

def k8s(method, path, body=None):
    url = K8S + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {_token()}"}
    if method == "PATCH":
        headers["Content-Type"] = "application/merge-patch+json"
    elif body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=_ctx(), timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}

def _workload_path(c, scale=False):
    kind = {"deploy": "deployments", "sts": "statefulsets"}.get(c["kind"])
    if not kind:
        return None
    p = f"/apis/apps/v1/namespaces/{NS}/{kind}/{c['workload']}"
    return p + "/scale" if scale else p

def status_of(c):
    if c["kind"] == "cluster":
        code, obj = k8s("GET", f"/apis/postgresql.cnpg.io/v1/namespaces/{NS}/clusters/{c['workload']}")
        if code != 200:
            return "unknown"
        return "running" if (obj.get("status", {}).get("readyInstances", 0) or 0) > 0 else "stopped"
    if c["kind"] == "job" or not c["workload"]:
        return "n/a"
    p = _workload_path(c)
    code, obj = k8s("GET", p)
    if code == 404:
        return "disabled"
    if code != 200:
        return "unknown"
    spec = obj.get("spec", {}).get("replicas", 0)
    ready = obj.get("status", {}).get("readyReplicas", 0) or 0
    if spec == 0:
        return "off"
    return "running" if ready > 0 else "starting"

def toggle(c):
    if not c["toggle"]:
        return False, "not toggleable"
    cur = status_of(c)
    target = 0 if cur in ("running", "starting") else 1
    code, _ = k8s("PATCH", _workload_path(c, scale=True), {"spec": {"replicas": target}})
    return code in (200, 201), f"scaled to {target}"

# --- docs ------------------------------------------------------------------
def read_doc(name):
    safe = "".join(ch for ch in name if ch.isalnum() or ch in "-_")
    for cand in (f"{DOCS_DIR}/components/{safe}.md", f"{DOCS_DIR}/{safe}.md"):
        if os.path.isfile(cand):
            with open(cand) as f:
                return f.read()
    return f"# {name}\n\n_No doc yet._"

# --- HTTP ------------------------------------------------------------------
INDEX = """<!doctype html><html><head><meta charset=utf-8><title>Sovereign Agentic OS — Admin</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--off:#f85149;--warn:#d29922;--ac:#58a6ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:18px 24px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:12px}
h1{font-size:18px;margin:0}.sub{color:var(--mut);font-size:13px}
.wrap{padding:20px 24px;max-width:1200px;margin:0 auto}
.layer{margin:22px 0 10px;color:var(--ac);font-size:13px;text-transform:uppercase;letter-spacing:.05em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.name{font-weight:600}.sum{color:var(--mut);font-size:12.5px;margin:6px 0 10px}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600}
.b-running{background:rgba(63,185,80,.15);color:var(--ok)} .b-off{background:rgba(248,81,73,.12);color:var(--off)}
.b-disabled{background:#21262d;color:var(--mut)} .b-starting,.b-unknown{background:rgba(210,153,34,.15);color:var(--warn)}
.meta{font-size:12px;color:var(--mut);margin:8px 0;word-break:break-all}.meta b{color:var(--fg);font-weight:600}
.btns{display:flex;gap:8px;margin-top:10px}
button{background:#21262d;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12.5px}
button:hover{border-color:var(--ac)} button.on{color:var(--ok)} button.offb{color:var(--off)} button:disabled{opacity:.4;cursor:default}
code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12px}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:9}
#panel{position:absolute;right:0;top:0;bottom:0;width:min(820px,92vw);background:var(--bg);border-left:1px solid var(--bd);overflow:auto;padding:24px}
#md h1,#md h2,#md h3{border-bottom:1px solid var(--bd);padding-bottom:4px}#md pre{background:var(--card);padding:12px;border-radius:6px;overflow:auto}
#md code{background:var(--card)}#md table{border-collapse:collapse}#md td,#md th{border:1px solid var(--bd);padding:4px 8px}
.x{float:right;cursor:pointer;color:var(--mut);font-size:20px}
.tabs{display:flex;gap:8px;margin-top:6px}.tab{cursor:pointer;color:var(--mut);padding:4px 2px}.tab.sel{color:var(--ac);border-bottom:2px solid var(--ac)}
</style></head><body>
<header><h1>🛰️ Sovereign Agentic OS</h1><span class=sub>Admin console — stack status, on/off, access &amp; docs</span>
<span class=sub style=margin-left:auto><a href="#" onclick="openDoc('cloud-configuration');return false" style=color:var(--ac)>☁️ Cloud config</a> · <a href="#" onclick="openDoc('getting-started');return false" style=color:var(--ac)>Getting started</a></span></header>
<div class=wrap id=app>loading…</div>
<div id=modal onclick="if(event.target.id=='modal')close_()"><div id=panel><span class=x onclick=close_()>×</span><div id=md></div></div></div>
<script src="/static/marked.min.js"></script>
<script>
async function load(){
  const cs = await (await fetch('/api/components')).json();
  const layers = [...new Set(cs.map(c=>c.layer))];
  let h='';
  for(const L of layers){
    h+=`<div class=layer>${L}</div><div class=grid>`;
    for(const c of cs.filter(x=>x.layer===L)){
      const b={running:'b-running',off:'b-off',disabled:'b-disabled',starting:'b-starting',unknown:'b-unknown','n/a':'b-disabled'}[c.status]||'b-unknown';
      const url = c.ui ? `http://localhost:${c.lport}${c.url_path||''}` : '';
      const pf = c.svc ? `kubectl -n ${c.ns} port-forward svc/${c.svc} ${c.lport}:${c.port}` : '—';
      h+=`<div class=card><div class=row><span class=name>${c.name}</span><span class="badge ${b}">${c.status}</span></div>
        <div class=sum>${c.summary}</div>
        <div class=meta><b>Access:</b> ${c.svc?`<code>${pf}</code>`:'—'}${url?`<br><b>URL:</b> <code>${url}</code>`:''}</div>
        <div class=meta><b>Login:</b> ${c.login}</div>
        <div class=btns>
          <button onclick="openDoc('${c.id}')">📖 Docs</button>
          ${c.toggle?`<button class="${c.status==='running'||c.status==='starting'?'offb':'on'}" onclick="tog('${c.id}',this)">${c.status==='running'||c.status==='starting'?'■ Turn off':'▶ Turn on'}</button>`:`<button disabled>core</button>`}
        </div></div>`;
    }
    h+='</div>';
  }
  document.getElementById('app').innerHTML=h;
}
async function tog(id,btn){btn.disabled=true;btn.textContent='…';await fetch('/api/toggle?id='+id,{method:'POST'});setTimeout(load,1200);}
async function openDoc(id){const md=await (await fetch('/api/doc/'+id)).text();document.getElementById('md').innerHTML=window.marked?marked.parse(md):'<pre>'+md.replace(/[<>]/g,'')+'</pre>';document.getElementById('modal').style.display='block';}
function close_(){document.getElementById('modal').style.display='none';}
load();setInterval(load,8000);
</script></body></html>"""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ct="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            return self._send(200, INDEX, "text/html; charset=utf-8")
        if u.path == "/healthz":
            return self._send(200, {"status": "ok"})
        if u.path == "/static/marked.min.js":
            p = "/app/marked.min.js"
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    return self._send(200, f.read(), "application/javascript")
            return self._send(404, b"", "application/javascript")
        if u.path == "/api/components":
            out = []
            for c in REG:
                d = dict(c); d["ns"] = NS; d["lport"] = c["port"]; d["status"] = status_of(c)
                out.append(d)
            return self._send(200, json.dumps(out))
        if u.path.startswith("/api/doc/"):
            return self._send(200, read_doc(u.path.split("/api/doc/", 1)[1]), "text/markdown; charset=utf-8")
        return self._send(404, {"error": "not found"})
    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/toggle":
            cid = (parse_qs(u.query).get("id") or [""])[0]
            c = BY_ID.get(cid)
            if not c:
                return self._send(404, {"error": "unknown"})
            okk, msg = toggle(c)
            return self._send(200 if okk else 400, {"ok": okk, "msg": msg})
        return self._send(404, {"error": "not found"})

if __name__ == "__main__":
    print(f"[admin] console on :{PORT} (ns={NS})")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
