// Negative twin for GLUE-1: an `undici` import outside core/adapters (resolvable or not).
import { request } from 'undici';
export const call = request;
