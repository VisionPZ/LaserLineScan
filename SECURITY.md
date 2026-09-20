<!--
  SPDX-License-Identifier: GPL-3.0-or-later
-->

# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to
[ping.zhao@nidvue.com](mailto:ping.zhao@nidvue.com). Do not open a public issue
for a suspected vulnerability.

Please include, where you can:

- a description of the issue and its impact;
- the affected file(s), version or commit;
- a minimal reproduction (input frames, dataset, commands or a short script);
- any suggested fix or mitigation.

You will receive an **acknowledgement within 7 days**. After the report is
triaged we will agree on a disclosure timeline with you; we aim to publish a
fix and an advisory once a remediation is available and users have had a
reasonable time to update.

## Scope

laser-line-scan runs entirely client-side. The security surface is therefore small:

- **Browser memory safety of the WebAssembly kernel.** The kernel reads image
  bytes and writes stripe positions and point clouds through linear memory.
  Out-of-bounds reads/writes, integer overflows in width/height/stride handling
  and unbounded allocations are in scope.
- **Worker message validation.** Data crosses the main-thread/worker boundary as
  structured messages (typed arrays, config objects, dataset manifests).
  Messages that are malformed, oversized or crafted to confuse the protocol are
  in scope.
- **No data leaves the machine.** laser-line-scan performs no upload and no
  telemetry. Any code path that transmits capture data, calibration data or
  point clouds off the device is a security bug — report it.

Out of scope unless they demonstrate one of the above:

- vulnerabilities in third-party browsers;
- issues that require an already-compromised browser or operating system;
- vulnerabilities in any Nidvue software other than laser-line-scan.

## Supported versions

The latest `1.x` release receives security fixes. The project is at version
1.0.0; please state the commit you tested when reporting.

## Licence

This project is licensed under **GPL-3.0-or-later** plus an additional
attribution term under GPLv3 section 7(b); see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).
