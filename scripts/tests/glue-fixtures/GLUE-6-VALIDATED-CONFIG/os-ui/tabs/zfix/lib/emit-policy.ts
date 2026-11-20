// Negative twin for GLUE-6: a native-config generator with no golden fixture run through `opa check`.
export function generatePolicy(domain: string): Record<string, string> {
  return { 'policy/zfix.rego': `package zfix.${domain}\n` };
}
