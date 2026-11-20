// Negative twin for GLUE-4 (WP-05): an adapter that answers a typed-in version instead of the
// one the component reports. Adapters are not exempt from the rule.
import type { Fetched } from '../_contract';
export async function opensearchHealth(): Promise<Fetched<{ version: string }>> {
  return { ok: true, value: { version: '3.7.0' } };
}
