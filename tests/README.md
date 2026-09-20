<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Tests

The package has three layers of tests. The first two run on Node alone with no
dependencies; the third needs a browser.

| Layer | Location | Runner |
| --- | --- | --- |
| Unit tests | `tests/unit/**` | `node --test` |
| Static integration | `tests/standalone.test.mjs`, `tests/serve.test.mjs`, `tests/integration/**` | `node --test` |
| Browser probe | `tests/smoke.py` | Python + Playwright + Chromium |

The project's test command discovers everything under `tests/`, including
subdirectories:

```bash
cd open-source/laser-line-scan
node --test tests/   # or: npm test
```

## Unit tests

`tests/unit/**` exercises the shipped WebAssembly kernel and the runtime
modules directly, without a browser. Run just this layer with:

```bash
node --test tests/unit/
```

Only Node.js is required (the package declares `engines.node >= 20`).

## Static integration tests

These boot the real `serve.mjs` and inspect the shipped demo dataset over HTTP
and on disk:

- `tests/standalone.test.mjs` — manifests only promise shipped files and
  `index.html` only references shipped assets.
- `tests/serve.test.mjs` — starts `serve.mjs` as a child process on a free port
  and checks the prebuilt page, MIME types (`.wasm`, `.js`/`.mjs`, `.jpg`),
  404s and path-traversal refusal. If no port can be bound the suite skips with
  a reason instead of failing or hanging.
- `tests/integration/demo-data.test.mjs` — every `demo/**/manifest.json`, every
  frame on disk, truth volumes, previews, frame counts and the dataset ids the
  page offers.

Run just this layer with:

```bash
node --test tests/standalone.test.mjs tests/serve.test.mjs tests/integration/
```

Only Node.js is required.

## Browser probe

`tests/smoke.py` boots `serve.mjs`, drives the wizard (optics → rig →
calibration), runs a calibration and a validation scan at full speed, asserts
the reconstructed point count, exports the PLY and checks it is non-empty, and
fails on any page error, console error or HTTP response `>= 400`. The
screenshot is written to `/tmp/standalone-smoke.png`.

The package ships no favicon, so a plain browser logs one `404` console error
for its automatic `/favicon.ico` request. The probe stubs that request (204) so
its zero-console-error assertion measures the scanner rather than a missing
browser icon; other `404`s still surface as responses and console errors.

Requirements:

- Python 3.9+ with the `playwright` package (`pip install playwright`). The
  repository's shared virtualenv lives at `.venv/`.
- A Chromium build. Install Playwright's with
  `python -m playwright install chromium`, or point `NIDVUE_CHROMIUM` at an
  existing executable.

Run it from the repository root:

```bash
NIDVUE_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  /home/pingz/Code/Nidvue/Websites/Source/.venv/bin/python \
  open-source/laser-line-scan/tests/smoke.py
```

Environment variables:

- `NIDVUE_CHROMIUM` — absolute path to the Chromium executable. When unset,
  Playwright uses its own bundled browser.
- `LASER_SCAN_PORT` — port for the probe's static server; defaults to a free
  port.

A successful run ends with a `PASS: ...` line.
