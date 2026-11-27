# Identity and authorization: the OS decides

<!-- Owner: App Builder workstream E. Until E fills this page, the rules below are the v1 identity rules, unchanged. -->

- Identity is the signed-in user, delegated by the OS. Get it from `src/lib/os` (`asCaller`, `requireUser`).
- Do NOT write your own authorization: no role comparisons, no `isAdmin`, no JWT or cookie parsing, no allow-lists of
  users. The OS checks every SDK call (OPA); a refusal arrives as `Forbidden` and you pass it on.
- Background work as the app itself is not available until a domain admin approves an app identity.
