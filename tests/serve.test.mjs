// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Integration test for the packaged static server (`serve.mjs`). Boots the
 * real server as a child process on a free port and asserts, over raw HTTP:
 * the prebuilt page is served with the right MIME types, missing paths are
 * 404, and path-traversal attempts never leak file contents. The child is
 * always killed in a `finally`, and every wait has a timeout so CI cannot
 * hang; if no port can be bound the suite skips cleanly with a reason.
 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_MARKER = 'laser-line-scan serving';
const STARTUP_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;
const SUITE_TIMEOUT_MS = 60000;

// Bind an ephemeral port, remember it, then release it so `serve.mjs` can use
// it. `--port 0` is supported by the server but the readiness line prints the
// literal 0, so an explicit free port is the only reliable way to learn it.
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, ['serve.mjs', '--port', String(port)], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveStart, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve.mjs did not print "${READY_MARKER}" within ${STARTUP_TIMEOUT_MS}ms: ${output}`));
    }, STARTUP_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(READY_MARKER)) {
        clearTimeout(timer);
        resolveStart(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (!output.includes(READY_MARKER)) {
        clearTimeout(timer);
        reject(new Error(`serve.mjs exited with code ${code}: ${output}`));
      }
    });
  });
}

// Use a raw request so the client never normalises `..` out of the path: the
// traversal must reach the server exactly as an attacker would send it.
function httpGet(port, path) {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`HTTP request timed out: ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, 5000);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

test('serve.mjs serves the package over HTTP and refuses traversal', { timeout: SUITE_TIMEOUT_MS }, async (t) => {
  let port;
  try {
    port = await freePort();
  } catch (err) {
    t.skip(`cannot bind a free port on 127.0.0.1: ${err.message}`);
    return;
  }

  let child;
  try {
    try {
      child = await startServer(port);
    } catch (err) {
      // A busy or privileged port is an environment problem, not a server
      // defect: skip with the reason instead of failing the suite.
      if (/EADDRINUSE|EACCES|EPERM/i.test(err.message)) {
        t.skip(`cannot bind port ${port}: ${err.message}`);
        return;
      }
      throw err;
    }

    await t.test('GET / returns the prebuilt page', async () => {
      const res = await httpGet(port, '/');
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type']), /^text\/html/, `content-type was ${res.headers['content-type']}`);
      const body = res.body.toString('utf8');
      assert.ok(body.includes('id="ll-copy"'), 'prebuilt page marker id="ll-copy" missing');
      assert.ok(body.length > 1000, `prebuilt page looks empty (${body.length} bytes)`);
    });

    await t.test('.wasm is served as application/wasm', async () => {
      const res = await httpGet(port, '/runtime/core.wasm');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/wasm');
      assert.ok(res.body.length > 0, 'core.wasm body is empty');
    });

    await t.test('.js and .mjs are served with a JavaScript MIME type', async () => {
      for (const path of ['/runtime/app.js', '/serve.mjs', '/runtime/worker.js']) {
        const res = await httpGet(port, path);
        assert.equal(res.status, 200, `${path} was ${res.status}`);
        assert.match(String(res.headers['content-type']), /^text\/javascript/, `${path} content-type was ${res.headers['content-type']}`);
      }
    });

    await t.test('a demo .jpg is served as image/jpeg', async () => {
      const res = await httpGet(port, '/demo/calibration/charuco-fixed-board/calibration-000.jpg');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/jpeg');
      assert.ok(res.body.length > 0, 'demo jpeg body is empty');
    });

    await t.test('a missing path is 404', async () => {
      const res = await httpGet(port, '/definitely-not-a-real-file.jpg');
      assert.equal(res.status, 404);
    });

    await t.test('path traversal is refused without leaking contents', async () => {
      const attempts = ['/../../etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2f..%2fetc%2fpasswd'];
      for (const attempt of attempts) {
        const res = await httpGet(port, attempt);
        assert.equal(res.status, 404, `${attempt} returned ${res.status}`);
        const body = res.body.toString('utf8');
        assert.ok(!/^root:/m.test(body), `${attempt} leaked /etc/passwd`);
        assert.ok(!body.includes('root:x:0:0'), `${attempt} leaked /etc/passwd`);
      }
    });
  } finally {
    await stopServer(child);
  }
});
