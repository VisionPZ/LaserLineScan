<!--
  SPDX-License-Identifier: GPL-3.0-or-later
  Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
-->

# Contributing to laser-line-scan

Thanks for helping improve laser-line-scan. The project is small, dependency-free and
browser-first, and the contribution process is meant to stay that way.

## Developer setup

You need **Node.js 20 or newer**. There is nothing to install:

```sh
git clone https://github.com/VisionPZ/LaserLineScan.git
cd laser-line-scan
node serve.mjs        # http://localhost:8080
npm test              # the Node test suite
```

The runtime is plain ES modules with no bundler and no framework, so a normal
contribution needs no build step. The compiled kernel `runtime/core.wasm` is
checked in. It is compiled from the AssemblyScript source
`assembly/laser/oss.ts` (in the upstream Nidvue source tree); if you change the
kernel, rebuild the wasm with:

```sh
npx --yes assemblyscript@0.28.20 asc assembly/laser/oss.ts \
  --outFile runtime/core.wasm --optimize --runtime stub --exportRuntime
```

The browser probe additionally needs Python, Playwright and Chromium — see
[Running the browser probe](#running-the-browser-probe).

## Coding conventions

These are the conventions the code already follows; match them.

- **ES modules only.** No bundler, no framework, no runtime build step.
  `import`/`export` everywhere; `package.json` sets `"type": "module"`.
- **No third-party runtime dependencies.** The runtime must stay
  dependency-free. Add a dependency only after discussion in an issue, and keep
  the browser payload small. (The already-vendored libraries under
  `runtime/vendor/` are the only exceptions.)
- **Comments explain _why_, not _what_.** The code says what it does; a comment
  says why a choice was made, what invariant it protects, or what a reader would
  otherwise get wrong. Do not restate the next line.
- **Match the surrounding style.** Two-space indent, single quotes in JS,
  trailing commas where the file already uses them, descriptive names.
- **Keep it open.** Every runtime module ships under GPL-3.0-or-later; do not add
  anything that cannot be published under that licence.
- **No secrets or private data.** Never commit credentials, capture data with
  personal content, or machine-specific absolute paths.

### Licence headers

Every new source file must start with the SPDX header, including `.mjs`, `.js`,
`.py`, `.yml` and `.md` files (in a comment):

```text
SPDX-License-Identifier: GPL-3.0-or-later
Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
```

Keep the header on files you edit. CI enforces that every
`SPDX-License-Identifier` in the repository is `GPL-3.0-or-later`; `LICENSE` and
`NOTICE` are exempt because they carry the full texts instead.

## Tests are expected

A change that touches behaviour should come with tests:

- **Unit tests** live in `tests/unit/` and cover the kernel, extraction,
  calibration maths, the spectral model and the worker protocol.
- **Static integration tests** sit directly in `tests/` and cover the packaged
  project without a browser.

Run the relevant checks locally before opening a pull request. A pull request
that changes behaviour without a test, or that reports a test run it did not
actually do, will be sent back. A regression fix must include a test that fails
before the fix.

```sh
# Unit tests only.
node --test tests/unit/

# The whole Node suite (unit + static integration): this is `npm test`.
node --test tests/
```

## Running the browser probe

The end-to-end probe `tests/smoke.py` starts `serve.mjs` itself, drives the
wizard (optics → rig → calibration → scan) and asserts that the packaged demo
produces a real point cloud. It needs Python, the Playwright package and a
Chromium binary:

```sh
pip install playwright
playwright install --with-deps chromium
NIDVUE_CHROMIUM="$(python -c 'from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()')" \
  python tests/smoke.py
```

`NIDVUE_CHROMIUM` must point at the Chromium executable; `LASER_SCAN_PORT`
optionally selects the port. Run it from the repository root.

## Commit sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
Every commit must be signed off, certifying that you wrote the change or
otherwise have the right to submit it under the project licence. Add the line by
committing with `-s`:

```sh
git commit -s -m "laser: fix the stripe threshold on the mono path"
```

which appends:

```text
Signed-off-by: Your Name <you@example.com>
```

## Pull requests

Keep each pull request focused on one change; explain the problem and the
approach, and link the issue it addresses. Before opening one, confirm:

- [ ] The change is focused and does not bundle unrelated work.
- [ ] **Tests added or updated** for the behaviour I changed (a bug fix includes
      a test that fails before the fix).
- [ ] **Licence headers kept** on every file I touched, and a new SPDX header on
      every new file.
- [ ] **Attribution preserved**: the notice
      `Laser Line Scan, Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>` remains
      in the UI, documentation and sources as the project licence requires.
- [ ] No secrets, credentials or private capture data are included.
- [ ] Documentation affected by the change has been updated.
- [ ] The runtime stays browser-only and dependency-free.
- [ ] My commits are signed off (DCO).

The pull-request template repeats this checklist.

## Licence of contributions

By contributing you agree that your contribution is licensed under the project
licence: **GPL-3.0-or-later** plus the additional attribution term under GPLv3
section 7(b) described in [`NOTICE`](NOTICE). In short, anyone distributing a
product built from laser-line-scan must open source that product under the same
licence and preserve the attribution:

> **Laser Line Scan, Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>**

Do not add a different licence header to a file you did not write, and do not
relicense third-party code. The authoritative licence text is in
[`LICENSE`](LICENSE).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
