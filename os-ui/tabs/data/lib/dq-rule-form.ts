/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The quality-rule editor's pure logic — labels, per-rule fields, the add payload
 * USER STORY: As a dataset owner I want the "Add a custom check" row to show exactly the fields
 *             the rule I picked needs, and to refuse to submit a half-filled one, without that
 *             decision living inside a 2 000-line component.
 * ARCHITECTURE:
 *   - PURE and `.ts`, so the rule matrix is unit-tested directly: `DataBuilder.tsx` renders what
 *     `fieldsFor` says and submits what `addPayload` returns, and a `.test.ts` may import this
 *     (a test may not import a `.tsx`).
 *   - It mirrors `DATA_CHECK_RULES`; `ALL_RULE_KINDS` is asserted against the schema's list in the
 *     test, so a rule added to the model without a form field fails there rather than silently
 *     missing from the editor.
 */
import type { DataCheckRule } from '@tabs/data/lib/dataset-schema';

export const RULE_LABELS: Record<DataCheckRule, string> = {
  not_null: 'Not null',
  not_blank: 'Not blank',
  unique: 'Unique',
  accepted_values: 'Accepted values',
  range: 'In range',
  reference: 'References another dataset',
};

/** Which extra inputs the editor shows for a rule (beyond the column picker every rule has). */
export type RuleField = 'values' | 'min' | 'max' | 'toDataset' | 'toColumn';

export function fieldsFor(rule: DataCheckRule): RuleField[] {
  switch (rule) {
    case 'accepted_values': return ['values'];
    case 'range': return ['min', 'max'];
    case 'reference': return ['toDataset', 'toColumn'];
    default: return [];
  }
}

/** The raw strings the editor holds. Everything is a string: it comes from inputs. */
export type RuleDraft = {
  column: string;
  /** `accepted_values`: comma-separated. */
  values: string;
  min: string;
  max: string;
  /** `reference`: the referenced dataset id and column. */
  toDataset: string;
  toColumn: string;
};

export type RuleExtra = { values?: string[]; min?: number; max?: number; toDataset?: string; toColumn?: string };

/** The extra arguments for `POST /checks`, built from the draft for THIS rule only. */
export function addPayload(rule: DataCheckRule, draft: RuleDraft): RuleExtra {
  const extra: RuleExtra = {};
  if (rule === 'accepted_values') {
    extra.values = draft.values.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (rule === 'range') {
    if (draft.min.trim() !== '') extra.min = Number(draft.min);
    if (draft.max.trim() !== '') extra.max = Number(draft.max);
  }
  if (rule === 'reference') {
    extra.toDataset = draft.toDataset.trim();
    extra.toColumn = draft.toColumn.trim();
  }
  return extra;
}

/**
 * May "Add check" be pressed? Every rule needs a column; `reference` needs both halves of its
 * target, because a half-filled one would be refused by the server with a 400 the user did not
 * need to see. `accepted_values` and `range` deliberately stay submittable with empty args: the
 * server's message for those is specific and worth showing.
 */
export function canSubmit(rule: DataCheckRule, draft: RuleDraft): boolean {
  if (!draft.column.trim()) return false;
  if (rule === 'reference') return draft.toDataset.trim().length > 0 && draft.toColumn.trim().length > 0;
  return true;
}

/** The dbt-style label the editor shows for a STORED rule. Mirrors `ruleLabel` in `dq.ts`. */
export function ruleText(c: { rule?: DataCheckRule; column?: string; values?: string[]; min?: number; max?: number; toDataset?: string; toColumn?: string; name?: string }): string {
  const col = c.column ?? '';
  switch (c.rule) {
    case 'not_null': return `not_null(${col})`;
    case 'not_blank': return `not_blank(${col})`;
    case 'unique': return `unique(${col})`;
    case 'accepted_values': return `accepted_values(${col}, [${(c.values ?? []).join(', ')}])`;
    case 'range': return `range(${col}, ${c.min ?? ''}, ${c.max ?? ''})`;
    case 'reference': return `reference(${col} -> ${c.toDataset ?? '?'}.${c.toColumn ?? '?'})`;
    default: return c.name || 'check';
  }
}
