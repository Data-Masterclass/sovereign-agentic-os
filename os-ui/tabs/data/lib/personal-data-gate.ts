/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Personal data before Company certification — the check and the decision
 * USER STORY: As a platform admin I want a dataset with personal-data columns that every domain
 *             could read unmasked to be refused (or confirmed with a reason, or not checked —
 *             my setting) BEFORE it becomes a Company dataset, with the exact columns and the fix.
 * ARCHITECTURE:
 *   - PURE. `personalDataCheck` reads the ONE classification source (`ColumnDoc.personalData` in
 *     dataset.yaml) and the ONE masking source (`maskedColumns` from the policy compiler — the
 *     grant `mask` / `hide` lists Trino enforces), so what is "protected" here is exactly what the
 *     query engine masks for other domains.
 *   - `decidePersonalData` applies the admin rule (`core/policy/personal-data-rule.ts`):
 *       block   — unprotected personal data → refused (no override). No complete classification →
 *                 refused unless the certifier classifies the columns or confirms with a reason.
 *       confirm — unprotected personal data or no classification → the certifier confirms with a
 *                 reason, or it is refused.
 *       off     — not checked.
 *   - Called from `store.certify` / `store.transition('certify')` only — the choke point every door
 *     (Data route, Governance approvals, legacy approvals, MCP decide_approval) reaches.
 *   - A refusal is a typed `PersonalDataGateError` (409, `code`, `personalData` detail) so each
 *     door can show the columns and the fix.
 */
import { DatasetError, type CertificationPersonalData, type Dataset, type Grant } from '@tabs/data/lib/dataset-schema';
import { maskedColumns } from '@tabs/data/lib/policy/compiler';
import type { PersonalDataRule } from '@core/policy/personal-data-rule';

export type PersonalDataCheck = {
  /** Every documented column carries a personal-data classification (true or false). */
  classified: boolean;
  /** Columns classified as personal data. */
  personalColumns: string[];
  /** Personal-data columns masked or hidden for other domains. */
  protectedColumns: string[];
  /** Personal-data columns every domain would read in clear once Company. */
  unprotected: string[];
  /** Documented columns with no classification yet. */
  unclassifiedColumns: string[];
};

/** The certifier's explicit confirmation ("no personal data / accepted") and why. */
export type PersonalDataConfirmation = { confirmed: boolean; reason: string };

export type PersonalDataCode = 'personal_data_unprotected' | 'personal_data_unclassified' | 'personal_data_confirmation_required';

export class PersonalDataGateError extends DatasetError {
  personalData: PersonalDataCheck & { rule: PersonalDataRule; fix: string };
  constructor(message: string, code: PersonalDataCode, detail: PersonalDataCheck & { rule: PersonalDataRule; fix: string }) {
    super(message, 409, { code });
    this.name = 'PersonalDataGateError';
    this.personalData = detail;
  }
}

/** What the rule would see for this dataset with these grants (the ones it will carry as Company). */
export function personalDataCheck(d: Pick<Dataset, 'columns'>, grants: Grant[]): PersonalDataCheck {
  const cols = d.columns.filter((c) => c.name.trim());
  const masked = maskedColumns(grants);
  const personalColumns = cols.filter((c) => c.personalData === true).map((c) => c.name);
  const unclassifiedColumns = cols.filter((c) => typeof c.personalData !== 'boolean').map((c) => c.name);
  return {
    classified: cols.length > 0 && unclassifiedColumns.length === 0,
    personalColumns,
    protectedColumns: personalColumns.filter((c) => masked.has(c)),
    unprotected: personalColumns.filter((c) => !masked.has(c)),
    unclassifiedColumns,
  };
}

const FIX_UNPROTECTED =
  'Add a mask or hide for these columns to the dataset’s grants (other domains then see them masked), or reclassify them as not personal data in Documentation if that is wrong.';
const FIX_UNCLASSIFIED =
  'Classify every column in Documentation (set “Personal data” to Yes or No for each column and save), or confirm with a reason that the dataset holds no personal data.';

function validConfirmation(c: PersonalDataConfirmation | undefined): c is PersonalDataConfirmation {
  return !!c && c.confirmed === true && typeof c.reason === 'string' && c.reason.trim().length > 0;
}

/**
 * Apply the rule. Returns what to record on the certification badge (and in the audit), or throws
 * a `PersonalDataGateError` naming the columns and the fix.
 */
export function decidePersonalData(
  check: PersonalDataCheck,
  rule: PersonalDataRule,
  confirmation?: PersonalDataConfirmation,
): CertificationPersonalData {
  if (rule === 'off') return { rule, outcome: 'not-checked' };
  if (confirmation?.confirmed === true && !validConfirmation(confirmation)) {
    throw new DatasetError('Confirming personal data before Company certification needs a reason — say why it is accepted (it is recorded in the audit log).', 400, { code: 'personal_data_reason_required', field: 'personalData.reason' });
  }
  const confirmed = validConfirmation(confirmation);
  const record = (outcome: CertificationPersonalData['outcome']): CertificationPersonalData => ({
    rule,
    outcome,
    ...(check.unprotected.length ? { unprotected: check.unprotected } : {}),
    ...(!check.classified ? { unclassified: true } : {}),
    ...(outcome === 'confirmed' ? { reason: confirmation!.reason.trim() } : {}),
  });
  if (check.unprotected.length > 0) {
    const list = check.unprotected.join(', ');
    if (rule === 'block') {
      throw new PersonalDataGateError(
        `Certification to Company refused — personal-data column(s) not masked or hidden for other domains: ${list}. ${FIX_UNPROTECTED}`,
        'personal_data_unprotected',
        { ...check, rule, fix: FIX_UNPROTECTED },
      );
    }
    if (!confirmed) {
      throw new PersonalDataGateError(
        `Certification to Company needs your confirmation — personal-data column(s) not masked or hidden for other domains: ${list}. Every domain will read them in clear. Confirm with a reason that this is accepted, or: ${FIX_UNPROTECTED}`,
        'personal_data_confirmation_required',
        { ...check, rule, fix: FIX_UNPROTECTED },
      );
    }
    return record('confirmed');
  }
  if (!check.classified) {
    if (!confirmed) {
      const which = check.unclassifiedColumns.length ? ` (not classified: ${check.unclassifiedColumns.join(', ')})` : ' (no columns are documented)';
      throw new PersonalDataGateError(
        `Certification to Company needs a personal-data classification${which}. ${FIX_UNCLASSIFIED}`,
        rule === 'block' ? 'personal_data_unclassified' : 'personal_data_confirmation_required',
        { ...check, rule, fix: FIX_UNCLASSIFIED },
      );
    }
    return record('confirmed');
  }
  return record('passed');
}

/** Read a confirmation from an untrusted body/args shape (`{confirmed, reason}`), or undefined. */
export function parsePersonalDataConfirmation(v: unknown): PersonalDataConfirmation | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.confirmed !== true) return undefined;
  return { confirmed: true, reason: typeof o.reason === 'string' ? o.reason : '' };
}
