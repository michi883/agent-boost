'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fs.realpathSync(path.resolve(__dirname, 'public'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(message);
}

function resolvePublicFile(requestUrl) {
  let pathname;
  try {
    const parsed = new URL(requestUrl, `http://${HOST}`);
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { error: 400 };
  }

  if (pathname.includes('\0')) {
    return { error: 400 };
  }

  const normalized = pathname.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Block path traversal and all dotfiles (including .env)
  if (segments.some((seg) => seg === '..' || seg.startsWith('.'))) {
    return { error: 404 };
  }

  const relativePath = segments.length === 0 ? 'index.html' : segments.join('/');
  const candidatePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!candidatePath.startsWith(PUBLIC_DIR + path.sep)) {
    return { error: 404 };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(candidatePath);
  } catch {
    return { error: 404 };
  }

  if (!realPath.startsWith(PUBLIC_DIR + path.sep)) {
    return { error: 404 };
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { error: 404 };
  }

  if (!stat.isFile()) {
    return { error: 404 };
  }

  return { filePath: realPath };
}

// Files the viewer watches. A signature changes whenever the content is rewritten.
const ORIGINAL_FILE = path.join(PUBLIC_DIR, 'gemma-slide.html');
const IMPROVED_DIR = path.join(PUBLIC_DIR, 'gemini');
const IMPROVED_ENTRY = path.join(IMPROVED_DIR, 'index.html');

async function fileSignature(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size > 0 ? `${Math.round(stat.mtimeMs)}-${stat.size}` : null;
  } catch {
    return null;
  }
}

// Covers every file under the improved slide's folder, so edits to its JS/CSS also trigger a reload.
async function dirSignature(dir, entry) {
  if (!(await fileSignature(entry))) return null;

  let maxMtime = 0;
  let totalSize = 0;
  let count = 0;
  const pending = [dir];

  while (pending.length > 0 && count < 500) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        pending.push(fullPath);
      } else if (dirent.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          maxMtime = Math.max(maxMtime, stat.mtimeMs);
          totalSize += stat.size;
          count += 1;
        } catch {
          // File vanished mid-scan; the next poll picks up the new state.
        }
      }
    }
  }

  return `${Math.round(maxMtime)}-${totalSize}-${count}`;
}

// --- Gemini Neon via the agy CLI (headless print mode, stream-json events) ---
// agy authenticates on this machine; the browser only ever sees run state, never credentials.
const AGY_BIN = process.env.AGY_BIN || 'agy';
const NEON_MODEL = process.env.NEON_MODEL || 'gemini-4-neon-xhigh';
const NEON_TIMEOUT = '300s';
const MAX_PROMPT_LENGTH = 500;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const neon = { state: 'idle', startedAt: null, finishedAt: null, error: null };
let neonChild = null;

function startNeon(prompt) {
  // Each run starts from an empty output folder so the right panel shows only fresh work.
  fs.rmSync(IMPROVED_DIR, { recursive: true, force: true });
  Object.assign(neon, { state: 'running', startedAt: Date.now(), finishedAt: null, error: null });

  const args = [
    '-p', prompt,
    '--model', NEON_MODEL,
    '--mode', 'accept-edits',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--print-timeout', NEON_TIMEOUT,
  ];
  const child = spawn(AGY_BIN, args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  neonChild = child;

  const log = (msg) => console.log(`[neon +${((Date.now() - neon.startedAt) / 1000).toFixed(1)}s] ${msg}`);
  const seenSteps = new Set();
  let result = null;
  let stderrTail = '';
  let buffer = '';

  log(`start model=${NEON_MODEL} prompt=${JSON.stringify(prompt)}`);

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const step = event.step_update;
      if (step && !seenSteps.has(`${step.step_index}:${step.state}`)) {
        seenSteps.add(`${step.step_index}:${step.state}`);
        log(`step ${step.step_index} ${step.step_type} ${step.state}`);
      }
      if (event.result) result = event.result;
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const finish = (error) => {
    if (neonChild !== child) return;
    neonChild = null;
    if (!error && !fs.existsSync(IMPROVED_ENTRY)) error = 'Neon finished without writing public/gemini/index.html';
    Object.assign(neon, { state: error ? 'error' : 'done', finishedAt: Date.now(), error });
    log(error ? `error: ${error}\n${stderrTail}` : `done ${JSON.stringify(result?.usage || {})} reply=${JSON.stringify(result?.response || '')}`);
  };
  child.on('error', (err) => finish(`Could not start agy (${err.code || err.message})`));
  child.on('close', (code) =>
    finish(code === 0 && result?.status === 'SUCCESS' ? null : `Neon stopped (exit ${code}, ${result?.status || 'no result'})`)
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sendStatus(res) {
  const [original, improved] = await Promise.all([
    fileSignature(ORIGINAL_FILE),
    dirSignature(IMPROVED_DIR, IMPROVED_ENTRY),
  ]);
  sendJson(res, 200, { original, improved, neon });
}

function handleImprove(req, res) {
  // Only this page may start a run: same-origin JSON POST (blocks cross-site requests and DNS rebinding).
  const host = req.headers.host || '';
  if (!ALLOWED_HOSTS.has(host) || req.headers.origin !== `http://${host}`) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    sendText(res, 415, 'Unsupported Media Type');
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 4096) req.destroy();
  });
  req.on('end', () => {
    let prompt;
    try {
      prompt = String(JSON.parse(raw).prompt || '').trim();
    } catch {
      prompt = '';
    }
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.startsWith('-')) {
      sendText(res, 400, 'Invalid prompt');
      return;
    }
    if (neon.state === 'running') {
      sendJson(res, 409, { neon });
      return;
    }
    startNeon(prompt);
    sendJson(res, 202, { neon });
  });
}

const server = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0];
  if (req.method === 'GET' && route === '/api/status') {
    sendStatus(res).catch(() => sendText(res, 500, 'Internal Server Error'));
    return;
  }
  if (req.method === 'POST' && route === '/api/improve') {
    handleImprove(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const result = resolvePublicFile(req.url || '/');
  if (result.error) {
    sendText(res, result.error, result.error === 400 ? 'Bad Request' : 'Not Found');
    return;
  }

  const ext = path.extname(result.filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(result.filePath, (err, data) => {
    if (err) {
      sendText(res, 500, 'Internal Server Error');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(data);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (neonChild) neonChild.kill('SIGTERM');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Agent Boost running at http://${HOST}:${PORT}`);
});
