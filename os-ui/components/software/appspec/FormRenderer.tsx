/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Input, Select } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient, type RecordResult } from '@/lib/app-sdk/index.ts';
import type { FormField } from '@/lib/software/appspec/schema.ts';
import type { FormConfig } from '@/lib/software/appspec/patterns.ts';
import { coerceField } from '@/lib/software/appspec/interactive-logic.ts';

/**
 * Render the `form` pattern: a single-screen create. Collect `fields`, then write ONE record via
 * the governed `os.records.add` — the one-step sibling of `intake-wizard`, sharing its HONEST
 * result contract: a governed refusal surfaces as `Forbidden` (its reason shown verbatim), a
 * `demo-seed` result is labelled as illustrative (never a fake "saved"), and only a real
 * `live-app` write claims "Saved." Required-field checks are advisory; the server is the gate.
 */
export function FormRenderer({ view, os }: { view: FormConfig; os: OsClient }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
  const [result, setResult] = useState<RecordResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = view.fields;
  const submitLabel = view.submitLabel ?? 'Save';

  function setField(name: string, v: string) {
    setValues((p) => ({ ...p, [name]: v }));
  }

  const missing = useMemo(
    () => fields.filter((f) => f.required && (values[f.name] ?? '') === ''),
    [fields, values],
  );

  async function submit() {
    setError(null);
    if (missing.length > 0) {
      setError(`Please fill in: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }
    const record: Record<string, unknown> = {};
    for (const f of fields) {
      const v = coerceField(f.type, values[f.name] ?? '');
      if (v !== undefined) record[f.name] = v;
    }
    setStatus('submitting');
    try {
      const r = await os.records.add(record);
      setResult(r);
      setStatus('done');
    } catch (err: unknown) {
      setStatus('idle');
      if (err instanceof Forbidden) setError(err.reason); // governed refusal, verbatim
      else setError(err instanceof Error ? err.message : String(err));
    }
  }

  function reset() {
    setValues({});
    setResult(null);
    setError(null);
    setStatus('idle');
  }

  if (status === 'done' && result) {
    const live = result.source === 'live-app';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
        <Alert variant={live ? 'success' : 'info'}>
          {live ? 'Saved.' : `Not saved for real — ${result.note ?? 'the app runner is not live (demo-seed).'}`}
        </Alert>
        <div>
          <Button variant="ghost" onClick={reset}>
            New entry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {fields.map((f: FormField) => (
          <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <span>
              {f.label}
              {f.required ? ' *' : ''}
            </span>
            {f.type === 'boolean' ? (
              <Select value={values[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)}>
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <Input
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                value={values[f.name] ?? ''}
                onChange={(e) => setField(f.name, e.target.value)}
                required={f.required}
              />
            )}
          </label>
        ))}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div>
        <Button onClick={submit} disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
