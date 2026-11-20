// Negative twin for GLUE-1: a component module reached through a template-string dynamic import.
const mod = 'child_process';
export const spawnIt = () => import(`node:${mod}`);
