'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

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
const TOOL_OUTPUT_DIR = path.join(PUBLIC_DIR, 'gemma-tool');
const TOOL_OUTPUT_ENTRY = path.join(TOOL_OUTPUT_DIR, 'index.html');
const TOOLS_DIR = path.join(__dirname, 'tools');

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

// Calls fn for every complete line a child process writes to the given stream.
function onLines(stream, fn) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      fn(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
}

// --- Gemini (Hydrogen Medium by default) via agy's Agent Client Protocol server (`agy acp`, JSON-RPC over stdio) ---
// ACP streams Gemini's thought summaries and reply as they are generated. Gemini replies with the tool's code (see
// AGENTS.md); the server tests it and installs it as tools/make_3d_slide.js. agy authenticates on this machine; the
// browser only ever sees run state and model output, never credentials.
const AGY_BIN = process.env.AGY_BIN || 'agy';
const NEON_MODEL = process.env.GEMINI_MODEL || 'gemini-4-hydrogen-medium';
const NEON_TIMEOUT_MS = 300000;
const MAX_PROMPT_LENGTH = 500;
const MAX_STREAM_CHARS = 60000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const TOOL_FILE = path.join(TOOLS_DIR, 'make_3d_slide.js');
const CANDIDATE_FILE = path.join(TOOLS_DIR, '.candidate.js'); // never discovered: no matching .json
// One run on a different topic, to check the code loads and returns a page before Gemma can see it.
// Development milestones, reported when Gemini's code (as it streams) first contains each feature.
const CODE_MILESTONES = [
  [/split\(\s*['"`]\|/, "Parses Gemma's title, subtitle and milestones"],
  [/new THREE\.(Scene|PerspectiveCamera)/, 'Builds the 3D scene and camera'],
  [/OrbitControls/, 'Adds drag-to-orbit controls'],
  [/CSS2D(Renderer|Object)/, 'Adds HTML labels anchored in 3D'],
  [/Raycaster|pointermove|mousemove/, 'Adds hover feedback'],
  [/requestAnimationFrame|setAnimationLoop/, 'Animates the scene'],
];
const TOOL_TEST = `const html = require(process.argv[1])({ title: 'Test Plan', subtitle: 'Smoke test',
  milestones: ['Phase 1 | Research | a b | c d | e f', 'Phase 2 | Build | g h | i j'] });
if (typeof html !== 'string' || !/<html[\\s>]/i.test(html)) throw new Error('it did not return an HTML page');`;

const neon = { state: 'idle', model: NEON_MODEL, phase: null, startedAt: null, finishedAt: null, error: null, steps: [] };
let neonChild = null;

function geminiPrompt(prompt) {
  let slide = '';
  try {
    slide = fs.readFileSync(path.join(PUBLIC_DIR, 'gemma-raw.html'), 'utf8').trim();
  } catch {
    // No Gemma slide yet; the tool does not depend on it.
  }
  return slide ? `${prompt}\n\nGemma's current slide (body markup):\n${slide}` : prompt;
}

async function installTool(reply, step) {
  const match = reply.match(/```(?:js|javascript)?[^\n]*\n([\s\S]*?)```/);
  if (!match) throw new Error('Gemini replied without a code block');
  fs.writeFileSync(CANDIDATE_FILE, match[1], 'utf8');
  step('Test: running the tool on a different topic');
  try {
    await new Promise((resolve, reject) =>
      execFile(process.execPath, ['-e', TOOL_TEST, CANDIDATE_FILE], { cwd: TOOLS_DIR, timeout: 10000 }, (err, _out, stderr) =>
        err ? reject(new Error(`Tool test failed: ${(stderr.trim().split('\n').find((l) => /Error/.test(l)) || err.message).slice(0, 160)}`)) : resolve()
      )
    );
    step('Test passed: it returns a complete HTML page');
    fs.renameSync(CANDIDATE_FILE, TOOL_FILE);
    step(`Installed ${path.relative(__dirname, TOOL_FILE)}: Gemma can now discover it`);
  } finally {
    fs.rmSync(CANDIDATE_FILE, { force: true });
  }
}

function startNeon(prompt) {
  // Each run starts with no tool implementations, so any tool Gemma finds afterwards was built in this run.
  for (const name of listTools()) fs.rmSync(path.join(TOOLS_DIR, `${name}.js`), { force: true });
  fs.rmSync(TOOL_OUTPUT_DIR, { recursive: true, force: true });
  Object.assign(neon, { state: 'running', model: NEON_MODEL, phase: 'starting', startedAt: Date.now(), finishedAt: null, error: null, steps: [] });

  const child = spawn(AGY_BIN, ['acp'], { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
  neonChild = child;
  const log = (msg) => console.log(`[gemini +${((Date.now() - neon.startedAt) / 1000).toFixed(1)}s] ${msg}`);
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const waiting = new Map();
  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      waiting.set(++nextId, { resolve, reject });
      send({ id: nextId, method, params });
    });
  let stderrTail = '';
  let thinking = '';
  let reply = '';
  const seen = new Set();
  const step = (text) => {
    neon.steps.push({ at: Date.now() - neon.startedAt, text });
    log(text);
  };
  const once = (key, text) => !seen.has(key) && seen.add(key) && step(text);

  onLines(child.stdout, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const pending = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) pending?.reject(new Error(msg.error.message || 'agy error'));
      else pending?.resolve(msg.result);
    } else if (msg.method === 'session/request_permission') {
      // Gemini is asked to reply with code, not to act; refuse any tool it tries (the server installs the code).
      const reject = msg.params.options?.find((option) => option.kind.startsWith('reject'));
      log(`refused tool ${msg.params.toolCall?.name}`);
      send({ id: msg.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
    } else if (msg.method === 'session/update') {
      const update = msg.params.update;
      const text = update.content?.text || '';
      if (update.sessionUpdate === 'agent_thought_chunk') {
        // Thought summaries start with a **heading**; the headings alone are the milestones.
        thinking = (thinking + text).slice(0, MAX_STREAM_CHARS);
        neon.phase = 'thinking';
        // One row shows the latest heading, so thinking reads as a single milestone that updates in place.
        const headings = [...thinking.matchAll(/\*\*(.+?)\*\*/g)];
        const heading = headings.length && `Thinking: ${headings[headings.length - 1][1]}`;
        const last = neon.steps[neon.steps.length - 1];
        if (heading && heading !== last?.text) {
          if (last?.thinking) Object.assign(last, { at: Date.now() - neon.startedAt, text: heading });
          else neon.steps.push({ at: Date.now() - neon.startedAt, text: heading, thinking: true });
          log(heading);
        }
      } else if (update.sessionUpdate === 'agent_message_chunk') {
        reply = (reply + text).slice(0, MAX_STREAM_CHARS);
        const fence = reply.indexOf('```');
        if (fence < 0) return;
        once('plan', `Plan: ${reply.slice(0, fence).trim().slice(0, 240) || '(none given)'}`);
        const code = reply.slice(fence);
        neon.phase = 'writing code';
        for (const [pattern, label] of CODE_MILESTONES) if (pattern.test(code)) once(label, label);
        if (code.indexOf('```', 3) > 0) {
          neon.phase = 'testing';
          once('complete', `Code complete: ${code.split('\n').length - 2} lines`);
        }
      }
    } else if (msg.id !== undefined) {
      send({ id: msg.id, error: { code: -32601, message: 'Not supported' } });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const finish = (error) => {
    if (neonChild !== child) return;
    neonChild = null;
    clearTimeout(timer);
    child.kill('SIGTERM');
    if (!error && listTools().length === 0) error = 'Gemini finished without adding a tool to tools/';
    Object.assign(neon, { state: error ? 'error' : 'done', phase: null, finishedAt: Date.now(), error });
    log(error ? `error: ${error}\n${stderrTail}` : `installed ${path.relative(__dirname, TOOL_FILE)}`);
  };
  const timer = setTimeout(() => finish(`Timed out after ${NEON_TIMEOUT_MS / 1000} s`), NEON_TIMEOUT_MS);
  child.on('error', (err) => finish(`Could not start agy (${err.code || err.message})`));
  child.on('close', (code) => finish(`agy stopped unexpectedly (exit ${code})`));

  log(`start model=${NEON_MODEL} prompt=${JSON.stringify(prompt)}`);
  (async () => {
    await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const { sessionId } = await request('session/new', { cwd: __dirname, mcpServers: [] });
    await request('session/set_model', { sessionId, modelId: NEON_MODEL });
    step(`Asked ${NEON_MODEL} to build make_3d_slide`);
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: geminiPrompt(prompt) }] });
    log(`reply done ${result?.stopReason} ${JSON.stringify(result?.usage || {})}`);
    await installTool(reply, step);
  })().then(
    () => finish(null),
    (err) => finish(err.message)
  );
}

// --- Gemma runs: step 1 (baseline slide) and step 3 (same request, with the tools found in tools/) ---
const GEMMA_TIMEOUT_MS = 60000;
const idleJob = () => ({ state: 'idle', startedAt: null, finishedAt: null, error: null, summary: null, steps: [] });
const gemma = { slide: idleJob(), tool: idleJob() };
let gemmaChild = null;

// Same rule as gemma-generate.js: a tool is installed once both tools/<name>.json and tools/<name>.js exist.
function listTools() {
  try {
    const files = fs.readdirSync(TOOLS_DIR);
    return files
      .filter((file) => file.endsWith('.json') && files.includes(file.replace(/\.json$/, '.js')))
      .map((file) => path.basename(file, '.json'));
  } catch {
    return [];
  }
}

function startGemma(kind) {
  const job = gemma[kind];
  const withTools = kind === 'tool';
  // Clear the panel's old output so it shows only this run's slide.
  fs.rmSync(withTools ? TOOL_OUTPUT_DIR : ORIGINAL_FILE, { recursive: true, force: true });
  Object.assign(job, { ...idleJob(), state: 'running', startedAt: Date.now() });

  const args = [path.join(__dirname, 'gemma-generate.js'), '--stream', ...(withTools ? ['--tools'] : [])];
  const child = spawn(process.execPath, args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], timeout: GEMMA_TIMEOUT_MS });
  gemmaChild = child;
  let summary = null;
  let stderr = '';
  onLines(child.stdout, (line) => {
    try {
      const event = JSON.parse(line);
      if (event.milestone) job.steps.push({ at: Date.now() - job.startedAt, text: event.milestone });
      if (event.summary) summary = event.summary;
    } catch {
      // Not an event line.
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  const finish = (error) => {
    if (gemmaChild !== child) return;
    gemmaChild = null;
    if (!error && !summary) error = 'Gemma harness returned no result';
    Object.assign(job, { state: error ? 'error' : 'done', finishedAt: Date.now(), error, summary });
    const secs = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
    console.log(
      `[gemma ${kind} ${secs}s] ${error ? `error: ${stderr || error}` : `done firstToken=${summary.firstTokenMs}ms gen=${summary.generationMs}ms tokens=${summary.completionTokens} toolCalls=${JSON.stringify(summary.toolCalls ?? null)}`}`
    );
  };
  child.on('error', (err) => finish(`Could not start Gemma harness (${err.message})`));
  child.on('close', (code, signal) =>
    finish(code === 0 ? null : (stderr.trim().split('\n')[0] || `Gemma harness stopped (${signal || `exit ${code}`})`).slice(0, 200))
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
  const [original, tool] = await Promise.all([
    fileSignature(ORIGINAL_FILE),
    dirSignature(TOOL_OUTPUT_DIR, TOOL_OUTPUT_ENTRY),
  ]);
  sendJson(res, 200, { original, tool, tools: listTools(), gemma, neon });
}

function readJsonPost(req, res, onBody) {
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
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    onBody(body && typeof body === 'object' ? body : {});
  });
}

function handleImprove(req, res) {
  readJsonPost(req, res, (body) => {
    const prompt = String(body.prompt || '').trim();
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

function handleGemma(req, res) {
  readJsonPost(req, res, (body) => {
    const kind = body.withTools === true ? 'tool' : 'slide';
    if (gemmaChild || (kind === 'tool' && (neon.state === 'running' || listTools().length === 0))) {
      sendJson(res, 409, { gemma });
      return;
    }
    startGemma(kind);
    sendJson(res, 202, { gemma });
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
  if (req.method === 'POST' && route === '/api/gemma') {
    handleGemma(req, res);
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
    if (gemmaChild) gemmaChild.kill('SIGTERM');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Agent Boost running at http://${HOST}:${PORT}`);
});
