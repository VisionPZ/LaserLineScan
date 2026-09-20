<!--
  SPDX-License-Identifier: GPL-3.0-or-later
-->

# Commercial use of laser-line-scan

This page explains, in plain language, what the licence means for a business.
It is not a substitute for the licence itself: the authoritative text is
[`LICENSE`](../LICENSE), and the additional attribution term is stated in
[`NOTICE`](../NOTICE). If anything here conflicts with those files, those files
win.

## The short version

- **You may use laser-line-scan commercially.** There is no non-commercial
  restriction.
- **If you distribute a product that contains or is derived from laser-line-scan, you
  must publish that product's complete corresponding source under
  GPL-3.0-or-later**, and keep the attribution visible.
- **If you cannot meet those terms, you cannot distribute a product based on
  laser-line-scan.** The project is single-licensed and has no separate component
  to license around.

laser-line-scan is **GPL-3.0-or-later** plus an **additional attribution term** under
GPLv3 **section 7(b)** — the mechanism the GPL provides for a licensor to add a
specific attribution requirement on top of the standard terms. The project is
*not* MIT or Apache-2.0. It cannot be relicensed, and the attribution term
cannot be dropped.

## What counts as "distributing"

The GPL's source-sharing obligation is triggered when you **convey** the software
to someone else — ship a desktop or device product, publish a download, or
deliver a web application whose JavaScript/WebAssembly is sent to visitors'
browsers. In all of those cases the recipient has received the program, and the
GPL requires you to offer them the complete corresponding source under the same
licence.

Using laser-line-scan privately, or as an internal tool on your own machines, does
not by itself trigger the obligation. Distributing modified versions to
customers, partners or the public does. Note that laser-line-scan is a browser
application: putting it on a public website sends its code to every visitor, so
that is conveying.

"Complete corresponding source" means the source for the whole work that
contains or links against laser-line-scan — not just laser-line-scan's own files — under
GPL-3.0-or-later, so your recipients can rebuild and modify the product.

## The attribution you must keep

Every distribution must preserve this notice in the product's user interface,
its documentation and its sources:

It is not enough to mention it in a legal file nobody reads: the additional term
requires it to be visible in the UI and the docs. A reasonable interpretation is
an "About", credits or licence screen that a user can reach.

## If you cannot release your source

There is no separate licence option and no separate component to license
around. laser-line-scan is single-licensed under GPL-3.0-or-later: every part of
the scanner — including the WebAssembly kernel, the calibration and the
reconstruction — is open, and the copyleft applies to all of it. A product
that contains or is derived from laser-line-scan must be distributed under
GPL-3.0-or-later, with the attribution kept.

If that does not fit your product, laser-line-scan is not the right component. The
project does not offer a dual licence that removes the source-sharing
obligation. If you have questions about what the licence requires, contact
[contact@nidvue.com](mailto:contact@nidvue.com).

## Worked examples

### 1. A university lab

A research group uses laser-line-scan to scan specimens and analyse the point clouds.
They modify a few modules for their materials and run everything on lab machines.

- **Using it internally**: no obligation. The GPL does not require them to
  publish anything for private use.
- **Sharing the modified tool with another lab**, or posting it as a download:
  that is distribution. They must make their modified source available under
  GPL-3.0-or-later and keep the attribution notice.
- **Publishing a paper** that merely cites the tool: no source obligation beyond
  normal citation. They should cite it (see [`CITATION.cff`](../CITATION.cff)).

### 2. An open-source hobby project

A maker builds a scanner and publishes their project on GitHub, choosing
GPL-3.0-or-later.

- **No problem at all.** Their project is already under the same licence, so the
  copyleft condition is satisfied.
- They must keep the attribution notice visible in the project's README/UI (for
  example a credits section), and keep the `SPDX-License-Identifier` headers on
  the laser-line-scan files they reuse.
- If they improve the shared code, their improvements reach the community under
  the same licence.

### 3. A commercial scanner that ships its source

A company sells a commercial scanning product that embeds laser-line-scan (or a
modified version) into a shipping application. It accepts the copyleft.

- **Shipping the product is distribution, so the company releases the complete
  corresponding source of its product under GPL-3.0-or-later** and keeps the
  attribution visible in the UI and docs. The hardware, the pricing and the
  branded experience can all stay commercial; only the software's
  corresponding source must be offered under the same licence.
- Selling the product and charging for it are allowed. So is keeping the
  physical hardware closed — the licence governs the software, not the device.
- A company that wants to ship the software without releasing its source cannot
  use laser-line-scan. There is no separate component to license around and no
  exception that removes the obligation; using the code that way is a licence
  violation, and GPL-3.0-or-later terminates automatically on breach.

## Questions

Licensing questions: [contact@nidvue.com](mailto:contact@nidvue.com).
Security reports: see
[`SECURITY.md`](../SECURITY.md). Contributions: see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
