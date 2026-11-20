// Negative twin for GLUE-3: a failure turned into a success-shaped value.
export function datasets(raw: string): unknown[] {
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    return [];
  }
}
