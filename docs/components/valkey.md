# Valkey — cache / queue

**What it is:** Valkey (BSD-3, **not** Redis) — the Redis-protocol queue/cache for Langfuse
(its job queue must not evict keys → `noeviction`). Cache only; not backed up.

## Access (no UI — valkey-cli)
```bash
kubectl -n agentic-os exec deploy/valkey -- valkey-cli -a valkey-local-dev ping    # PONG
```
**Auth:** password `valkey-local-dev`.

## FAQ
**Q: Why Valkey not Redis?** Redis went SSPL/RSALv2 (2024); Valkey (BSD-3) is the sovereign,
permissive fork.
**Q: Safe to turn off?** Langfuse's worker queue uses it — turning it off degrades Langfuse
ingestion. Leave it on unless you know you don't need async Langfuse.
