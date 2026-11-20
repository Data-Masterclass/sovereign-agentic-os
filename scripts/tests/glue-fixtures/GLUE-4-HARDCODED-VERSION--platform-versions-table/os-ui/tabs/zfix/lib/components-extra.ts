// Negative twin for GLUE-4 (WP-05): the Platform page's old typed-in version table, which showed
// OpenSearch v2.17.1 while 3.7.0 ran. Reintroducing it must fail CI.
export const VERSIONS: Record<string, string> = { litellm: 'v1.55.3', langfuse: 'v3.22.0', opa: 'v0.70.0', opensearch: 'v2.17.1' };
