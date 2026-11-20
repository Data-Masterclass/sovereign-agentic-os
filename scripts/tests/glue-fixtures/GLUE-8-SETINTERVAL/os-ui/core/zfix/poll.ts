// Negative twin for GLUE-8: a private poll loop instead of the reconciler runtime.
export function startPolling(tick: () => void): void {
  setInterval(tick, 30_000);
}
