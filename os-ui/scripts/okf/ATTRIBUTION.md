# Attribution — OKF reference validator

`validate.py` in this folder is copied **unmodified** from the Open Knowledge Format project:

- Source: https://github.com/open-knowledge-format/open-knowledge-format/blob/527e81aff55992be21507e97004286789126f88c/skills/okf-generate/scripts/validate.py
- Commit: `527e81aff55992be21507e97004286789126f88c` (git blob `22be8fd1626a73475a87cacda7e3fa280deaa2fe`, sha256 in `pin.json`)
- Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0 (header kept verbatim in the file).

It runs in CI only (`os-ui/tabs/knowledge/lib/git/okf-bundle.eject.test.ts`, job `artifacts-eject`),
inside the Python image named in `pin.json`. It is not part of any runtime image.
