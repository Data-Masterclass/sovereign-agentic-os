// Negative twin for GLUE-5: a hand-rolled job queue next to pg-boss.
export const CLAIM_NEXT = 'SELECT id FROM zfix_jobs ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED';
