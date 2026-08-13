/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Input, Select } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient, type RecordResult } from '@/lib/app-sdk/index.ts';
import type { FormField } from '@/lib/software/appspec/schema.ts';
import type { IntakeWizardConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `intake-wizard` pattern: a multi-step click-through that collects fields across
 * `steps`, then writes ONE record through the governed `os.records.add`. Progress is HONEST
 * (a step rail + "Step X of N"); the write is envelope-gated server-side, so a refusal comes
 * back as `Forbidden` carrying the server's own reason, shown verbatim — success is NEVER
 * fabricated, and a `demo-seed` result (app runner not live) is labelled as such, not as a save.
 *
 * Required-field checks run PER STEP (you can't advance past a step with a missing required
 * field) — advisory only; the server is the real gate.
 */
export function IntakeWizardRenderer({ view, os }: { view: IntakeWizardConfig; os: OsClient }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
  const [result, setResult] = useState<RecordResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const steps = view.steps;
  const total = steps.length;
  const current = steps[Math.min(step, total - 1)];
  const isLast = step >= total - 1;

  const allFields = useMemo(() => steps.flatMap((s) => s.fields), [steps]);

  function setField(name: string, v: string) {
    setValues((p) => ({ ...p, [name]: v }));
  }

  /** Coerce a raw string to the field's declared type (empty stays empty/undefined). */
  function coerce(field: FormField, raw: string): unknown {
    if (raw === '') return undefined;
    if (field.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    if (field.type === 'boolean') return raw === 'true';
    return raw;
  }

  /** The required fields in the CURRENT step that are still empty. */
  function missingInStep(): FormField[] {
    return current.fields.filter((f) => f.required && (values[f.name] ?? '') === '');
  }

  function next() {
    setError(null);
    const missing = missingInStep();
    if (missing.length > 0) {
      setError(`Please fill in: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }
    setStep((s) => Math.min(total - 1, s + 1));
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function submit() {
    setError(null);
    const missing = missingInStep();
    if (missing.length > 0) {
      setError(`Please fill in: ${missing.map((f) => f.label).join(', ')}`);
      return;
    }

    const record: Record<string, unknown> = {};
    for (const f of allFields) {
      const v = coerce(f, values[f.name] ?? '');
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
    setStep(0);
    setStatus('idle');
  }

  // Completed state — an honest result card, never a fake "saved".
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 520 }}>
      {/* Step rail — the honest progress signal. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {steps.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                aria-current={active ? 'step' : undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  fontFamily: 'var(--sb-font-head)',
                  fontSize: 12,
                  fontWeight: 600,
                  border: '1px solid var(--sb-border-strong)',
                  background: active ? 'var(--sb-gold-soft)' : done ? 'var(--sb-teal-soft)' : 'transparent',
                  color: active ? 'var(--sb-gold-text)' : done ? 'var(--sb-teal)' : 'var(--sb-text-faint)',
                  boxShadow: active ? 'inset 0 0 0 1px var(--sb-gold-line)' : 'none',
                }}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: active ? 'var(--sb-text)' : 'var(--sb-text-faint)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {s.title}
              </span>
              {i < total - 1 && <span style={{ width: 22, height: 1, background: 'var(--sb-border)' }} />}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 16, fontWeight: 600 }}>{current.title}</div>
        <Badge tone="muted">
          Step {step + 1} of {total}
        </Badge>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {current.fields.map((f) => (
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {step > 0 && (
          <Button variant="ghost" onClick={back} disabled={status === 'submitting'}>
            ‹ Back
          </Button>
        )}
        {isLast ? (
          <Button onClick={submit} disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Saving…' : view.submitLabel}
          </Button>
        ) : (
          <Button onClick={next}>Next ›</Button>
        )}
      </div>
    </div>
  );
}
