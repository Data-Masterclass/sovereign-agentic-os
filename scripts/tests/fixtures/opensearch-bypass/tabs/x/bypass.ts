// Fixture for scripts/tests/check-opensearch-client.test.sh: a caller that builds its own
// OpenSearch request instead of using core/adapters/opensearch/client.ts. The check MUST fail.
export async function bypass(): Promise<Response> {
  return fetch(`${process.env.OPENSEARCH_URL}/files/_search`, { method: 'POST' });
}
