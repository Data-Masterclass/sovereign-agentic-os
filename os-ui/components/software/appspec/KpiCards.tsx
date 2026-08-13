/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/lib/app-ui/index.ts';
import type { OsClient } from '@/lib/app-sdk/index.ts';
import type { KpiCard } from '@/lib/software/appspec/patterns.ts';
import { aggregateDataset, formatKpi, metricScalar } from '@/lib/software/appspec/render-kpi.ts';
import type { AppFunction } from '@/lib/software/appspec/functions-schema.ts';
import { evaluateFunctions, type FunctionValues } from '@/lib/software/appspec/functions-eval.ts';

/**
 * A responsive grid of headline number cards — the shared body of the `kpi-overview` pattern and
 * the `landing` KPI block. Each card resolves its own number independently (a metric scalar, or a
 * dataset count/sum/avg) so one slow/failed source never blanks the row: a card shows its own
 * loading tick, its own error, or its own honest big number. Beautiful big-number styling with a
 * calm caption; never a fabricated value.
 */
type CardState = { status: 'loading' | 'ready' | 'error'; value?: number | boolean | null; error?: string };

/**
 * Resolve one card's number. Metric/dataset cards fetch their own source independently. A
 * `function` card renders a PRE-EVALUATED value from the shared `functionValues` map (all
 * functions are resolved ONCE for the whole grid, so an aggregate reused by several cards is
 * queried once) — while that map is still loading the card shows its own tick.
 */
function useCardValue(
  card: KpiCard,
  os: OsClient,
  functionValues: FunctionValues | undefined,
  functionsLoading: boolean,
): CardState {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const isFn = !!card.function;
  const key = card.metric
    ? `m:${card.metric.metricId}`
    : card.dataset
      ? `d:${card.dataset.datasetId}:${card.dataset.agg}:${card.dataset.field ?? ''}`
      : `f:${card.function?.functionId}`;

  useEffect(() => {
    // Function cards don't fetch here — they read the shared pre-evaluated map (handled below).
    if (isFn) return;
    let alive = true;
    setState({ status: 'loading' });
    const run = async () => {
      if (card.metric) {
        const r = await os.metrics.query(card.metric.metricId, {});
        return metricScalar(r);
      }
      if (card.dataset) {
        const r = await os.datasets.query(card.dataset.datasetId, { limit: 5000 });
        return aggregateDataset(r, card.dataset.agg, card.dataset.field);
      }
      return null;
    };
    run()
      .then((value) => alive && setState({ status: 'ready', value }))
      .catch((e: unknown) => alive && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [os, key, isFn]);

  if (isFn) {
    if (functionsLoading || functionValues === undefined) return { status: 'loading' };
    const id = card.function!.functionId;
    // A declared-but-missing key resolves to null (honest "no value"), never a crash.
    return { status: 'ready', value: functionValues[id] ?? null };
  }
  return state;
}

/** Format a resolved KPI value: numbers via the compact formatter, booleans as Yes/No, null as —. */
function displayValue(v: number | boolean | null | undefined): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return formatKpi(v ?? null);
}

function KpiCardTile({
  card,
  os,
  functionValues,
  functionsLoading,
}: {
  card: KpiCard;
  os: OsClient;
  functionValues: FunctionValues | undefined;
  functionsLoading: boolean;
}) {
  const state = useCardValue(card, os, functionValues, functionsLoading);
  const sub = card.metric
    ? card.metric.metricId
    : card.dataset
      ? `${card.dataset.agg}${card.dataset.field ? ` · ${card.dataset.field}` : ''}`
      : card.function
        ? `fn · ${card.function.functionId}`
        : '';

  return (
    <div
      className="sb-card"
      style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '1.2px',
          color: 'var(--sb-text-muted)',
          fontFamily: 'var(--sb-font-head)',
        }}
      >
        {card.label}
      </div>
      <div
        style={{
          fontFamily: 'var(--sb-font-head)',
          fontSize: 34,
          fontWeight: 600,
          lineHeight: 1.1,
          color: 'var(--sb-text)',
          letterSpacing: '-0.5px',
        }}
      >
        {state.status === 'loading' ? '…' : state.status === 'error' ? '—' : displayValue(state.value)}
      </div>
      {state.status === 'error' ? (
        <div style={{ fontSize: 11.5, color: 'var(--sb-danger, #b5482f)' }}>Could not load: {state.error}</div>
      ) : (
        sub && <div style={{ fontSize: 12, color: 'var(--sb-text-faint)' }}>{sub}</div>
      )}
    </div>
  );
}

/**
 * Evaluate the app's backend DSL functions ONCE for the card grid (each aggregate dataset queried
 * a single time inside `evaluateFunctions`, then expressions folded over the DAG). Only runs when
 * a card actually references a function — a purely metric/dataset grid pays nothing.
 */
function useFunctionValues(
  functions: AppFunction[] | undefined,
  cards: KpiCard[],
  os: OsClient,
): { values: FunctionValues | undefined; loading: boolean } {
  const needsFunctions = cards.some((c) => c.function) && !!functions && functions.length > 0;
  const [values, setValues] = useState<FunctionValues | undefined>(undefined);
  const [loading, setLoading] = useState(needsFunctions);

  useEffect(() => {
    if (!needsFunctions) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    evaluateFunctions(functions!, os)
      .then((v) => {
        if (alive) {
          setValues(v);
          setLoading(false);
        }
      })
      .catch(() => {
        // evaluateFunctions never throws; this is belt-and-braces. Fall back to empty (all null).
        if (alive) {
          setValues({});
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [os, needsFunctions, functions]);

  return { values, loading };
}

export function KpiCards({
  cards,
  os,
  functions,
}: {
  cards: KpiCard[];
  os: OsClient;
  functions?: AppFunction[];
}) {
  const { values, loading } = useFunctionValues(functions, cards, os);
  if (cards.length === 0) return <Alert variant="info">No cards configured.</Alert>;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 16,
      }}
    >
      {cards.map((card, i) => (
        <KpiCardTile key={`${card.label}-${i}`} card={card} os={os} functionValues={values} functionsLoading={loading} />
      ))}
    </div>
  );
}

export function KpiOverviewRenderer({
  view,
  os,
  functions,
}: {
  view: { cards: KpiCard[] };
  os: OsClient;
  functions?: AppFunction[];
}) {
  return <KpiCards cards={view.cards} os={os} functions={functions} />;
}
