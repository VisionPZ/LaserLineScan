#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Zero-dependency static server for the standalone laser-line-scan package.
// `node serve.mjs` -> http://localhost:8080 (override with PORT / --port).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const argPort = process.argv.indexOf('--port');
const requested = argPort >= 0 ? process.argv[argPort + 1] : process.env.PORT || 8080;
const port = Number(requested);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Not a port number: ${requested}`);
  process.exit(1);
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gz': 'application/gzip' };

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
});
server.listen(port, () => {
  // `--port 0` lets the OS choose; report the port that was actually bound.
  const bound = server.address().port;
  console.log(`laser-line-scan serving ${root}\n  http://localhost:${bound}`);
});
