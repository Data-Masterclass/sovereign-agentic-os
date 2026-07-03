/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import AgentChat from '@/components/AgentChat';

type Layer = 'silver' | 'gold';
type Stage = { layer: Layer; copy: { title: string; subtitle: string; tool: string } };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/** Plain-language Silver/Gold authoring: it writes the real dbt artifact + tests
 *  (shown under "the dbt this writes"), or carries the prior version forward. dbt
 *  TESTS are executed by the Build/Promote adapter (Phase 6) — so a freshly authored
 *  version reads "checks run on Build", never a faked ✓. */
function silverDbt(name: string, key: string): { sql: string; tests: string } {
  const s = slug(name);
  return {
    sql: `-- silver/stg_${s}.sql — dbt staging: typed, deduped, keyed (not yet integrated)
with src as (select * from {{ source('${'<domain>'}', '${s}') }})
select
  cast(${key} as varchar) as ${key},        -- business key
  *  -- (cast + clean the remaining columns)
from src
qualify row_number() over (partition by ${key} order by ${key}) = 1`,
    tests: `# schema.yml
models:
  - name: stg_${s}
    columns:
      - name: ${key}
        tests: [not_null, unique]`,
  };
}

function goldDbt(name: string): { sql: string; tests: string } {
  const s = slug(name);
  return {
    sql: `-- gold/mart_${s}.sql — dbt mart: harmonized star schema (facts + conformed dims)
{{ config(materialized='incremental', unique_key='${slug(name)}_id') }}
select *
from {{ ref('stg_${s}') }}`,
    tests: `# schema.yml — data-quality + freshness monitoring
models:
  - name: mart_${s}
    tests: [dbt_utils.recency]
    columns:
      - name: ${slug(name)}_id
        tests: [not_null, unique]`,
  };
}

export default function RefinePanel({
  datasetId,
  datasetName,
  stage,
  onCommitted,
}: {
  datasetId: string;
  datasetName: string;
  stage: Stage;
  onCommitted: (stages: unknown[]) => void;
}) {
  const [key, setKey] = useState('id');
  const tmpl = useMemo(
    () => (stage.layer === 'silver' ? silverDbt(datasetName, key) : goldDbt(datasetName)),
    [stage.layer, datasetName, key],
  );
  const [sql, setSql] = useState(tmpl.sql);
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'author' | 'pass' | ''>('');
  const prior = stage.layer === 'silver' ? 'Bronze' : 'Silver';

  // Regenerate the template when the key changes (only if the user hasn't hand-edited).
  const [edited, setEdited] = useState(false);
  const effectiveSql = edited ? sql : tmpl.sql;

  async function commit(passThrough: boolean) {
    setErr(''); setBusy(passThrough ? 'pass' : 'author');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          passThrough
            ? { layer: stage.layer, passThrough: true }
            : { layer: stage.layer, artifactBody: `${effectiveSql}\n\n${tmpl.tests}`, quality: 'unknown' },
        ),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not save'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        {stage.layer === 'silver'
          ? 'Clean the data and set its key. We write a dbt staging model (typed, deduplicated, keyed) plus not-null/unique tests on the key.'
          : 'Make it business-ready. We write a dbt mart (star schema) plus data-quality + freshness tests for monitoring.'}
      </p>

      {stage.layer === 'silver' ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <label className="muted" style={{ fontSize: 12.5 }}>Key (ID) column</label>
          <input value={key} onChange={(e) => { setKey(e.target.value); setEdited(false); }} style={{ maxWidth: 200 }} />
        </div>
      ) : null}

      <button className={`btn ghost sm${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)}>
        {showCode ? 'Hide the dbt this writes' : '‹ › Show the dbt this writes'}
      </button>
      {showCode ? (
        <div style={{ marginTop: 10 }}>
          <textarea className="mono" rows={9} value={effectiveSql}
            onChange={(e) => { setSql(e.target.value); setEdited(true); }} spellCheck={false} />
          <pre className="codeblock" style={{ marginTop: 8 }}>{tmpl.tests}</pre>
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => commit(false)} disabled={busy !== ''}>
          {busy === 'author' ? <span className="spin" /> : `Build ${stage.copy.title.split(' ')[0]} version`}
        </button>
      </div>
      <p className="hint" style={{ textAlign: 'right' }}>The dbt data-quality tests run when this builds into Trino at deploy — no green check until they pass.</p>

      <div className="passthrough-note">
        <strong>Already {stage.layer === 'silver' ? 'clean and keyed' : 'business-ready'}?</strong>{' '}
        Pass through — your <em>{prior}</em> version carries forward unchanged.
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={() => commit(true)} disabled={busy !== ''}>
            {busy === 'pass' ? <span className="spin" /> : `Pass through ${stage.copy.title.split(' ')[0]}…`}
          </button>
        </div>
      </div>

      <div className="section-title">Or ask the data agent</div>
      <AgentChat
        agent="data-product"
        label="data agent"
        minHeight={170}
        placeholder={`Tell the data agent how to ${stage.copy.title.toLowerCase()} for “${datasetName}”…`}
        starters={stage.layer === 'silver'
          ? [`Clean ${datasetName}: dedupe and set the key.`, `Type the columns in ${datasetName} and drop blanks.`]
          : [`Harmonize ${datasetName} into a star schema.`, `Add freshness + not-null checks to ${datasetName}.`]}
      />
    </div>
  );
}
