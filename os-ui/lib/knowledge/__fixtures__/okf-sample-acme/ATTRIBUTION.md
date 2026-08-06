# OKF sample fixture — vendored verbatim

These `.md` files are copied VERBATIM from Google's OKF reference repository:

- Source: https://github.com/GoogleCloudPlatform/knowledge-catalog → `okf/bundles/acme_retail/`
- License: Apache-2.0 (SPDX-verified). Copyright Google LLC.
- Vendored: 2026-08-05, as an OKF v0.2 conformance import fixture.

They are used ONLY as a test fixture proving that a real Google-authored OKF
bundle imports successfully into the Sovereign Agentic OS Knowledge tab. The
Apache-2.0 license permits redistribution with attribution; this file is that
attribution. Do NOT edit the vendored `.md` files — the point of the fixture is
that they are byte-for-byte the upstream sample.

Subset vendored (a small, self-contained slice with a cross-link, `verified`
events, `sources`, and types outside our own vocabulary — `Metric`, `Policy` —
to exercise the "unknown type is accepted" spec rule):

- `index.md`, `metrics/index.md`, `metrics/revenue.md`
- `policies/index.md`, `policies/revenue-recognition.md`
