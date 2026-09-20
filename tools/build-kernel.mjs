#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
/**
 * Rebuild the WebAssembly kernel from `kernel/oss.ts`.
 *
 * The compiled `runtime/core.wasm` is committed, so this is only needed after
 * changing the kernel source: `npm install && npm run build:kernel`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'kernel', 'oss.ts');
const out = join(packageRoot, 'runtime', 'core.wasm');
const asc = join(packageRoot, 'node_modules', '.bin', 'asc');

if (!existsSync(source)) {
  console.error('kernel/oss.ts is missing — this does not look like the laser-line-scan package.');
  process.exit(1);
}
if (!existsSync(asc)) {
  console.error('assemblyscript is not installed — run `npm install` first.');
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
execFileSync(asc, [source, '--outFile', out, '--optimize', '--runtime', 'stub', '--exportRuntime'], { stdio: 'inherit' });
console.log('Built runtime/core.wasm from kernel/oss.ts');
