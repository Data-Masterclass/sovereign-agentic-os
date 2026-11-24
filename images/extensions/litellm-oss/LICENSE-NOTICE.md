<!-- SPDX-License-Identifier: Apache-2.0 -->
# litellm-oss image — licence notice

This image contains **LiteLLM 1.109.1** (https://github.com/BerriAI/litellm), installed unmodified
from PyPI. LiteLLM outside its `enterprise/` directory is MIT-licensed:

> MIT License — Copyright (c) 2023 Berri AI
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The full text ships with the package: `/app/.venv/lib/python3.13/site-packages/litellm-1.109.1.dist-info/licenses/LICENSE`.

**Not included:** the proprietary `litellm-enterprise` package (LicenseRef-Proprietary) and the
upstream `enterprise/` directory. Nothing in this image is derived from them.

Every other Python distribution keeps its own licence file in its `*.dist-info/` directory; the
Prisma CLI and engines (Apache-2.0) keep theirs under `/opt/prisma/binaries/node_modules/`;
Node.js's licence is at `/usr/share/licenses/nodejs/LICENSE`. The licence of every installed package
is checked on the built image by `scripts/license-gate-image.mjs` in the Sovereign Agentic OS repository.
