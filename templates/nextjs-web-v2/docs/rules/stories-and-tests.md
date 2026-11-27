# Stories and tests

<!-- Owner: App Builder workstream B. Until B fills this page, the rules below are the v1 test rules, unchanged. -->

- Every route file under `src/app/api` is imported by at least one test, and every function in `src/lib` has a test
  of its rule, including the failing input.
- Write the failing test first, then the code. A bug fix starts with a test that reproduces it.
- Tests use injected `fetch`, never the network and never a real OS.
