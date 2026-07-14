/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  recurrenceToCron,
  cronToRecurrence,
  describeRecurrence,
  type Frequency,
  type Recurrence,
} from '@/lib/agents/cron-friendly';
import { isValidCron } from '@/lib/agents/cron-util';

/**
 * Outlook-style recurring-schedule editor. Business users pick a plain-English
 * recurrence (Daily · Weekly · Monthly at a time); we generate the raw cron under the
 * hood and emit it through `onChange`. Power users can drop into an "Advanced (cron)"
 * field for anything the friendly model can't express. Controlled: the source of truth
 * is the incoming `cron` string; the component only owns transient edit state.
 *
 * The CronJob runs in the CLUSTER's timezone, so we LABEL the time as server/UTC time
 * (we do NOT offer timezone selection here) to avoid implying local time.
 */

const DAYS: { d: number; label: string }[] = [
  { d: 1, label: 'Mon' },
  { d: 2, label: 'Tue' },
  { d: 3, label: 'Wed' },
  { d: 4, label: 'Thu' },
  { d: 5, label: 'Fri' },
  { d: 6, label: 'Sat' },
  { d: 0, label: 'Sun' },
];

const FREQS: { f: Frequency; label: string }[] = [
  { f: 'daily', label: 'Daily' },
  { f: 'weekly', label: 'Weekly' },
  { f: 'monthly', label: 'Monthly' },
];

const DEFAULT_RECURRENCE: Recurrence = { frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1] };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "HH:MM" for a native <input type="time"> value. */
function toTimeValue(r: Recurrence): string {
  return `${pad2(r.hour)}:${pad2(r.minute)}`;
}

export default function RecurrenceEditor({
  cron,
  onChange,
  disabled = false,
}: {
  cron: string;
  onChange: (cron: string) => void;
  disabled?: boolean;
}) {
  // Parse the incoming cron once per change. If it maps to a friendly recurrence we run
  // in friendly mode; otherwise we start (and stay) in Advanced with the raw value.
  const parsed = useMemo(() => cronToRecurrence(cron), [cron]);
  const [rec, setRec] = useState<Recurrence>(parsed ?? DEFAULT_RECURRENCE);
  const [advanced, setAdvanced] = useState<boolean>(parsed === null);
  const [rawCron, setRawCron] = useState<string>(cron);

  // Re-sync from props when the persisted cron changes underneath us.
  useEffect(() => {
    setRawCron(cron);
    const p = cronToRecurrence(cron);
    if (p) {
      setRec(p);
      setAdvanced(false);
    } else {
      setAdvanced(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cron]);

  // Emit a new recurrence: update local state AND the generated cron upward.
  const applyRecurrence = (next: Recurrence) => {
    setRec(next);
    const c = recurrenceToCron(next);
    setRawCron(c);
    onChange(c);
  };

  const setFrequency = (f: Frequency) => {
    if (f === rec.frequency) return;
    const base: Recurrence = { frequency: f, hour: rec.hour, minute: rec.minute };
    if (f === 'weekly') base.daysOfWeek = rec.daysOfWeek?.length ? rec.daysOfWeek : [1];
    if (f === 'monthly') base.dayOfMonth = rec.dayOfMonth ?? 1;
    applyRecurrence(base);
  };

  const setTime = (value: string) => {
    const [h, m] = value.split(':').map((n) => Number(n));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    applyRecurrence({ ...rec, hour: Math.min(23, Math.max(0, h)), minute: Math.min(59, Math.max(0, m)) });
  };

  const toggleDay = (d: number) => {
    const cur = new Set(rec.daysOfWeek ?? []);
    if (cur.has(d)) cur.delete(d);
    else cur.add(d);
    const days = Array.from(cur);
    // Keep at least one day selected so the schedule stays valid.
    applyRecurrence({ ...rec, daysOfWeek: days.length ? days : [d] });
  };

  const setDayOfMonth = (n: number) => applyRecurrence({ ...rec, dayOfMonth: n });

  // Advanced raw-cron edit: keep it if valid; only re-enter friendly mode when it maps.
  const onRawChange = (value: string) => {
    setRawCron(value);
    if (isValidCron(value)) {
      onChange(value);
      const p = cronToRecurrence(value);
      if (p) setRec(p);
    }
  };

  const summary = advanced
    ? isValidCron(rawCron)
      ? `Runs on cron ${rawCron.trim()}`
      : 'Enter a valid 5-field cron (minute hour day month weekday).'
    : `Runs ${lower(describeRecurrence(rec))}`;

  return (
    <div className="rec-editor">
      {!advanced ? (
        <>
          <div className="seg" role="group" aria-label="Frequency">
            {FREQS.map((f) => (
              <button
                key={f.f}
                type="button"
                className={rec.frequency === f.f ? 'on' : ''}
                aria-pressed={rec.frequency === f.f}
                disabled={disabled}
                onClick={() => setFrequency(f.f)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="rec-row">
            <label className="rec-inline">
              <span className="rec-lbl">At</span>
              <input
                type="time"
                value={toTimeValue(rec)}
                disabled={disabled}
                onChange={(e) => setTime(e.target.value)}
                aria-label="Time of day"
              />
              <span className="hint" style={{ marginTop: 0 }}>server time (UTC)</span>
            </label>
          </div>

          {rec.frequency === 'weekly' ? (
            <div className="rec-days" role="group" aria-label="Days of week">
              {DAYS.map(({ d, label }) => {
                const on = (rec.daysOfWeek ?? []).includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`rec-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() => toggleDay(d)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {rec.frequency === 'monthly' ? (
            <div className="rec-row">
              <label className="rec-inline">
                <span className="rec-lbl">On day</span>
                <select
                  value={rec.dayOfMonth ?? 1}
                  disabled={disabled}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  aria-label="Day of month"
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <span className="hint" style={{ marginTop: 0 }}>of the month</span>
              </label>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="rec-summary">{summary}</div>

      <details
        className="rec-advanced"
        open={advanced}
        onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary>Advanced (cron)</summary>
        <div className="rec-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            className="mono"
            value={rawCron}
            disabled={disabled}
            onChange={(e) => onRawChange(e.target.value)}
            style={{ maxWidth: 220 }}
            aria-label="Raw cron expression"
            spellCheck={false}
          />
          <span className="hint" style={{ marginTop: 0 }}>minute hour day month weekday</span>
        </div>
      </details>
    </div>
  );
}

/** Lowercase the first letter of a describe string so it reads after "Runs ". */
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
