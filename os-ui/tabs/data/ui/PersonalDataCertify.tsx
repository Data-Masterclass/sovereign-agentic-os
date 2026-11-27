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

import { useTranslations } from '@core/i18n/client';
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
  const t = useTranslations('data');
  return (
    <select
      style={{ maxWidth: 170 }}
      value={value === true ? 'yes' : value === false ? 'no' : ''}
      onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined)}
      title={t('personalCertify.selectTitle')}
      aria-label={t('personalCertify.selectAria')}
    >
      <option value="">{t('personalCertify.unclassifiedOption')}</option>
      <option value="yes">{t('personalCertify.yesOption')}</option>
      <option value="no">{t('personalCertify.noOption')}</option>
    </select>
  );
}


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
  const t = useTranslations('data');
  const s = refusal?.personalData ?? status;
  if (!s) return null;
  const blocked = s.rule === 'block' && s.unprotected.length > 0;
  const ok = s.rule === 'off' || (s.unprotected.length === 0 && s.classified);
  return (
    <div className={`card${ok ? '' : ' warn'}`} style={{ marginBottom: 12, padding: '10px 14px' }} role={refusal ? 'alert' : undefined}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{t('personalCertify.title')}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t(s.ruleKnown === false ? 'personalCertify.ruleLineUnknown' : 'personalCertify.ruleLine', { rule: t(`personalCertify.rule.${s.rule}`) })}
        </span>
      </div>
      <div style={{ fontSize: 13, marginTop: 6 }}>
        {s.rule === 'off' ? (
          <span className="muted">{t('personalCertify.off')}</span>
        ) : s.unprotected.length > 0 ? (
          <span>
            {t.rich('personalCertify.unprotected', { columns: s.unprotected.join(', '), strong: (c) => <strong>{c}</strong> })}{' '}
            {blocked ? t('personalCertify.blocked') : ''}
          </span>
        ) : !s.classified ? (
          <span>
            {s.unclassifiedColumns.length
              ? t.rich('personalCertify.unclassified', { columns: s.unclassifiedColumns.join(', '), mono: (c) => <span className="mono">{c}</span> })
              : t('personalCertify.unclassifiedNone')}
          </span>
        ) : (
          <span className="ok-note">
            {s.personalColumns.length ? t('personalCertify.protected', { columns: s.protectedColumns.join(', ') }) : t('personalCertify.noneClassified')}
          </span>
        )}
      </div>
      {!ok ? (
        <div className="hint" style={{ marginTop: 6 }}>
          {s.unprotected.length > 0
            ? t(confirmApplies(s) ? 'personalCertify.fix.unprotectedConfirm' : 'personalCertify.fix.unprotected')
            : t(confirmApplies(s) ? 'personalCertify.fix.unclassifiedConfirm' : 'personalCertify.fix.unclassified')}
        </div>
      ) : null}
      {confirmApplies(s) && canConfirm ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={confirm.confirmed} onChange={(e) => onConfirmChange({ ...confirm, confirmed: e.target.checked })} />
            {s.unprotected.length > 0 ? t('personalCertify.confirmUnprotected') : t('personalCertify.confirmNone')}
          </label>
          <input
            style={{ flex: '1 1 240px' }}
            placeholder={t('personalCertify.reasonPlaceholder')}
            value={confirm.reason}
            onChange={(e) => onConfirmChange({ ...confirm, reason: e.target.value })}
          />
          <button className="btn" disabled={busy || !confirm.confirmed || !confirm.reason.trim()} onClick={onConfirmAndCertify}>
            {busy ? <span className="spin" /> : t('personalCertify.confirmAndCertify')}
          </button>
        </div>
      ) : confirmApplies(s) && !canConfirm ? (
        <div className="hint" style={{ marginTop: 6 }}>{t('personalCertify.certifierConfirms')}</div>
      ) : null}
    </div>
  );
}
