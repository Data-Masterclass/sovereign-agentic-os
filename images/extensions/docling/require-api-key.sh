#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Refuse to start docling-serve without an API key. Upstream treats an EMPTY
# DOCLING_SERVE_API_KEY as "no authentication" (docling_serve/auth.py), so an empty value —
# e.g. an ExternalSecret whose `apiKey` came back blank — would serve every route openly.
# This wrapper fails closed instead, then hands over to the image's own entrypoint.
key=$(printf '%s' "${DOCLING_SERVE_API_KEY:-}" | tr -d '[:space:]')
if [ -z "$key" ]; then
  echo "DOCLING_API_KEY_MISSING: DOCLING_SERVE_API_KEY is empty or unset; refusing to start an unauthenticated docling-serve." >&2
  exit 64
fi
exec "$@"
