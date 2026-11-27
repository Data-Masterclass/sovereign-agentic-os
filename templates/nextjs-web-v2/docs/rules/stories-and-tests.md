# Stories and tests

<!-- Owner: App Builder workstream B. -->

Your app's requirements live in `stories/` (one file per epic and per user story, ids assigned by the OS). They steer
the code; the code never steers them.

## Every acceptance criterion has a tagged test

- Each criterion (`### AC-n` with Given/When/Then) needs at least one automated test whose **name** carries its id in
  brackets: `test('[US-3/AC-2] empty order is refused', …)`. Several ids in one name are allowed.
- Tests live under `tests/` and run with `node --test`. The OS writes `tests/criteria/US-<n>.test.ts` with one failing
  test per criterion when a story is agreed; replace each failing body with a real test and keep the tag.
- After every run each story shows a light: **green** (every criterion has a passing tagged test), **partly tested**
  (some covered, or a tagged test fails), **untested** (no tagged test). A story is *built* only when it is green in a
  green run, and *verified* when that run is the one running in Dev. Nobody sets these by hand.

## Test first, then code, always for an agreed story

- Write the failing test first, then the code. A bug fix starts with a test that reproduces it.
- Code changes only for a story that is `agreed` and has no open diff card. The OS's write tools refuse anything else.
- Name the story in every commit: a `Story: US-3` trailer or `[US-3]` in the message. A push that changes code without
  one is a **change without a story**: it is not rejected, but it opens a card someone must approve, and going live in
  the domain or the company waits until then.
- Changing a story file from your editor works the same way: the push is accepted and becomes a card to approve.

## The usual test rules still hold

- Every route file under `src/app/api` is imported by at least one test, and every function in `src/lib` has a test
  of its rule, including the failing input.
- Tests use injected `fetch`, never the network and never a real OS.
