# Decisions

1. Next.js standalone output, port 8080: what the platform Dockerfile and probes expect.
2. All OS access goes through `src/lib/os`: one place to review, one place the policy allows.
3. The review limit for `classify_order` is a constant (`REVIEW_LIMIT`); change it with its test.
