/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  recurrenceToCron,
  cronToRecurrence,
  describeRecurrenceMessage,
  rawCronMessage,
  DAY_IDS,
  type DayId,
  type Frequency,
  type Recurrence,
} from '@tabs/agents/lib/cron-friendly';
import { isValidCron } from '@tabs/agents/lib/cron-util';
import { useTranslations } from '@core/i18n/client';

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

// Display order Mon → Sun; each label is `recurrence.days.<id>` in the catalog.
const DAYS: number[] = [1, 2, 3, 4, 5, 6, 0];

const FREQS: Frequency[] = ['daily', 'weekly', 'monthly'];

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
  const t = useTranslations('agents');
  const tk = (m: { key: string; args?: Record<string, string | number> }) => t(m.key as Parameters<typeof t>[0], m.args);
  const dayLabel = (id: DayId) => t(`recurrence.days.${id}`);
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

  const summary = tk(advanced ? rawCronMessage(rawCron) : describeRecurrenceMessage(rec, dayLabel));

  return (
    <div className="rec-editor">
      {!advanced ? (
        <>
          <div className="seg" role="group" aria-label={t('recurrence.frequency.aria')}>
            {FREQS.map((f) => (
              <button
                key={f}
                type="button"
                className={rec.frequency === f ? 'on' : ''}
                aria-pressed={rec.frequency === f}
                disabled={disabled}
                onClick={() => setFrequency(f)}
              >
                {t(`recurrence.frequency.${f}`)}
              </button>
            ))}
          </div>

          <div className="rec-row">
            <label className="rec-inline">
              <span className="rec-lbl">{t('recurrence.at')}</span>
              <input
                type="time"
                value={toTimeValue(rec)}
                disabled={disabled}
                onChange={(e) => setTime(e.target.value)}
                aria-label={t('recurrence.timeAria')}
              />
              <span className="hint" style={{ marginTop: 0 }}>{t('recurrence.serverTime')}</span>
            </label>
          </div>

          {rec.frequency === 'weekly' ? (
            <div className="rec-days" role="group" aria-label={t('recurrence.daysAria')}>
              {DAYS.map((d) => {
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
                    {dayLabel(DAY_IDS[d])}
                  </button>
                );
              })}
            </div>
          ) : null}

          {rec.frequency === 'monthly' ? (
            <div className="rec-row">
              <label className="rec-inline">
                <span className="rec-lbl">{t('recurrence.onDay')}</span>
                <select
                  value={rec.dayOfMonth ?? 1}
                  disabled={disabled}
                  onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  aria-label={t('recurrence.dayOfMonthAria')}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <span className="hint" style={{ marginTop: 0 }}>{t('recurrence.ofTheMonth')}</span>
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
        <summary>{t('recurrence.advanced')}</summary>
        <div className="rec-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            className="mono"
            value={rawCron}
            disabled={disabled}
            onChange={(e) => onRawChange(e.target.value)}
            style={{ maxWidth: 220 }}
            aria-label={t('recurrence.rawAria')}
            spellCheck={false}
          />
          <span className="hint" style={{ marginTop: 0 }}>{t('recurrence.cronFields')}</span>
        </div>
      </details>
    </div>
  );
}
