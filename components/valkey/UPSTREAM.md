# Valkey

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** BSD-3-Clause
- **Source:** https://github.com/valkey-io/valkey
- **Pinned as:** Image `valkey/valkey:8.1-alpine@sha256:77643d152547b446fc15cbafaff22004545663fcd40c6b28038ad283837baa75`

**Why the OS ships it:** Queues and caches (Langfuse worker, LiteLLM).

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
