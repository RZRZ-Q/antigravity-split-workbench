/**
 * Split Workbench Sidecar Backend
 *
 * Hosts an Antigravity Aux Pane Web UI with:
 * - Smart BSP auto-splitting workbench (Files, Web Preview, Real PTY Terminal, Artifacts)
 * - Live Chat Links extraction from current conversation transcript.jsonl
 * - Localhost dev server port discovery
 * - SSE-backed real interactive PTY terminals via Python 3 pty_bridge.py
 * - Per-workspace layout persistence
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PTY_BRIDGE_PATH = join(__dirname, 'pty_bridge.py');
const HOME_DIR = homedir();
const BIND_HOST = '127.0.0.1';

const PORT = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '0', 10);
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const ID_RE = /^[0-9a-f-]{8,}$/i;
let ACTIVE_PORT = PORT;

// ---------------------------------------------------------------------------
// Resolve sidecar_sdk preload.js so window.sidecar stays 100% host-compatible
// ---------------------------------------------------------------------------
function loadPreloadJs() {
  const candidates = [];
  try {
    candidates.push(fileURLToPath(import.meta.resolve('sidecar_sdk/preload.js')));
  } catch {
    // standalone run outside register_loader
  }
  candidates.push(join(HOME_DIR, '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js'));
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        // continue
      }
    }
  }
  // Minimal standalone fallback when run directly in a regular browser without sidecar_sdk
  return `(function(){
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const conversationId = params.get('conversationId') || '';
  const wsParam = params.get('workspace') || '';
  const uris = wsParam ? [wsParam.startsWith('file://') ? wsParam : 'file://' + wsParam] : [];
  window.sidecar = {
    conversationId,
    fetch(url, opts = {}) {
      const headers = new Headers(opts.headers || {});
      if (!headers.has('Content-Type') && opts.body) headers.set('Content-Type', 'application/json');
      if (token) headers.set('X-Sidecar-Token', token);
      return fetch(url, { ...opts, headers });
    },
    async getWorkspaceUris() { return uris; },
    onWorkspaceChange(fn) { setTimeout(() => fn(uris), 0); return () => {}; },
    agent: { async sendMessage() { return {}; }, async startConversation() { return {}; }, async getConversationMetadata() { return {}; } },
    ui: { toggleAuxPane() {}, toggleConversation() {}, addArtifactComment() {} },
    auth: { requestCredentialRefresh() {} }
  };
})();`;
}

const PRELOAD_JS = loadPreloadJs();

// ---------------------------------------------------------------------------
// App data & persistent state helpers
// ---------------------------------------------------------------------------
function resolveAppDataDirs() {
  const dirs = [];
  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    // Typical path: ~/.gemini/antigravity/sidecar_data/<plugin>/<sidecar>/data
    let cur = resolve(execData);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(cur, 'brain'))) {
        dirs.push(cur);
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const defaults = [
    join(HOME_DIR, '.gemini', 'antigravity'),
    join(HOME_DIR, '.gemini', 'antigravity-ide'),
    join(HOME_DIR, '.gemini', 'antigravity-cli'),
  ];
  for (const d of defaults) {
    if (!dirs.includes(d) && existsSync(join(d, 'brain'))) {
      dirs.push(d);
    }
  }
  return dirs;
}

function getPersistentDataDir() {
  const dir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    ? resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR)
    : join(HOME_DIR, '.gemini', 'antigravity', 'sidecar_data', 'split-workbench', 'workbench', 'data');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function findBrainConvDir(conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) return null;
  for (const appData of resolveAppDataDirs()) {
    const candidate = join(appData, 'brain', conversationId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readStateStore() {
  const file = join(getPersistentDataDir(), 'state.json');
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return { layouts: {}, prefs: {} };
  }
}

function writeStateStore(store) {
  const file = join(getPersistentDataDir(), 'state.json');
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  writeFileSync(file, readFileSync(tmp));
  try {
    // Atomic-ish fallback safe on all fs
    import('node:fs').then((fs) => fs.rmSync(tmp, { force: true })).catch(() => {});
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Path security & File helpers
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const PDF_EXTS = new Set(['.pdf']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'target',
  '.turbo',
  '.idea',
  '.DS_Store',
]);

function uriToPath(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim();
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s.split('#')[0]);
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/\//, '').split('#')[0]);
    }
  }
  if (s.startsWith('~/')) {
    s = join(HOME_DIR, s.slice(2));
  }
  return resolve(s);
}

function isSafeUserPath(targetPath) {
  if (!targetPath || targetPath.includes('\0')) return false;
  const resolved = resolve(targetPath);
  // Restrict to paths under user home or /tmp (prevents reading arbitrary system secrets like /etc/shadow)
  const homeReal = realpathSync(HOME_DIR);
  const allowedPrefixes = [homeReal, HOME_DIR, '/tmp', '/private/tmp'];
  try {
    const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
    return allowedPrefixes.some((p) => real === p || real.startsWith(p.endsWith(sep) ? p : p + sep));
  } catch {
    return allowedPrefixes.some((p) => resolved === p || resolved.startsWith(p.endsWith(sep) ? p : p + sep));
  }
}

function isLikelyBinary(buf) {
  const len = Math.min(buf.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious++;
  }
  return len > 0 && suspicious / len > 0.25;
}

function listDirectory(dirPath, showHidden = false) {
  const abs = uriToPath(dirPath) || HOME_DIR;
  if (!isSafeUserPath(abs)) throw new Error('Path outside allowed directories');
  const st = statSync(abs);
  if (!st.isDirectory()) throw new Error('Not a directory');
  const dirents = readdirSync(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue;
    if (d.name === '.DS_Store') continue;
    const full = join(abs, d.name);
    let size = 0;
    let mtimeMs = 0;
    let isDir = d.isDirectory();
    try {
      const s = statSync(full);
      isDir = s.isDirectory();
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    entries.push({
      name: d.name,
      path: full,
      isDir,
      size,
      mtimeMs,
      ext: isDir ? '' : extname(d.name).toLowerCase(),
    });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const parent = dirname(abs);
  return {
    dir: abs,
    parent: parent !== abs && isSafeUserPath(parent) ? parent : null,
    entries,
  };
}

function searchFiles(rootPath, query, maxResults = 60) {
  const root = uriToPath(rootPath);
  if (!root || !isSafeUserPath(root) || !existsSync(root)) return [];
  const q = String(query || '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const results = [];
  const queue = [{ dir: root, depth: 0 }];
  const maxDepth = 7;
  const maxScanned = 6000;
  let scanned = 0;

  while (queue.length > 0 && scanned < maxScanned && results.length < maxResults * 3) {
    const { dir, depth } = queue.shift();
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') && d.name !== '.env' && !d.name.startsWith('.agents')) continue;
      if (SKIP_DIRS.has(d.name)) continue;
      scanned++;
      const full = join(dir, d.name);
      const rel = relative(root, full);
      if (d.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      const lowerRel = rel.toLowerCase();
      const lowerName = d.name.toLowerCase();
      if (terms.length === 0) {
        results.push({ name: d.name, rel, path: full, score: depth });
      } else if (terms.every((t) => lowerRel.includes(t))) {
        let score = depth * 10 + rel.length;
        if (lowerName === q) score -= 500;
        else if (lowerName.startsWith(q)) score -= 300;
        else if (lowerName.includes(q)) score -= 150;
        results.push({ name: d.name, rel, path: full, score });
      }
    }
  }
  results.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
  return results.slice(0, maxResults).map(({ name, rel, path }) => ({ name, rel, path, ext: extname(name).toLowerCase() }));
}

function readFilePayload(filePath) {
  const abs = uriToPath(filePath);
  if (!abs || !isSafeUserPath(abs)) throw new Error('Path outside allowed directories');
  if (!existsSync(abs)) throw new Error('File not found');
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error('Path is a directory');
  const ext = extname(abs).toLowerCase();
  const name = basename(abs);

  if (IMAGE_EXTS.has(ext)) {
    return { path: abs, name, ext, kind: 'image', size: st.size, mtimeMs: st.mtimeMs };
  }
  if (PDF_EXTS.has(ext)) {
    return { path: abs, name, ext, kind: 'pdf', size: st.size, mtimeMs: st.mtimeMs };
  }
  const MAX_TEXT = 4 * 1024 * 1024;
  if (st.size > MAX_TEXT) {
    return {
      path: abs,
      name,
      ext,
      kind: 'too-large',
      size: st.size,
      mtimeMs: st.mtimeMs,
      error: `File is ${(st.size / (1024 * 1024)).toFixed(1)} MiB (limit 4 MiB)`,
    };
  }
  const buf = readFileSync(abs);
  if (isLikelyBinary(buf)) {
    return { path: abs, name, ext, kind: 'binary', size: st.size, mtimeMs: st.mtimeMs };
  }
  const content = buf.toString('utf-8');
  const kind = ext === '.md' || ext === '.markdown' || ext === '.mdx' ? 'markdown' : 'text';
  return {
    path: abs,
    name,
    ext,
    kind,
    content,
    size: st.size,
    mtimeMs: st.mtimeMs,
    lines: content.split('\n').length,
  };
}

// ---------------------------------------------------------------------------
// Artifacts & Chat Links (transcript.jsonl) extractor
// ---------------------------------------------------------------------------
function listArtifacts(conversationId) {
  const brainDir = findBrainConvDir(conversationId);
  if (!brainDir) return { conversationId: conversationId || null, dir: null, items: [] };
  const items = [];
  const walk = (dir, prefix = '', depth = 0) => {
    if (depth > 3) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') || d.name === 'browser_sandbox') continue;
      const full = join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        walk(full, rel, depth + 1);
      } else {
        try {
          const st = statSync(full);
          items.push({
            name: d.name,
            rel,
            path: full,
            ext: extname(d.name).toLowerCase(),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // skip
        }
      }
    }
  };
  walk(brainDir);
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { conversationId, dir: brainDir, items };
}

const transcriptCache = new Map(); // convId -> { mtimeMs, size, result }
const FILE_LINK_RE = /\[([^\]]+)\]\(file:\/\/(\/[^)#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?\)/g;
const RAW_FILE_URI_RE = /file:\/\/(\/[^\s)"'`<>#]+)(?:#L(\d+)(?:-L?(\d+))?)?/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?(?:\/[^\s)"'`<>]*)?/g;

function cleanUrl(u) {
  return u.replace(/[.,;:!?)\]}'"`]+$/, '');
}

function unquoteArg(v) {
  if (typeof v !== 'string') return '';
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function extractChatLinks(conversationId) {
  const brainDir = findBrainConvDir(conversationId);
  if (!brainDir) return { conversationId: conversationId || null, files: [], urls: [] };
  const transcriptPath = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return { conversationId, files: [], urls: [] };

  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return { conversationId, files: [], urls: [] };
  }

  const cached = transcriptCache.get(conversationId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.result;
  }

  const fileMap = new Map(); // absPath -> { path, name, label, line, endLine, source, seq }
  const urlMap = new Map();  // url -> { url, host, isLocal, seq }

  const recordFile = (rawPath, meta) => {
    if (!rawPath) return;
    let abs;
    try {
      abs = decodeURIComponent(rawPath);
    } catch {
      abs = rawPath;
    }
    if (!isAbsolute(abs) || !isSafeUserPath(abs)) return;
    if (abs.includes('/.system_generated/')) return;
    if (!existsSync(abs)) return;
    try {
      if (statSync(abs).isDirectory()) return;
    } catch {
      return;
    }
    const existing = fileMap.get(abs);
    if (!existing || meta.seq >= existing.seq) {
      fileMap.set(abs, {
        path: abs,
        name: basename(abs),
        label: meta.label || basename(abs),
        line: meta.line || existing?.line || null,
        endLine: meta.endLine || existing?.endLine || null,
        source: meta.source,
        seq: meta.seq,
      });
    }
  };

  const recordUrl = (rawUrl, seq) => {
    const cleaned = cleanUrl(rawUrl);
    if (!cleaned || cleaned.length > 500) return;
    try {
      const u = new URL(cleaned);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      // Skip internal language server RPC endpoint and our own sidecar port (prevent self-nesting!)
      const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (isLocal && u.pathname.includes('LanguageServerService')) {
        return;
      }
      const urlPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
      if (isLocal && ACTIVE_PORT > 0 && urlPort === ACTIVE_PORT) {
        return;
      }
      urlMap.set(cleaned, {
        url: cleaned,
        host: u.host,
        path: u.pathname,
        isLocal,
        seq,
      });
    } catch {
      // invalid URL
    }
  };

  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.split('\n');
    let seq = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      seq++;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'PLANNER_RESPONSE') {
        const text = String(obj.content || obj.response || '');
        if (text) {
          for (const m of text.matchAll(FILE_LINK_RE)) {
            recordFile(m[2], {
              label: m[1],
              line: m[3] ? Number(m[3]) : null,
              endLine: m[4] ? Number(m[4]) : null,
              source: 'chat',
              seq,
            });
          }
          for (const m of text.matchAll(RAW_FILE_URI_RE)) {
            recordFile(m[1], {
              line: m[2] ? Number(m[2]) : null,
              endLine: m[3] ? Number(m[3]) : null,
              source: 'chat',
              seq,
            });
          }
          for (const m of text.matchAll(URL_RE)) {
            recordUrl(m[0], seq);
          }
        }
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const name = tc?.name || '';
            const args = tc?.args || {};
            if (name === 'write_file' || name === 'edit_file' || name === 'read_file') {
              const p = unquoteArg(args.Path || args.path || '');
              if (p) {
                recordFile(p, {
                  source: name === 'read_file' ? 'read' : 'edited',
                  seq,
                });
              }
            }
          }
        }
      } else if (obj.type === 'USER_INPUT') {
        const text = String(obj.content || '');
        for (const m of text.matchAll(URL_RE)) {
          recordUrl(m[0], seq);
        }
      }
    }
  } catch {
    // ignore read error
  }

  const files = [...fileMap.values()].sort((a, b) => b.seq - a.seq).slice(0, 40);
  const urls = [...urlMap.values()]
    .sort((a, b) => (a.isLocal !== b.isLocal ? (a.isLocal ? -1 : 1) : b.seq - a.seq))
    .slice(0, 30);

  const result = { conversationId, files, urls };
  transcriptCache.set(conversationId, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// ---------------------------------------------------------------------------
// Localhost dev port discovery (macOS lsof)
// ---------------------------------------------------------------------------
let portCache = { ts: 0, ports: [] };
function discoverLocalPorts() {
  const now = Date.now();
  if (now - portCache.ts < 3000) return Promise.resolve(portCache.ports);

  return new Promise((resolvePromise) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 1200, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        resolvePromise(portCache.ports);
        return;
      }
      const seen = new Map();
      const skipProcs = new Set(['ControlCe', 'rapportd', 'AirPlayXP', 'language_', 'Antigravi', 'mDNSRespo']);
      for (const line of stdout.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const proc = parts[0];
        const pid = parts[1];
        const nameCol = parts[8];
        if (skipProcs.has(proc)) continue;
        const m = /:(\d+)$/.exec(nameCol);
        if (!m) continue;
        const port = Number(m[1]);
        if ((ACTIVE_PORT > 0 && port === ACTIVE_PORT) || port === PORT || port < 80 || port > 65535) continue;
        if (!seen.has(port)) {
          seen.set(port, { port, proc, pid, url: `http://localhost:${port}` });
        }
      }
      const ports = [...seen.values()].sort((a, b) => a.port - b.port);
      portCache = { ts: now, ports };
      resolvePromise(ports);
    });
  });
}

// ---------------------------------------------------------------------------
// Real PTY Terminal Manager (Python 3 pty_bridge.py + SSE streaming)
// ---------------------------------------------------------------------------
const terminals = new Map(); // id -> session
const MAX_BUFFER_CHARS = 65536;

function createTerminal({ cwd, cols = 80, rows = 24 }) {
  const targetCwd = cwd && isSafeUserPath(uriToPath(cwd)) && existsSync(uriToPath(cwd))
    ? uriToPath(cwd)
    : HOME_DIR;

  const id = randomUUID().slice(0, 8);
  const child = spawn('python3', ['-u', PTY_BRIDGE_PATH, '--cwd', targetCwd, '--cols', String(cols), '--rows', String(rows)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = {
    id,
    cwd: targetCwd,
    pid: child.pid,
    child,
    cols,
    rows,
    createdAt: Date.now(),
    exited: false,
    exitCode: null,
    buffer: [], // array of base64 chunks
    bufferLen: 0,
    clients: new Set(), // active SSE response objects
    stdoutRemainder: '',
  };

  const broadcast = (eventName, payload) => {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of session.clients) {
      try {
        res.write(frame);
      } catch {
        session.clients.delete(res);
      }
    }
  };

  child.stdout.on('data', (chunk) => {
    session.stdoutRemainder += chunk.toString('utf-8');
    let nl;
    while ((nl = session.stdoutRemainder.indexOf('\n')) !== -1) {
      const line = session.stdoutRemainder.slice(0, nl).trim();
      session.stdoutRemainder = session.stdoutRemainder.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'data' && msg.b64) {
        session.buffer.push(msg.b64);
        session.bufferLen += msg.b64.length;
        while (session.bufferLen > MAX_BUFFER_CHARS && session.buffer.length > 1) {
          const removed = session.buffer.shift();
          session.bufferLen -= removed.length;
        }
        broadcast('data', { b64: msg.b64 });
      } else if (msg.type === 'ready') {
        session.pid = msg.pid || session.pid;
        session.shell = msg.shell || '';
      } else if (msg.type === 'exit') {
        session.exited = true;
        session.exitCode = msg.code ?? 0;
        broadcast('exit', { code: session.exitCode });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const b64 = chunk.toString('base64');
    broadcast('data', { b64 });
  });

  child.on('exit', (code) => {
    if (!session.exited) {
      session.exited = true;
      session.exitCode = code ?? 0;
      broadcast('exit', { code: session.exitCode });
    }
    for (const res of session.clients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    session.clients.clear();
  });

  terminals.set(id, session);
  return { id, cwd: targetCwd, pid: session.pid, cols, rows };
}

function sendTerminalCommand(id, cmdObj) {
  const s = terminals.get(id);
  if (!s || s.exited || !s.child.stdin.writable) return false;
  s.child.stdin.write(JSON.stringify(cmdObj) + '\n');
  return true;
}

function closeTerminal(id) {
  const s = terminals.get(id);
  if (!s) return false;
  try {
    if (!s.exited && s.child.stdin.writable) {
      s.child.stdin.write(JSON.stringify({ type: 'kill' }) + '\n');
    }
    s.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  for (const res of s.clients) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  s.clients.clear();
  terminals.delete(id);
  return true;
}

function cleanupAllTerminals() {
  for (const id of [...terminals.keys()]) {
    closeTerminal(id);
  }
}

process.on('SIGINT', () => { cleanupAllTerminals(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAllTerminals(); process.exit(0); });
process.on('exit', cleanupAllTerminals);

function findChromeBinary() {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function captureWebScreenshot({ targetUrl, width = 1024, height = 720, conversationId = '' }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chrome = findChromeBinary();
    if (!chrome) {
      rejectPromise(new Error('Chrome/Chromium binary not found on this machine'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs can be captured');
      }
    } catch (err) {
      rejectPromise(err);
      return;
    }

    const w = Math.max(320, Math.min(1920, Math.round(Number(width) || 1024)));
    const h = Math.max(240, Math.min(1440, Math.round(Number(height) || 720)));
    const brainDir = findBrainConvDir(conversationId);
    const outDir = brainDir ? join(brainDir, 'scratch') : join(getPersistentDataDir(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `web-screenshot-${ts}.png`;
    const outPath = join(outDir, name);

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${w},${h}`,
      `--screenshot=${outPath}`,
      parsed.toString(),
    ];

    execFile(chrome, args, { timeout: 15000 }, (err) => {
      if (err) {
        rejectPromise(new Error(`Screenshot failed: ${err.message}`));
        return;
      }
      if (!existsSync(outPath)) {
        rejectPromise(new Error('Screenshot file was not created'));
        return;
      }
      resolvePromise({ ok: true, path: outPath, name, width: w, height: h });
    });
  });
}

function revealInOsFileManager(absPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-R', absPath], { timeout: 4000 }, (err) => {
        if (err) rejectPromise(err);
        else resolvePromise({ ok: true });
      });
    } else if (process.platform === 'win32') {
      execFile('explorer', [`/select,${absPath}`], { timeout: 4000 }, () => resolvePromise({ ok: true }));
    } else {
      execFile('xdg-open', [dirname(absPath)], { timeout: 4000 }, (err) => {
        if (err) rejectPromise(err);
        else resolvePromise({ ok: true });
      });
    }
  });
}

function sanitizeDownloadFilename(name) {
  return String(name || 'download').replace(/["\\\r\n/]/g, '_');
}

// ---------------------------------------------------------------------------
// Agent API bridge (mirrors sidecar_sdk/index.mjs for /_sidecar/*)
// ---------------------------------------------------------------------------
function execAgentApi(args, { projectId } = {}) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  const out = execFileSync(file, execArgs, { encoding: 'utf-8', env });
  return out.trim() ? JSON.parse(out) : {};
}

// ---------------------------------------------------------------------------
// HTTP Server + Auth + Routing
// ---------------------------------------------------------------------------
function parseCookie(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function validateToken(req, url) {
  if (!UI_TOKEN) return true;
  const provided =
    req.headers['x-sidecar-token'] ||
    url.searchParams.get('token') ||
    parseCookie(req.headers.cookie, 'sw_token');
  return provided === UI_TOKEN;
}

function encodePreviewDir(absDir) {
  return Buffer.from(absDir, 'utf-8').toString('base64url');
}

function decodePreviewDir(b64) {
  try {
    return Buffer.from(b64, 'base64url').toString('utf-8');
  } catch {
    return '';
  }
}

function signPreviewDir(b64Dir) {
  if (!UI_TOKEN) return 'local';
  return createHmac('sha256', UI_TOKEN).update(b64Dir).digest('hex').slice(0, 20);
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        rejectBody(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (!body.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(body));
      } catch {
        rejectBody(new Error('Invalid JSON body'));
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveStaticFile(res, relPath) {
  const safeRel = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = join(PUBLIC_DIR, safeRel);
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(full).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': relPath.startsWith('vendor/') ? 'public, max-age=86400' : 'no-store',
  });
  res.end(readFileSync(full));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT || 80}`);
  const pathname = url.pathname;

  try {
    // 1. Host preload script
    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PRELOAD_JS);
      return;
    }

    // 2. Public static assets (set HttpOnly session cookie when opened with valid ?token= so /preview/ subresources work)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const extraHeaders = {};
      if (UI_TOKEN && url.searchParams.get('token') === UI_TOKEN) {
        extraHeaders['Set-Cookie'] = `sw_token=${encodeURIComponent(UI_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`;
      }
      const full = join(PUBLIC_DIR, 'index.html');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      });
      res.end(readFileSync(full));
      return;
    }
    if (
      req.method === 'GET' &&
      (pathname === '/styles.css' ||
        pathname === '/layout.js' ||
        pathname === '/i18n.js' ||
        pathname === '/app.js' ||
        pathname.startsWith('/vendor/'))
    ) {
      serveStaticFile(res, pathname.slice(1));
      return;
    }

    // 2b. Zero-server local HTML preview route: /preview/<sig>/<base64url-dir>/<relpath>
    // Signature in path guarantees relative CSS/JS/img subresources work inside cross-origin iframes without cookies!
    if (req.method === 'GET' && pathname.startsWith('/preview/')) {
      const rest = pathname.slice('/preview/'.length);
      const parts = rest.split('/');
      if (parts.length < 3) {
        res.writeHead(400);
        res.end('Invalid preview path');
        return;
      }
      const [sig, b64Dir, ...relParts] = parts;
      if (UI_TOKEN && sig !== signPreviewDir(b64Dir) && !validateToken(req, url)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      const baseDir = decodePreviewDir(b64Dir);
      let relFile;
      try {
        relFile = decodeURIComponent(relParts.join('/'));
      } catch {
        relFile = relParts.join('/');
      }
      const safeRel = normalize(relFile).replace(/^(\.\.(\/|\\|$))+/, '');
      const full = resolve(baseDir, safeRel);
      const resolvedBase = resolve(baseDir);
      if (
        !isSafeUserPath(resolvedBase) ||
        !(full === resolvedBase || full.startsWith(resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep)) ||
        !existsSync(full) ||
        statSync(full).isDirectory()
      ) {
        res.writeHead(404);
        res.end('Preview file not found');
        return;
      }
      const ext = extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(full));
      return;
    }

    // 3. Health check
    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, port: ACTIVE_PORT, terminals: terminals.size });
      return;
    }

    // 4. Require sidecar token on all API routes & mutating requests
    if (!validateToken(req, url)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // 5. Built-in /_sidecar/* agentapi bridge routes
    if (req.method === 'POST' && pathname === '/_sidecar/get-conversation-metadata') {
      const data = await readJsonBody(req);
      sendJson(res, 200, execAgentApi(['get-conversation-metadata', data.conversationId]));
      return;
    }
    if (req.method === 'POST' && pathname === '/_sidecar/send-message') {
      const data = await readJsonBody(req);
      const args = ['send-message'];
      if (data.title) args.push('--title', data.title);
      args.push(data.conversationId, data.message);
      sendJson(res, 200, execAgentApi(args, { projectId: data.projectId }));
      return;
    }
    if (req.method === 'POST' && pathname === '/_sidecar/new-conversation') {
      const data = await readJsonBody(req);
      sendJson(res, 200, execAgentApi(['new-conversation', '--model', data.model || 'flash', data.message], { projectId: data.projectId }));
      return;
    }

    // 6. Filesystem & File APIs
    if (req.method === 'GET' && pathname === '/api/fs/list') {
      const dir = url.searchParams.get('dir') || HOME_DIR;
      const showHidden = url.searchParams.get('showHidden') === '1';
      sendJson(res, 200, listDirectory(dir, showHidden));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/fs/search') {
      const root = url.searchParams.get('root') || HOME_DIR;
      const q = url.searchParams.get('q') || '';
      sendJson(res, 200, { root: uriToPath(root), items: searchFiles(root, q) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/file/read') {
      const target = url.searchParams.get('path') || '';
      sendJson(res, 200, readFilePayload(target));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/file/stat') {
      const abs = uriToPath(url.searchParams.get('path') || '');
      if (!abs || !isSafeUserPath(abs) || !existsSync(abs)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const st = statSync(abs);
      sendJson(res, 200, { path: abs, size: st.size, mtimeMs: st.mtimeMs });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/file/raw') {
      const abs = uriToPath(url.searchParams.get('path') || '');
      if (!abs || !isSafeUserPath(abs) || !existsSync(abs)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const st = statSync(abs);
      if (st.isDirectory() || st.size > 20 * 1024 * 1024) {
        res.writeHead(400);
        res.end('Invalid file');
        return;
      }
      const ext = extname(abs).toLowerCase();
      const extra = {};
      if (url.searchParams.get('download') === '1') {
        const fname = sanitizeDownloadFilename(basename(abs));
        extra['Content-Disposition'] = `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(basename(abs))}`;
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(readFileSync(abs));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/fs/reveal') {
      const data = await readJsonBody(req);
      const abs = uriToPath(data.path || '');
      if (!abs || !isSafeUserPath(abs) || !existsSync(abs)) {
        sendJson(res, 404, { error: 'Path not found' });
        return;
      }
      await revealInOsFileManager(abs);
      sendJson(res, 200, { ok: true, path: abs });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/web/download') {
      const rawUrl = url.searchParams.get('url') || '';
      let parsed;
      try {
        parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Invalid protocol');
        }
      } catch {
        res.writeHead(400);
        res.end('Invalid URL');
        return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(parsed.toString(), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) {
          res.writeHead(502);
          res.end(`Upstream returned HTTP ${resp.status}`);
          return;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 15 * 1024 * 1024) {
          res.writeHead(413);
          res.end('Page too large to download');
          return;
        }
        const rawBase = basename(parsed.pathname) || parsed.hostname || 'page';
        const fname = sanitizeDownloadFilename(rawBase.includes('.') ? rawBase : `${rawBase}.html`);
        res.writeHead(200, {
          'Content-Type': resp.headers.get('content-type') || 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fname}"`,
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      } catch (err) {
        clearTimeout(timer);
        res.writeHead(502);
        res.end(`Download failed: ${err.message}`);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/web/screenshot') {
      const data = await readJsonBody(req);
      const result = await captureWebScreenshot({
        targetUrl: String(data.url || ''),
        width: data.width,
        height: data.height,
        conversationId: data.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '',
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/file/write') {
      const data = await readJsonBody(req);
      const abs = uriToPath(data.path || '');
      if (!abs || !isSafeUserPath(abs)) {
        sendJson(res, 403, { error: 'Path outside allowed directories' });
        return;
      }
      if (typeof data.content !== 'string') {
        sendJson(res, 400, { error: 'content must be string' });
        return;
      }
      writeFileSync(abs, data.content, 'utf-8');
      const st = statSync(abs);
      sendJson(res, 200, { ok: true, path: abs, size: st.size, mtimeMs: st.mtimeMs });
      return;
    }

    // 6b. Build local HTML preview URL (zero user dev-server needed!)
    if (req.method === 'GET' && pathname === '/api/preview-url') {
      const abs = uriToPath(url.searchParams.get('path') || '');
      if (!abs || !isSafeUserPath(abs) || !existsSync(abs) || statSync(abs).isDirectory()) {
        sendJson(res, 404, { error: 'HTML file not found' });
        return;
      }
      const dir = dirname(abs);
      const file = basename(abs);
      const b64Dir = encodePreviewDir(dir);
      const sig = signPreviewDir(b64Dir);
      const previewPath = `/preview/${sig}/${b64Dir}/${encodeURIComponent(file)}`;
      sendJson(res, 200, { path: abs, previewPath });
      return;
    }

    // 7. Artifacts & Chat Links APIs
    if (req.method === 'GET' && pathname === '/api/artifacts') {
      const convId = url.searchParams.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      sendJson(res, 200, listArtifacts(convId));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/chat-links') {
      const convId = url.searchParams.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      sendJson(res, 200, extractChatLinks(convId));
      return;
    }

    // 8. Localhost port discovery
    if (req.method === 'GET' && pathname === '/api/ports') {
      const ports = await discoverLocalPorts();
      sendJson(res, 200, { ports });
      return;
    }

    // 9. Persistent layout state
    if (req.method === 'GET' && pathname === '/api/state') {
      const key = url.searchParams.get('key') || 'default';
      const store = readStateStore();
      sendJson(res, 200, { layout: store.layouts?.[key] || null, prefs: store.prefs || {} });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/state') {
      const data = await readJsonBody(req);
      const key = String(data.key || 'default');
      const store = readStateStore();
      store.layouts = store.layouts || {};
      if (data.layout !== undefined) store.layouts[key] = data.layout;
      if (data.prefs && typeof data.prefs === 'object') {
        store.prefs = { ...(store.prefs || {}), ...data.prefs };
      }
      writeStateStore(store);
      sendJson(res, 200, { ok: true });
      return;
    }

    // 10. PTY Terminal APIs
    if (req.method === 'GET' && pathname === '/api/term/list') {
      const list = [...terminals.values()].map((s) => ({
        id: s.id,
        cwd: s.cwd,
        pid: s.pid,
        exited: s.exited,
        exitCode: s.exitCode,
        createdAt: s.createdAt,
      }));
      sendJson(res, 200, { terminals: list });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/term/create') {
      const data = await readJsonBody(req);
      const info = createTerminal({
        cwd: data.cwd || HOME_DIR,
        cols: Number(data.cols) || 80,
        rows: Number(data.rows) || 24,
      });
      sendJson(res, 200, info);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/term/stream') {
      const id = url.searchParams.get('id') || '';
      const session = terminals.get(id);
      if (!session) {
        sendJson(res, 404, { error: 'Terminal session not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      // Replay buffered scrollback so pane restore / re-mount keeps terminal history
      if (session.buffer.length > 0) {
        const joined = Buffer.concat(session.buffer.map((b) => Buffer.from(b, 'base64'))).toString('base64');
        res.write(`event: data\ndata: ${JSON.stringify({ b64: joined })}\n\n`);
      }
      if (session.exited) {
        res.write(`event: exit\ndata: ${JSON.stringify({ code: session.exitCode ?? 0 })}\n\n`);
        res.end();
        return;
      }
      session.clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepAlive);
          session.clients.delete(res);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        session.clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/term/input') {
      const data = await readJsonBody(req);
      const ok = sendTerminalCommand(data.id, { type: 'input', data: String(data.data || '') });
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/term/resize') {
      const data = await readJsonBody(req);
      const ok = sendTerminalCommand(data.id, {
        type: 'resize',
        cols: Number(data.cols) || 80,
        rows: Number(data.rows) || 24,
      });
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/term/close') {
      const data = await readJsonBody(req);
      sendJson(res, 200, { ok: closeTerminal(data.id) });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, BIND_HOST, () => {
  ACTIVE_PORT = server.address().port;
  console.log(`[split-workbench] listening on http://${BIND_HOST}:${ACTIVE_PORT}`);
});
