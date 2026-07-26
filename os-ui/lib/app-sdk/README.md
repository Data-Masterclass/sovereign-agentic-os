<!-- SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG -->

# `lib/app-sdk` — OS client SDK

## Purpose

A thin, dependency-free TypeScript SDK that lets a **governed app** call back into the Sovereign OS using the same OPA-checked, RLS/DLS-filtered routes the OS UI itself uses. It is not a new governance layer; it is a typed fetch wrapper that maps every refusal honestly to a typed error.

The primary use case is an app running inside the OS preview (same-origin, ambient session cookie) that needs to read datasets, search knowledge, or query metrics that were granted to it. A standalone deployed app pointing at a remote OS instance can also use it by passing `baseUrl`.

## Public API surface

```ts
import { createOsClient } from '@/lib/app-sdk';

const os = createOsClient();              // same-origin (preview)
// or:
const os = createOsClient({ baseUrl: 'https://os.example.com' });

await os.whoami();                        // WhoAmI — the signed-in principal
await os.context();                       // OsContext — granted connections/data/knowledge/files/metrics
await os.datasets.list();
await os.datasets.get(id);
await os.datasets.query(id, { nl: 'revenue by month' });  // NL→SQL (governed)
await os.metrics.list();
await os.metrics.query(id, { dimensions: ['country'], granularity: 'month' });
await os.knowledge.search('what is the return policy?'); // KnowledgeHit[]
await os.files.list();
await os.files.get(id);
```

Named exports: `createOsClient`, `joinUrl`, `withQuery`, `OsError`, `NotAuthenticated`, `Forbidden`, `UnsupportedQuery`, plus types `OsClient`, `OsClientOptions`, `WhoAmI`, `OsContext`, `ContextItem`, `KnowledgeHit`, `DatasetQuery`, `MetricQuery`.

## Invariants

- **Never bypasses governance.** Every method issues a request to a governed OS route. The SDK cannot widen what the session is allowed to see.
- **Raw client SQL is refused up front.** `datasets.query({ sql: '…' })` throws `UnsupportedQuery` locally — the OS never trusts client SQL strings.
- **Errors are honest.** `401 → NotAuthenticated`, governed `403 → Forbidden` (carries the server's reason verbatim), other non-2xx `→ OsError`. Nothing is swallowed into a fake success.
- **No dependencies.** Uses native `fetch`. Accepts an injectable `fetch` for test stubs and exotic runtimes.
- **Tree-shakeable named exports.** No barrel side-effects.
