/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Personal data before Company certification — the column classifier and the certify check
 * USER STORY: As a dataset owner I mark which columns hold personal data; as a certifier I see,
 *             before I certify to Company, which personal-data columns every domain would read in
 *             clear, what the admin rule says, and — where the rule allows it — I confirm with a reason.
 * ARCHITECTURE:
 *   - `PersonalDataSelect` edits `ColumnDoc.personalData` (Yes / No / not classified) in the
 *     Documentation form; the docs route stores it (the ONE classification source).
 *   - `PersonalDataCertifyCheck` renders the server's answer — the certify route's GET
 *     `personalData` status, or a 409 refusal's `personalData` detail. It decides nothing: the
 *     rule is enforced in the store (`personal-data-gate.ts`); this only shows it and collects the
 *     certifier's confirmation, which the certify call sends as `personalData: {confirmed, reason}`.
 */
'use client';

import type { ColumnDoc } from '@tabs/data/lib/dataset-schema';

export type PersonalDataStatus = {
  rule: 'block' | 'confirm' | 'off';
  ruleKnown?: boolean;
  classified: boolean;
  personalColumns: string[];
  protectedColumns: string[];
  unprotected: string[];
  unclassifiedColumns: string[];
  fix?: string;
};
export type PersonalDataRefusal = { code: string; error: string; personalData: PersonalDataStatus };
export type PersonalDataConfirm = { confirmed: boolean; reason: string };

/** Set (or clear) a column's classification without leaving an `undefined` key behind. */
export function withPersonalData(c: ColumnDoc, v: boolean | undefined): ColumnDoc {
  const { personalData: _drop, ...rest } = c;
  void _drop;
  return v === undefined ? rest : { ...rest, personalData: v };
}

export function PersonalDataSelect({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <select
      style={{ maxWidth: 170 }}
      value={value === true ? 'yes' : value === false ? 'no' : ''}
      onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined)}
      title="Personal data (PII): does this column identify or describe a person? Checked before certifying to Company."
      aria-label="Personal data"
    >
      <option value="">Personal data: not classified</option>
      <option value="yes">Personal data: yes</option>
      <option value="no">Personal data: no</option>
    </select>
  );
}

const RULE_WORD: Record<PersonalDataStatus['rule'], string> = {
  block: 'Block — unmasked personal data cannot be certified',
  confirm: 'Confirm — the certifier confirms with a reason',
  off: 'Off — not checked',
};

/** Whether the certifier's confirmation box applies to this status under its rule. */
export function confirmApplies(s: PersonalDataStatus): boolean {
  if (s.rule === 'off') return false;
  if (s.unprotected.length > 0) return s.rule === 'confirm';
  return !s.classified;
}

export function PersonalDataCertifyCheck({
  status,
  refusal,
  canConfirm,
  confirm,
  onConfirmChange,
  onConfirmAndCertify,
  busy,
}: {
  status: PersonalDataStatus | null;
  refusal: PersonalDataRefusal | null;
  /** Only the certifier (a platform Admin) confirms; a requester just sees the check. */
  canConfirm: boolean;
  confirm: PersonalDataConfirm;
  onConfirmChange: (c: PersonalDataConfirm) => void;
  onConfirmAndCertify: () => void;
  busy: boolean;
}) {
  const s = refusal?.personalData ?? status;
  if (!s) return null;
  const blocked = s.rule === 'block' && s.unprotected.length > 0;
  const ok = s.rule === 'off' || (s.unprotected.length === 0 && s.classified);
  return (
    <div className={`card${ok ? '' : ' warn'}`} style={{ marginBottom: 12, padding: '10px 14px' }} role={refusal ? 'alert' : undefined}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Personal data before Company</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Rule: {RULE_WORD[s.rule]}{s.ruleKnown === false ? ' (the saved setting could not be read yet — Block applies)' : ''}
        </span>
      </div>
      <div style={{ fontSize: 13, marginTop: 6 }}>
        {s.rule === 'off' ? (
          <span className="muted">The platform admin has turned this check off.</span>
        ) : s.unprotected.length > 0 ? (
          <span>
            Every domain would read these personal-data columns in clear: <strong>{s.unprotected.join(', ')}</strong>.{' '}
            {blocked ? 'Certification is refused until they are masked or hidden.' : ''}
          </span>
        ) : !s.classified ? (
          <span>
            Not every column is classified{s.unclassifiedColumns.length ? <> (<span className="mono">{s.unclassifiedColumns.join(', ')}</span>)</> : ' (no columns are documented)'}.
          </span>
        ) : (
          <span className="ok-note">
            {s.personalColumns.length ? `Personal-data columns are masked or hidden for other domains (${s.protectedColumns.join(', ')}).` : 'Classified: no personal-data columns.'}
          </span>
        )}
      </div>
      {!ok ? (
        <div className="hint" style={{ marginTop: 6 }}>
          How to fix: {s.unprotected.length > 0
            ? 'add a mask or hide for these columns to the dataset’s grants (other domains then see them masked), or set them to “Personal data: no” in Documentation if that is wrong.'
            : 'set “Personal data” to Yes or No for every column in Documentation and save'}
          {confirmApplies(s) ? ' — or confirm below with a reason.' : '.'}
        </div>
      ) : null}
      {confirmApplies(s) && canConfirm ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={confirm.confirmed} onChange={(e) => onConfirmChange({ ...confirm, confirmed: e.target.checked })} />
            {s.unprotected.length > 0 ? 'I confirm every domain may read these columns in clear' : 'I confirm this dataset holds no personal data'}
          </label>
          <input
            style={{ flex: '1 1 240px' }}
            placeholder="Reason (recorded in the audit log)"
            value={confirm.reason}
            onChange={(e) => onConfirmChange({ ...confirm, reason: e.target.value })}
          />
          <button className="btn" disabled={busy || !confirm.confirmed || !confirm.reason.trim()} onClick={onConfirmAndCertify}>
            {busy ? <span className="spin" /> : 'Confirm and certify'}
          </button>
        </div>
      ) : confirmApplies(s) && !canConfirm ? (
        <div className="hint" style={{ marginTop: 6 }}>The platform Admin who certifies it confirms this, with a reason.</div>
      ) : null}
    </div>
  );
}
