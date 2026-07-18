# Connections — golden path

## What this is

The Connections tab stores named credentials for external systems — databases, APIs, SaaS tools, data warehouses. A connection is consumed by reference: software and agents declare which connection they need, and the OS injects credentials at runtime. The model executing a tool call never sees raw credentials. In the cross-tab spine, connections are the entry point for the software pathway; software wires to connections, and software output can close the loop back into the Bronze data tier.

## How to build it

1. **Know the catalog.** Call `list_connection_templates` to see what CAN be connected — each template's key, what it connects (Drive / Database / API / MCP / SaaS), whether it is personal (per-user OAuth, connectable by any user) or shared (service credentials, domain admin+ only), and the fields `create_connection` needs.
2. **Reuse check.** Call `list_connections` scoped to your domain. If a connection to the target system already exists at Domain or above, use it — do not create a duplicate credential. Call `get_connection` to inspect the connection type and metadata without seeing raw secrets.
3. **Create.** Call `create_connection` with `name`, a `template` key from `list_connection_templates`, `domain`, and the connection parameters. The connection is created in My scope (yours, no approval); credentials are encrypted at rest immediately.
4. **Test.** Call `test_connection` to verify reachability. The response includes a `status` (`live` or `offline`) and a `latencyMs` field. An `offline` result does not block promotion filing, but document the known state.
5. ⛔ **Domain admin promotes.** A domain admin (or tenant admin) calls `promote_connection` to promote the connection from My to Domain. Only after promotion can other domain members wire software to it.

**Note:** Apps consume connections via `use_connection` by reference — they declare the connection ID, not the credential values. The OS resolves credentials at deploy time. A creator cannot access another user's My-scope connection even if they know its ID.

## What to consider

- **One connection per system per domain.** Multiple connections to the same endpoint create drift in rotation, revocation, and auditing. Check `list_connections` thoroughly before creating.
- **test_connection is non-destructive.** It issues a read-only ping; it does not mutate state on the remote system.
- **Credentials are never returned.** `get_connection` returns metadata and type but never the secret values. If you need to rotate a credential, use the update path — never log or echo connection parameters.
- **Promotion prerequisite.** Software that depends on a My-scope connection cannot be deployed to Domain or above. Promote the connection first.
- **Idempotency.** `create_connection` on a name that already exists returns `conflict`. `promote_connection` on an already-Domain connection returns `conflict` — treat as idempotent.

## Governance

| Step | Role required |
|---|---|
| `list_connection_templates`, `list_connections`, `get_connection` | Creator |
| `create_connection`, `test_connection` | Creator (own work) |
| ⛔ `promote_connection` | Domain admin (or tenant admin) |

OPA enforces that credential values are never returned in tool responses. DLS scopes connection visibility to My → Domain → Company tiers. A `forbidden` error on `promote_connection` means you are a creator — file the request verbally and hand off to a domain admin.

**Worked example:**

```
list_connections({ domain: "data-eng", type: "postgres" })
→ [] — no existing Postgres connection in this domain

create_connection({ name: "prod-warehouse", type: "postgres",
  domain: "data-eng", host: "db.example.com", port: 5432, database: "dw" })
→ { id: "cn_07B...", state: "my", credentialsStored: true }

test_connection({ id: "cn_07B..." })
→ { status: "live", latencyMs: 12 }
```

A domain admin then calls `promote_connection({ id: "cn_07B..." })` to make it available to the domain.
