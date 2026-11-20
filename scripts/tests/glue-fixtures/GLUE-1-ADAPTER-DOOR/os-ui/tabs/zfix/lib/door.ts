// Negative twin for GLUE-1: a tab talking to a component directly instead of through core/adapters.
export async function trinoInfo(): Promise<unknown> {
  const res = await fetch('http://trino:8080/v1/info');
  return res.json();
}
