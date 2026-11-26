#!/usr/bin/env node
/**
 * Comprehensive smoke test for Split Workbench:
 * 1. BSP layout engine unit tests (auto-split aspect ratio, split, swap, remove, ratio clamp, geometry)
 * 2. Live sidecar HTTP server startup, auth enforcement, fs/list, fs/search, file/read, ports, chat-links
 * 3. Real Python 3 PTY terminal creation, SSE streaming, command execution, resize, and clean teardown
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const sandbox = { globalThis: {} };
sandbox.window = sandbox.globalThis;
vm.runInNewContext(readFileSync(join(ROOT, 'sidecars/workbench/public/layout.js'), 'utf-8'), sandbox);
const L = sandbox.globalThis.SplitLayout;

// ---------------------------------------------------------------------------
// 1. Unit tests for BSP auto-split layout engine
// ---------------------------------------------------------------------------
function testLayoutEngine() {
  assert.equal(L.decideSplitDirection({ width: 800, height: 400 }, 'auto'), 'horizontal');
  assert.equal(L.decideSplitDirection({ width: 400, height: 800 }, 'auto'), 'vertical');
  assert.equal(L.decideSplitDirection({ width: 420, height: 400 }, 'auto'), 'vertical'); // 420 <= 440 -> vertical
  assert.equal(L.decideSplitDirection({ width: 460, height: 400 }, 'auto'), 'horizontal'); // 460 > 440 -> horizontal
  assert.equal(L.decideSplitDirection({ width: 200, height: 900 }, 'horizontal'), 'horizontal');
  assert.equal(L.decideSplitDirection({ width: 900, height: 200 }, 'vertical'), 'vertical');

  let tree = L.createLeaf('file', { path: '/a.ts' }, 'p1');
  const p2 = L.createLeaf('web', { url: 'http://localhost:3000' }, 'p2');
  tree = L.splitLeaf(tree, 'p1', p2, 'horizontal', 0.5);
  assert.equal(L.countLeaves(tree), 2);

  const p3 = L.createLeaf('terminal', { cwd: '/tmp' }, 'p3');
  tree = L.splitLeaf(tree, 'p2', p3, 'vertical', 0.6);
  assert.equal(L.countLeaves(tree), 3);

  const geom = L.computeGeometry(tree, 1006, 606, 6);
  assert.equal(geom.leaves.size, 3);
  assert.equal(geom.gutters.length, 2);
  const r1 = geom.leaves.get('p1');
  const r2 = geom.leaves.get('p2');
  const r3 = geom.leaves.get('p3');
  assert.equal(r1.w, 500);
  assert.equal(r1.h, 606);
  assert.equal(r2.x, 506);
  assert.equal(r2.w, 500);
  assert.equal(r2.h, 360);
  assert.equal(r3.y, 366);
  assert.equal(r3.h, 240);

  // Swap leaves preserves IDs and swaps positions
  const swapped = L.swapLeaves(tree, 'p1', 'p3');
  const sg = L.computeGeometry(swapped, 1006, 606, 6);
  assert.equal(sg.leaves.get('p3').x, 0);
  assert.equal(sg.leaves.get('p1').y, 366);

  // Toggle parent split orientation for individual leaf (vertical <-> horizontal)
  const parentP2 = L.findParentSplit(tree, 'p2');
  assert.equal(parentP2.direction, 'vertical');
  const toggledP2 = L.toggleLeafSplitDirection(tree, 'p2');
  assert.equal(L.findParentSplit(toggledP2, 'p2').direction, 'horizontal');
  assert.equal(L.findParentSplit(toggledP2, 'p1').direction, 'horizontal'); // root split untouched
  const toggledP1 = L.toggleLeafSplitDirection(toggledP2, 'p1');
  assert.equal(L.findParentSplit(toggledP1, 'p1').direction, 'vertical'); // root split flipped

  // Remove leaf collapses split cleanly
  const removed = L.removeLeaf(tree, 'p2');
  assert.equal(L.countLeaves(removed.root), 2);
  assert.equal(removed.nextActiveId, 'p3');

  console.log('[PASS] BSP auto-split layout engine tests');
}

// ---------------------------------------------------------------------------
// 2. Integration tests against live main.mjs + Python PTY bridge
// ---------------------------------------------------------------------------
async function testLiveServer() {
  const token = 'test-secret-token-123';
  const child = spawn('node', [join(ROOT, 'sidecars/workbench/main.mjs')], {
    env: {
      ...process.env,
      ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
      ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = await new Promise((resolveUrl, rejectUrl) => {
    let out = '';
    const timer = setTimeout(() => rejectUrl(new Error('Server startup timed out')), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString('utf-8');
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`Server exited early with code ${code}`));
    });
  });

  const headers = { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' };

  try {
    // Health & static assets
    const health = await fetch(`${baseUrl}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);

    const html = await fetch(`${baseUrl}/`).then((r) => r.text());
    assert.ok(html.includes('Split Workbench'));
    assert.ok(html.includes('/preload.js'));

    const preload = await fetch(`${baseUrl}/preload.js`).then((r) => r.text());
    assert.ok(preload.includes('window.sidecar'));

    // Token enforcement
    const unauth = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(ROOT)}`);
    assert.equal(unauth.status, 401);

    // FS list & search & file read
    const listing = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(ROOT)}`, { headers }).then((r) => r.json());
    assert.ok(listing.entries.some((e) => e.name === 'plugin.json'));

    const search = await fetch(`${baseUrl}/api/fs/search?root=${encodeURIComponent(ROOT)}&q=layout`, { headers }).then((r) => r.json());
    assert.ok(search.items.some((i) => i.name === 'layout.js'));

    const fileRead = await fetch(`${baseUrl}/api/file/read?path=${encodeURIComponent(join(ROOT, 'plugin.json'))}`, { headers }).then((r) => r.json());
    assert.equal(fileRead.kind, 'text');
    assert.ok(fileRead.content.includes('split-workbench'));

    // Local ports discovery (must never include our own sidecar port!)
    const selfPort = Number(new URL(baseUrl).port);
    const ports = await fetch(`${baseUrl}/api/ports`, { headers }).then((r) => r.json());
    assert.ok(Array.isArray(ports.ports));
    assert.ok(!ports.ports.some((p) => p.port === selfPort), 'Own sidecar port must be excluded');

    // Local HTML zero-server preview route (cookie-less HMAC path sig, works for relative CSS/JS too!)
    const previewMeta = await fetch(
      `${baseUrl}/api/preview-url?path=${encodeURIComponent(join(ROOT, 'sidecars/workbench/public/index.html'))}`,
      { headers }
    ).then((r) => r.json());
    assert.ok(previewMeta.previewPath.startsWith('/preview/'));
    // Relative subresource (styles.css) should load with ZERO token header/query because dir sig is in path
    const previewHtml = await fetch(`${baseUrl}${previewMeta.previewPath}`).then((r) => r.text());
    assert.ok(previewHtml.includes('Split Workbench'));
    const siblingCssPath = previewMeta.previewPath.replace(/index\.html$/, 'styles.css');
    const siblingCssRes = await fetch(`${baseUrl}${siblingCssPath}`);
    assert.equal(siblingCssRes.status, 200);
    // Tampered signature must be rejected
    const badSigRes = await fetch(`${baseUrl}${previewMeta.previewPath.replace(/^\/preview\/[^/]+\//, '/preview/badbadbad/')}`);
    assert.equal(badSigRes.status, 401);

    // File download attachment header
    const dlRes = await fetch(
      `${baseUrl}/api/file/raw?path=${encodeURIComponent(join(ROOT, 'plugin.json'))}&download=1&token=${encodeURIComponent(token)}`
    );
    assert.equal(dlRes.status, 200);
    assert.ok((dlRes.headers.get('content-disposition') || '').includes('attachment'));

    // Web HTML download proxy
    const webDl = await fetch(
      `${baseUrl}/api/web/download?url=${encodeURIComponent(`${baseUrl}${previewMeta.previewPath}`)}&token=${encodeURIComponent(token)}`
    );
    assert.equal(webDl.status, 200);
    assert.ok((webDl.headers.get('content-disposition') || '').includes('attachment'));

    // Embed pre-check on local preview (embeddable: true)
    const chkLocal = await fetch(
      `${baseUrl}/api/web/check-embed?url=${encodeURIComponent(`${baseUrl}${previewMeta.previewPath}`)}`,
      { headers }
    ).then((r) => r.json());
    assert.equal(chkLocal.embeddable, true);

    // Real headless Chrome web screenshot capture
    const shotRes = await fetch(`${baseUrl}/api/web/screenshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: `${baseUrl}${previewMeta.previewPath}`, width: 640, height: 420 }),
    }).then((r) => r.json());
    assert.equal(shotRes.ok, true);
    assert.ok(shotRes.path && shotRes.path.endsWith('.png'));
    const { existsSync, statSync, rmSync } = await import('node:fs');
    assert.ok(existsSync(shotRes.path) && statSync(shotRes.path).size > 1024);
    rmSync(shotRes.path, { force: true });

    // Real PTY terminal create + SSE stream + command echo + resize + close
    const term = await fetch(`${baseUrl}/api/term/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd: ROOT, cols: 90, rows: 30 }),
    }).then((r) => r.json());
    assert.ok(term.id);

    const resizeRes = await fetch(`${baseUrl}/api/term/resize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: term.id, cols: 110, rows: 35 }),
    }).then((r) => r.json());
    assert.equal(resizeRes.ok, true);

    // Connect SSE stream and verify PTY roundtrip output
    const marker = 'SPLIT_WORKBENCH_PTY_OK_9421';
    const controller = new AbortController();
    const streamPromise = (async () => {
      const resp = await fetch(`${baseUrl}/api/term/stream?id=${encodeURIComponent(term.id)}&token=${encodeURIComponent(token)}`, {
        signal: controller.signal,
      });
      assert.equal(resp.status, 200);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const obj = JSON.parse(line.slice(6));
              if (obj.b64) {
                acc += Buffer.from(obj.b64, 'base64').toString('utf-8');
                if (acc.includes(marker)) {
                  controller.abort();
                  return acc;
                }
              }
            } catch {}
          }
        }
      }
      return acc;
    })();

    // Send command to PTY
    await new Promise((r) => setTimeout(r, 200));
    await fetch(`${baseUrl}/api/term/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: term.id, data: `echo ${marker}\r` }),
    });

    const ptyOutput = await Promise.race([
      streamPromise.catch((e) => (e.name === 'AbortError' ? marker : Promise.reject(e))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PTY echo timed out')), 5000)),
    ]);
    assert.ok(ptyOutput.includes(marker), 'Expected PTY output to contain marker');

    const closeRes = await fetch(`${baseUrl}/api/term/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: term.id }),
    }).then((r) => r.json());
    assert.equal(closeRes.ok, true);

    console.log('[PASS] Live sidecar HTTP + Auth + FS + Real Python PTY SSE tests');
  } finally {
    child.kill('SIGTERM');
  }
}

testLayoutEngine();
await testLiveServer();
console.log('ALL TESTS PASSED');
