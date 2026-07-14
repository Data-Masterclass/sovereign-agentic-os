<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# Power BI consumption of governed metrics (Cube SQL API)

Connect Power BI to the Sovereign Agentic OS **governed metrics layer** over Cube's
Postgres-wire **SQL API**. Every query flows **Cube → Trino → OPA**, so Power BI reads
the same governed measures/dimensions the Metrics tab does — **never raw tables**. Access
is scoped **per OS domain**: each domain gets its own read-only BI principal that only
sees that domain's rows.

> **Honest scope — domain-level, not per-viewer.** A Power BI connection authenticates as
> one shared, read-only domain principal (`bi_<domain>`). Every viewer of a report built
> on it sees the **same domain-scoped rows**. This is **not** per-individual row-level
> security (e.g. one salesperson seeing only their region). Per-viewer RLS needs
> Entra ID → Cube JWT federation (each human's own token → `securityContext`) and is a
> **later phase**. Today: one BI identity per domain.

---

## How it works

| Piece | What it does |
|-------|--------------|
| **Cube SQL API** (`CUBEJS_PG_SQL_PORT=15432`) | A Postgres-wire listener. Power BI's *Get Data → PostgreSQL* speaks to it. |
| **Per-domain principal** `bi_<domain>` | The SQL username Power BI logs in as. All domains share one password (`CUBEJS_SQL_PASSWORD`); the **username** selects the domain. |
| **`checkSqlAuth`** (`cube.js`) | Verifies the shared password, then maps `bi_<domain>` → `securityContext { sub, domains:[<domain>], role:'creator', scope:'bi-readonly' }`. |
| **`queryRewrite`** (safety net) | Rejects any SQL-API connection that carries no domain scope, so an unscoped login can't read governed rows. |
| **Cube → Trino → OPA** | The `securityContext.domains` drives Trino/OPA row-level security → only that domain's rows come back. |

The mechanism mirrors `os-ui/lib/powerbi/principal.ts` (the pure logic + tests) and the
Cube config in `charts/sovereign-agentic-os/templates/cube/cube.yaml`
(`cube-sql-config` ConfigMap). Keep the two in sync if you change the mapping.

**Why one-user-per-domain (not one shared user + a "database" switch):** Power BI stores a
single credential per data source and passes the username straight through the Postgres
protocol. Encoding the domain in the **username** (`bi_sales`, `bi_finance`, …) is the
simplest scheme that (a) works unchanged with Power BI's connection UI, (b) needs no
per-request token, and (c) gives Cube a stable, auditable identity to resolve. The
password is shared and secret-managed; the username is not a secret — it only selects
scope, and `checkSqlAuth` still rejects a wrong password.

---

## Admin: enable + expose (operator)

**1. Turn the SQL API on** (Helm):

```bash
helm upgrade --install soa charts/sovereign-agentic-os \
  --set cube.sqlApi.enabled=true
```

This renders, when enabled:
- `CUBEJS_PG_SQL_PORT=15432` + a `pgsql` container port on the Cube pod;
- a `cube-sql-secrets` Secret (`CUBEJS_SQL_USER` / `CUBEJS_SQL_PASSWORD`) — the password
  is **generated** on first install and **preserved** across `helm upgrade` (marked
  `helm.sh/resource-policy: keep`);
- the `cube-sql-config` ConfigMap (`cube.js` with `checkSqlAuth`/`queryRewrite`), seeded
  into Cube's conf dir by the init container;
- a dedicated **`cube-sql`** Service on port `15432` (plus the port added to the existing
  `cube` Service).

> **GitOps caveat:** under Argo CD / Flux / `helm template`, Helm's `lookup` returns
> nothing, so the generated password would rotate on every sync and break Power BI. In
> those pipelines set `cube.sqlApi.password` explicitly (an ExternalSecret is ideal).

**2. Read the generated password** (to hand to a report author):

```bash
kubectl get secret cube-sql-secrets -n <ns> \
  -o jsonpath='{.data.CUBEJS_SQL_PASSWORD}' | base64 -d
```

**3. Expose the port** (Power BI Desktop / an on-prem data gateway is **outside** the
cluster). In-cluster the SQL API is only reachable as `cube-sql:15432`. To let Power BI
reach it, publish a **TCP** ingress / `LoadBalancer` / `NodePort` to the `cube-sql`
Service (a plain HTTP Ingress will not work — this is the Postgres wire protocol), then
point the OS at the external host so it advertises the right details.

**4. Point os-ui at the exposure** so the *Connect Power BI* details are accurate. Set
these env vars on the `os-ui` Deployment (read by `os-ui/lib/core/config.ts`):

| Env var | Meaning | Default |
|---------|---------|---------|
| `CUBE_SQL_API_ENABLED` | `true` when the SQL API is on | `false` |
| `CUBE_SQL_HOST` | Host builders connect to (the published ingress host) | `cube-sql` |
| `CUBE_SQL_PORT` | SQL API port | `15432` |
| `CUBE_SQL_PASSWORD_SECRET` | Secret name holding the password (shown as a reference) | `cube-sql-secrets` |

---

## Builder: connect Power BI to your domain

**Get the connection details** for your domain from the OS:

```
GET /api/powerbi/connection-info?domain=<your-domain>
```

Returns (example):

```json
{
  "enabled": true,
  "server": "cube-sql.example.com:15432",
  "host": "cube-sql.example.com",
  "port": 15432,
  "database": "bi_sales",
  "user": "bi_sales",
  "domain": "sales",
  "password": { "source": "vault", "secretName": "cube-sql-secrets", "key": "CUBEJS_SQL_PASSWORD" },
  "securityContext": { "sub": "bi:sales", "domains": ["sales"], "role": "creator", "scope": "bi-readonly" },
  "scopeNote": "Domain-level access: ... NOT per-individual row-level security ..."
}
```

The **password is never in this response** — only a reference to the Secret. Get the value
from your admin / vault (step 2 above). You can only request a domain you belong to.

**In Power BI Desktop:**

1. **Home → Get Data → PostgreSQL database**.
2. **Server**: the `server` value, e.g. `cube-sql.example.com:15432`.
3. **Database**: the `database` value, e.g. `bi_sales`.
4. **Data Connectivity mode**:
   - **Import** — pulls the governed aggregates into the model (fast dashboards, refresh
     on a schedule). Recommended default.
   - **DirectQuery** — every visual re-queries Cube live (always current, but each visual
     is a round-trip through Cube → Trino → OPA; keep visuals modest).
5. **Next → credentials**: choose **Database**, enter:
   - **User name**: the `user` value, e.g. `bi_sales`.
   - **Password**: the value from the Secret/vault.
6. **Connect.** You'll see the governed cubes as tables (e.g. `northpeakcommerce`) exposing
   the **measures + dimensions** — Revenue, AOV, Churn Rate, region, product, order_date —
   already filtered to your domain's rows. Build visuals against these; you cannot reach
   ungoverned base tables.

**Validate with any Postgres client** (optional):

```bash
psql "host=cube-sql.example.com port=15432 user=bi_sales dbname=bi_sales" \
     -c "SELECT MEASURE(revenue), region FROM northpeakcommerce GROUP BY region;"
```

Rows come back scoped to the `sales` domain. Logging in as a **different** domain's
principal (`bi_finance`) returns that domain's rows — never yours.

---

## Security notes

- **Read-only.** The BI principal carries the lowest role (`creator`) and a `bi-readonly`
  scope tag; it can only read governed measures/dimensions.
- **Governed, not raw.** The SQL API surfaces Cube's semantic model, not Trino tables.
  Trino/OPA still enforce RLS underneath via the domain in the `securityContext`.
- **Password handling.** The connection-info route and any UI built on it return a
  **reference** to the Secret, never the value. Deliver the password out-of-band
  (vault / admin hand-off).
- **Domain isolation.** `checkSqlAuth` resolves `bi_<domain>` strictly; a login that isn't
  a recognised BI principal gets an empty scope and `queryRewrite` rejects its queries.
- **Later phase.** Per-viewer RLS (Entra ID → Cube JWT) will let each human carry their own
  `securityContext` so two viewers of one report see different rows. Until then, treat a
  domain's BI principal as a shared, domain-wide read identity.
```
