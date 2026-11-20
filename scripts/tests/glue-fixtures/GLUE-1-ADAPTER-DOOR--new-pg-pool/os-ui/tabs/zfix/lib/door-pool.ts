// Negative twin for GLUE-1: `new pg.Pool(` — a database client opened outside core/adapters.
import pg from 'pg';
export const pool = new pg.Pool({ max: 1 });
