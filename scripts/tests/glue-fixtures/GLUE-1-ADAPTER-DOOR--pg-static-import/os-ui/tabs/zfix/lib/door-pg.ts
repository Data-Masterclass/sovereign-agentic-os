// Negative twin for GLUE-1: a static `pg` import outside core/adapters (dependency-cruiser edge).
import pg from 'pg';
export const driver = pg;
