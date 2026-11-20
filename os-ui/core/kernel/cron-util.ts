/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE cron helpers with NO server-only dependencies — safe to import from a
 * client component or a client-imported module. `schedule-cron.ts` (which drags in
 * the in-cluster k8s client via `lib/infra/k8s.ts`) re-exports `isValidCron` from
 * here for back-compat, so the browser bundle never pulls `node:fs`/`node:https`.
 *
 * ONE strict grammar for every cron the OS stores (dataset syncs, agent schedules): a cron is
 * written verbatim into generated files (`os/schedules.yml`, a model header comment) and into
 * Kubernetes CronJobs, so it is held to the closed 5-field grammar below — never to "5 non-empty
 * fields", which admitted any character.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
type CronField = { min: number; max: number; names?: string[]; offset?: number };
const FIELDS: CronField[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS, offset: 1 },
  { min: 0, max: 7, names: DAYS, offset: 0 },
];

function value(tok: string, f: CronField): number | null {
  if (/^\d{1,2}$/.test(tok)) {
    const n = Number(tok);
    return n >= f.min && n <= f.max ? n : null;
  }
  const i = f.names ? f.names.indexOf(tok.toUpperCase()) : -1;
  return i < 0 ? null : i + (f.offset ?? 0);
}

function validField(field: string, f: CronField): boolean {
  return field.split(',').every((item) => {
    const m = /^(\*|[0-9A-Za-z]{1,3}(?:-[0-9A-Za-z]{1,3})?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!m) return false;
    if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > f.max + 1)) return false;
    if (m[1] === '*') return true;
    const [a, b] = m[1].split('-');
    const lo = value(a, f);
    if (lo === null) return false;
    if (b === undefined) return m[2] === undefined; // `5/10` is not standard cron
    const hi = value(b, f);
    return hi !== null && lo <= hi;
  });
}

/**
 * The strict 5-field cron grammar: minute hour day-of-month month day-of-week, separated by single
 * spaces. Each field is `*`, `*` + `/n`, a value, a range `a-b`, `a-b/n`, or a comma list of those,
 * with every value inside its field's range; month and weekday also take 3-letter names. Nothing
 * else: no `@daily`, no `?`, no `L` / `W` / `#`, no other character.
 */
export function isValidCron(cron: string | undefined): cron is string {
  if (!cron || typeof cron !== 'string' || cron.length > 100) return false;
  const fields = cron.split(' ');
  return fields.length === 5 && fields.every((field, i) => validField(field, FIELDS[i]));
}
