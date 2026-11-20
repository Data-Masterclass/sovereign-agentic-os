// Fixture: the client itself may read OPENSEARCH_URL.
export const url = () => process.env.OPENSEARCH_URL ?? 'http://opensearch:9200';
