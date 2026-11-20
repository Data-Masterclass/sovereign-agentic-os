# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""litellm-stored-secrets.py — what LiteLLM stores encrypted, counted by LiteLLM's own code.

Runs INSIDE the LiteLLM container (scripts/ops/rotate-secrets.sh sends it over stdin to
`kubectl exec -i … python -c <loader>`). READ-ONLY: it runs only the SELECTs of LiteLLM's own
re-key scan (litellm/proxy/db/master_key_migration.py: `_secret_columns_in`, `_rows_of`,
`replace_ciphertexts`) and LiteLLM's own `decrypt_if_encrypted_with`, which returns None unless a
value is a ciphertext under the given key. No value, plaintext or key is ever printed.

Input: the first stdin line is JSON {"keys": {"<label>": "<key>"}}: extra keys to count under (for
example the previous master key). The key this proxy decrypts with is always counted, as
"effective": LITELLM_SALT_KEY if set, otherwise the master key (PROXY_MASTER_KEY) — exactly
`get_salt_key()`.

Output: one JSON line {"salt_key_set": bool, "columns": {"<table>.<column>": {"rows": n,
"<label>": n, …}}, "total": {"<label>": n}}. `rows` is the number of non-null rows LiteLLM's scan
reads (for the marked-only columns, the rows holding a marked ciphertext).
"""
import asyncio
import json
import os
import sys


async def main(params):
    from prisma import Prisma

    from litellm.proxy.common_utils.encrypt_decrypt_utils import decrypt_if_encrypted_with
    from litellm.proxy.db import master_key_migration as m

    keys = {"effective": os.environ.get("LITELLM_SALT_KEY") or os.environ.get("PROXY_MASTER_KEY") or ""}
    keys.update(params.get("keys") or {})
    db = Prisma(datasource={"url": os.environ["DATABASE_URL"]})
    await db.connect()
    try:
        out = {}
        for col in await m._secret_columns_in(db):
            rows = await m._rows_of(db, col)
            entry = out.setdefault(f"{col.table}.{col.column}", {"rows": 0, **{label: 0 for label in keys}})
            entry["rows"] += len(rows)
            for row in rows:
                stored = m._STORED_VALUE.validate_python(row[col.column])
                for label, key in keys.items():
                    if not key:
                        continue
                    found = m.replace_ciphertexts(
                        stored, lambda v, k=key: None if decrypt_if_encrypted_with(v, k) is None else v
                    )[1]
                    entry[label] += found
        total = {label: sum(e[label] for e in out.values()) for label in keys}
        print(json.dumps({"salt_key_set": "LITELLM_SALT_KEY" in os.environ, "columns": out, "total": total}))
    finally:
        await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main(json.loads(sys.stdin.readline() or "{}")))
