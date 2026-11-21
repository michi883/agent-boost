'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(message);
}

// Three.js is served from the local npm install (no venue Wi-Fi needed): only its build/ and examples/jsm/ folders.
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

// Maps a URL path to the folder it is served from: public/, local Three.js, or the tool-test page.
function staticRoot(segments) {
  if (segments[0] === 'vendor' && segments[1] === 'three' && (segments[2] === 'build' || (segments[2] === 'examples' && segments[3] === 'jsm'))) {
    return { root: THREE_DIR, relative: segments.slice(2), cache: true };
  }
  if (segments[0] === 'tool-test' && segments.length === 2 && /^[a-z]+\.html$/.test(segments[1])) return { root: TEST_DIR, relative: [segments[1]] };
  return { root: PUBLIC_DIR, relative: segments.length === 0 ? ['index.html'] : segments };
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

  const { root: rootPath, relative, cache } = staticRoot(segments);
  let root;
  try {
    root = fs.realpathSync(rootPath);
  } catch {
    return { error: 404 };
  }
  const candidatePath = path.resolve(root, relative.join('/'));

  if (!candidatePath.startsWith(root + path.sep)) {
    return { error: 404 };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(candidatePath);
  } catch {
    return { error: 404 };
  }

  if (!realPath.startsWith(root + path.sep)) {
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

  return { filePath: realPath, cache };
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
// --- Step 2: Gemini builds Gemma a reusable tool (Gemini API only; the key never leaves the server) ---
// 1. Gemini Decision 1 (Decisions API, one call): is the request supported, and which measurable capabilities
//    (3D, interaction, color, motion) does it ask for?
// 2. Gemini 4 Hydrogen, low thinking: designs and writes the tool in one pass (its instructions: AGENTS.md).
// 3. Gemini 4 Neon, low thinking, at the same time: names the tool and writes the description Gemma sees.
// 4. The server tests the code in a real browser on Gemma's slide and on a different topic (base checks plus the
//    requested capabilities), sends genuine failures back to Hydrogen, and installs tools/<name>.js only if all pass.
const { checkPage } = require('./page-check');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // No .env: the Gemini API stages report the missing key.
  }
}
loadEnv();

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DECISION_MODEL = 'gemini-decision-1';
const CODE_MODEL = process.env.CODE_MODEL || 'gemini-4-hydrogen';
const CODE_THINKING = process.env.CODE_THINKING || 'low';
const NAME_MODEL = process.env.NAME_MODEL || 'gemini-4-neon';
const NAME_THINKING = process.env.NAME_THINKING || 'low';
const AGENTS_FILE = path.join(__dirname, 'AGENTS.md'); // Hydrogen's instructions (read on every build)
const BUILD_TIMEOUT_MS = 240000;
const MAX_PROMPT_LENGTH = 500;
const MAX_STREAM_CHARS = 60000;
const MAX_REPAIRS = 2;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const CANDIDATE_FILE = path.join(TOOLS_DIR, '.candidate.js'); // never discovered: no matching .json
const TEST_DIR = path.join(os.tmpdir(), 'agent-boost-tool-test');

// "gemini-4-hydrogen-low" -> "Gemini 4 Hydrogen (Low)"
const modelLabel = (id) =>
  id.replace(/-(low|medium|high|xhigh)$/, (_, level) => ` (${level === 'xhigh' ? 'XHigh' : level[0].toUpperCase() + level.slice(1)})`)
    .split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
const MODELS = {
  decide: { id: DECISION_MODEL, name: 'Gemini Decision 1', via: 'Gemini Decisions API' },
  code: { id: CODE_MODEL, thinking: CODE_THINKING, name: modelLabel(`${CODE_MODEL}-${CODE_THINKING}`), via: 'Gemini API' },
  name: { id: NAME_MODEL, thinking: NAME_THINKING, name: modelLabel(`${NAME_MODEL}-${NAME_THINKING}`), via: 'Gemini API' },
};

// Every tool shares this interface, so Gemma can discover and call any of them; only the name and description vary.
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short slide title' },
    subtitle: { type: 'string', description: 'One-line subtitle' },
    milestones: {
      type: 'array',
      description: 'In order, one per period (e.g. 4 quarters)',
      minItems: 2,
      maxItems: 8,
      items: { type: 'string', description: 'Label | 1-2 word theme | three 2-3 word points, e.g. "Q1 | Theme | point | point | point"' },
    },
  },
  required: ['title', 'subtitle', 'milestones'],
};

// Capabilities the browser test can measure. The Decisions API says which ones a request asks for; a tool is installed
// (and the capability claimed) only if its page passes those checks.
const FEATURES = {
  three_d: {
    label: '3D',
    question: 'Does the request ask for 3D (a 3D scene, depth, 3D objects or a camera)?',
    rule: 'a real Three.js 3D scene; tag each milestone\'s main 3D object with object.userData.milestone = its index',
    fails: (c) => (!c.scenes ? 'it renders no Three.js 3D scene' : !c.objects ? 'no 3D object has userData.milestone set (set it to the index on each milestone\'s main object)' : null),
    value: (c) => `${c.objects} 3D objects`,
  },
  interactive: {
    label: 'Interactive',
    question: 'Does the request ask for interaction, such as dragging, orbiting, hovering or clicking?',
    rule: 'real interaction: a mouse drag over the slide or hovering a card visibly changes it',
    fails: (c) => (c.interaction.works ? null : `neither a mouse drag (text moved ${c.interaction.moved} px) nor hovering a card changed the page`),
    value: (c) => [c.interaction.dragged && `drag moves it ${c.interaction.moved} px`, c.interaction.hovered && 'hover reacts'].filter(Boolean).join(', ') || 'no reaction',
  },
  colorful: {
    label: 'Colorful',
    question: 'Does the request ask for color: a colorful, more colorful or more vivid look?',
    rule: 'colorful: at least 4 distinct vivid hues covering at least 8% of the slide (measured on a screenshot)',
    fails: (c) => (c.colors.hues >= 4 && c.colors.vivid >= 8 ? null : `it shows ${c.colors.hues} vivid hues on ${c.colors.vivid}% of the slide (needs at least 4 hues on 8%)`),
    value: (c) => `${c.colors.hues} vivid hues, ${c.colors.vivid}% of the slide`,
  },
  animated: {
    label: 'Animated',
    question: 'Does the request explicitly ask for motion or animation, that is things moving on their own without user input?',
    rule: 'animated: something visibly moves on its own (gentle and continuous, staying in frame)',
    fails: (c) => (c.animated ? null : 'nothing moves on its own'),
    value: (c) => (c.animated ? 'moves on its own' : 'still'),
  },
};

const DECISION_QUESTION = {
  type: 'choice',
  instructions: 'A slide tool receives a slide title, subtitle and milestones (label, theme, points) and returns one self-contained HTML page that shows exactly that text. Can such a tool fulfil the capability request?',
  criteria: {
    supported: 'The request is about how the given content is presented: visual style, colors, layout, typography, 3D, shapes, lighting, motion, interaction, emphasis or mood.',
    unsupported: 'The request needs something the tool cannot do: new, changed or translated text or data, images, video, audio, files, other kinds of output, network or live data, or changes to the AI or this app.',
  },
};

// Development milestones, reported when the code (as it streams) first contains each feature.
const CODE_MILESTONES = [
  [/split\(\s*['"`]\|/, "Parses Gemma's title, subtitle and milestones"],
  [/new THREE\.(Scene|PerspectiveCamera)/, 'Builds the 3D scene and camera'],
  [/OrbitControls/, 'Adds drag-to-orbit controls'],
  [/CSS2D(Renderer|Object)/, 'Adds HTML labels anchored in 3D'],
  [/userData\.milestone/, 'Tags the milestone objects for the framing test'],
  [/getBoundingClientRect/, 'Measures the cards to keep them in frame'],
  [/hsl\(|linear-gradient|#[0-9a-f]{6}['"`],\s*['"`]#[0-9a-f]{6}/i, 'Defines the color palette'],
  [/:hover|pointermove|mouseenter|mousemove/, 'Adds hover feedback'],
  [/requestAnimationFrame|setAnimationLoop|@keyframes|animation:/, 'Adds motion'],
];
// A different topic than any run, with uneven point counts, to check the tool is generic and shows all text.
const TOOL_SAMPLE = {
  title: 'Product Launch Plan',
  subtitle: 'Smoke test for a new slide tool',
  milestones: [
    'Phase 1 | Research | User interviews | Market scan | Pricing study',
    'Phase 2 | Build | Core features | Beta program',
    'Phase 3 | Launch | Press tour | Partner deals | Sales push',
    'Phase 4 | Expand | New regions | Channel sales | Support team',
  ],
};
const TOOL_TEST = `const html = require(process.argv[1])(JSON.parse(process.argv[3]));
if (typeof html !== 'string' || !/<html[\\s>]/i.test(html)) throw new Error('it did not return an HTML page');
require('fs').writeFileSync(process.argv[2], html);`;

// Every text a tool page must show for these arguments.
const textsOf = (args) => [args.title, args.subtitle, ...args.milestones.flatMap((m) => String(m).split('|').map((part) => part.trim()))].filter(Boolean);

// Gemma's slide (its raw body markup) as the tool arguments it stands for; labels Q1.. come from the slide's CSS.
function slideContent(rawFile) {
  let raw;
  try {
    raw = fs.readFileSync(rawFile, 'utf8');
  } catch {
    return null;
  }
  const text = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]).replace(/\s+/g, ' ').trim();
  const sections = [...raw.matchAll(/<section>([\s\S]*?)<\/section>/g)].map(([, html]) => [
    text(html.match(/<h2>(.*?)<\/h2>/)?.[1]),
    ...[...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1])),
  ]);
  const title = text(raw.match(/<h1>(.*?)<\/h1>/)?.[1]);
  if (!title || sections.length < 2) return null;
  return {
    title,
    subtitle: text(raw.match(/<header>[\s\S]*?<p>(.*?)<\/p>/)?.[1]),
    milestones: sections.map((parts, i) => [`Q${i + 1}`, ...parts].join(' | ')),
  };
}

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

// Removes every generated tool (implementation and schema), so each run builds its own.
function removeTools() {
  let files = [];
  try {
    files = fs.readdirSync(TOOLS_DIR);
  } catch {
    return;
  }
  for (const file of files) if (/\.(js|json)$/.test(file)) fs.rmSync(path.join(TOOLS_DIR, file), { force: true });
}

async function geminiApi(endpoint, body, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set (add it to .env)');
  const response = await fetch(`${GEMINI_API}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let message = '';
    try {
      message = (await response.json()).error?.message || '';
    } catch {
      // No JSON error body.
    }
    throw new Error(`Gemini API ${response.status}${message ? `: ${message.slice(0, 200)}` : ''}`);
  }
  return response;
}

// 1. One Decisions API call: supported or not (a calibrated choice), plus a yes/no per measurable capability.
async function decide(request, signal) {
  const questions = { supported: DECISION_QUESTION };
  for (const [key, feature] of Object.entries(FEATURES)) questions[key] = { type: 'noul', instructions: feature.question };
  const response = await geminiApi('decisions', { model: `models/${DECISION_MODEL}`, input: `Capability request for a slide tool: ${request}`, questions }, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
  const { answers } = await response.json();
  if (!answers?.supported?.choice) throw new Error('the Decisions API returned no decision');
  return {
    supported: answers.supported.choice === 'supported',
    confidence: answers.supported.confidence,
    features: Object.keys(FEATURES).filter((key) => answers[key]?.noul > 0.5),
    scores: Object.fromEntries(Object.keys(FEATURES).map((key) => [key, answers[key]?.noul ?? null])),
  };
}

// Streams one generateContent call; reports thought summaries and reply text as they arrive.
async function geminiStream(model, thinking, { system, contents, maxOutputTokens }, signal, onThought, onText) {
  const response = await geminiApi(`models/${model}:streamGenerateContent?alt=sse`, {
    ...(system && { systemInstruction: { parts: [{ text: system }] } }),
    contents,
    generationConfig: { thinkingConfig: { thinkingLevel: thinking, includeThoughts: Boolean(onThought) }, maxOutputTokens },
  }, signal);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let thoughts = '';
  let usage = null;
  let modelVersion = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      let data;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      usage = data.usageMetadata || usage;
      modelVersion = data.modelVersion || modelVersion;
      for (const part of data.candidates?.[0]?.content?.parts || []) {
        if (part.thought) {
          thoughts = (thoughts + (part.text || '')).slice(0, MAX_STREAM_CHARS);
          onThought?.(thoughts);
        } else if (part.text) {
          text = (text + part.text).slice(0, MAX_STREAM_CHARS);
          onText?.(text);
        }
      }
    }
  }
  return { text: text.trim(), usage, modelVersion };
}

// 3. Neon names the tool and describes it for Gemma, from the request and the capabilities the test will verify.
async function nameTool(request, features, signal) {
  const capabilities = features.length ? features.map((key) => FEATURES[key].label).join(', ') : 'none beyond showing the slide text exactly';
  const { text, usage, modelVersion } = await geminiStream(NAME_MODEL, NAME_THINKING, {
    contents: [{ role: 'user', parts: [{ text: `Name a reusable slide tool that another model is building right now from a user's request. Answer straight away.
Request: ${request}
Capabilities it will have (verified by tests before install): ${capabilities}
Reply with exactly two lines:
Name: <snake_case, 2-4 words, starts with a verb, says what the tool does to a slide>
Description: <one sentence of at most 25 words telling an AI when to use the tool: what it does to a slide, naming only those capabilities, no specific shapes, colors or layouts; end with "Returns a complete HTML page.">` }] }],
    maxOutputTokens: 2048,
  }, AbortSignal.any([signal, AbortSignal.timeout(45000)]));
  const field = (key) => text.match(new RegExp(`^\\W*${key}\\W*:\\s*(.+)$`, 'mi'))?.[1].replace(/[*`]/g, '').trim() || '';
  const name = field('Name').toLowerCase().replace(/\(\)$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'tool_$1').slice(0, 40);
  return { name: name.length >= 3 ? name : null, description: field('Description').slice(0, 300) || null, usage, modelVersion };
}

// A name and description may only claim capabilities the browser test verified.
const CLAIMS = {
  three_d: /\b3-?d\b|three[- ]dimensional/i,
  interactive: /interactiv|\bdrag|orbit|hover|click|rotat/i,
  colorful: /colou?rful|vivid|vibrant|rainbow|multicolou?r/i,
  animated: /animat|motion|moving|\bfloat|\bspin|pulsat/i,
};
const PHRASES = { three_d: 'as a 3D scene', interactive: 'that viewers can drag or hover to explore', colorful: 'in vivid, varied colors', animated: 'with gentle motion' };
function verifiedIdentity(identity, verified, request) {
  const unverified = (text) => Object.keys(CLAIMS).filter((key) => CLAIMS[key].test(text.replace(/_/g, ' ')) && !verified.includes(key));
  const phrases = verified.map((key) => PHRASES[key]);
  const fallbackName = `render_${verified.map((key) => ({ three_d: '3d', interactive: 'interactive', colorful: 'colorful', animated: 'animated' })[key]).slice(0, 2).join('_') || 'styled'}_slide`;
  const fallbackDescription = `Renders a slide's title, subtitle and milestones ${phrases.join(' and ') || `styled as requested ("${request.slice(0, 80)}")`}. Returns a complete HTML page.`;
  const name = identity.name && !unverified(identity.name).length ? identity.name : fallbackName;
  const description = identity.description && !unverified(identity.description).length ? identity.description : fallbackDescription;
  return { name, description, adjusted: [name !== identity.name && 'name', description !== identity.description && 'description'].filter(Boolean) };
}

// What a failed check means, as feedback for Hydrogen (null when the page passes).
function failureOf(check, features) {
  if (check.errors.length) return `the page has an error: ${check.errors[0]}`;
  if (check.missing.length) return `the page does not show this input text: ${check.missing.slice(0, 6).map((t) => `"${t}"`).join(', ')} (show every title, subtitle, label, theme and point exactly as given)`;
  if (check.issues.length) return `once it settles, ${check.issues.slice(0, 4).join('; ')} (fit everything inside the frame with margins, no card covering another; see Framing in AGENTS.md)`;
  for (const key of features) {
    const failure = FEATURES[key].fails(check);
    if (failure) return `${FEATURES[key].label} check failed: ${failure}`;
  }
  return null;
}

// Runs the code on Gemma's slide and on a different topic, then checks both pages in a real browser.
// Returns { failure (null if both pass), results } — results hold the measured values, shown in the UI.
async function testTool(code, content, features, step) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(CANDIDATE_FILE, code, 'utf8');
  const cases = [
    ...(content ? [{ key: 'slide', label: "Gemma's slide", args: content }] : []),
    { key: 'unseen', label: `a different topic ("${TOOL_SAMPLE.title}")`, args: TOOL_SAMPLE },
  ];
  step(`Test: rendering ${cases.map((c) => c.label).join(' and ')} in a browser`);
  const results = await Promise.all(
    cases.map(async ({ key, label, args }) => {
      const page = path.join(TEST_DIR, `${key}.html`);
      const node = await run(process.execPath, ['-e', TOOL_TEST, CANDIDATE_FILE, page, JSON.stringify(args)], { cwd: TOOLS_DIR, timeout: 10000 });
      if (node.error) return { key, label, failure: `running the tool failed: ${(node.stderr.split('\n').find((l) => /Error/.test(l)) || node.error.message).trim().slice(0, 300)}` };
      const remote = fs.readFileSync(page, 'utf8').match(/https?:\/\/(?!www\.w3\.org)[^\s"'<>)]+/);
      if (remote) return { key, label, failure: `the page loads ${remote[0]} from the internet (use only local files such as /vendor/three/)` };
      const check = await checkPage(`http://${HOST}:${PORT}/tool-test/${key}.html`, textsOf(args), { host: HOST });
      return { key, label, check, failure: failureOf(check, features) };
    })
  );
  const failed = results.find((r) => r.failure);
  return { failure: failed ? `With ${failed.label}: ${failed.failure}.` : null, results };
}

const run = (file, args, options) =>
  new Promise((resolve) => execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

const idleBuild = () => ({
  state: 'idle', request: null, phase: null, startedAt: null, finishedAt: null, error: null, steps: [], stages: {},
  decision: null, tool: null, proposed: null, verified: [], lines: 0, repairs: 0, tests: null,
});
const build = { models: MODELS, ...idleBuild() };
let buildRun = null; // { abort } while a build runs

function startBuild(prompt) {
  // Each build starts with no tools, so any tool Gemma finds afterwards was built (and tested) in this run.
  removeTools();
  fs.rmSync(TOOL_OUTPUT_DIR, { recursive: true, force: true });
  Object.assign(gemma.tool, idleJob());
  cancelEvaluation();
  Object.assign(build, { ...idleBuild(), models: JSON.parse(JSON.stringify(MODELS)), state: 'running', request: prompt, startedAt: Date.now() });

  const abort = new AbortController();
  const self = { abort };
  buildRun = self;
  const isCurrent = () => buildRun === self; // false once finished or cancelled by New run
  const log = (msg) => console.log(`[build +${((Date.now() - build.startedAt) / 1000).toFixed(1)}s] ${msg}`);
  const step = (text) => {
    if (!isCurrent()) return;
    build.steps.push({ at: Date.now() - build.startedAt, text });
    log(text);
  };
  // One row shows Hydrogen's latest thought heading, so thinking reads as a single milestone that updates in place.
  const thinkingRow = (thoughts) => {
    const headings = [...thoughts.matchAll(/\*\*(.+?)\*\*/g)];
    if (!headings.length || !isCurrent()) return;
    const text = `Hydrogen: ${headings[headings.length - 1][1]}`;
    const last = build.steps[build.steps.length - 1];
    if (text === last?.text) return;
    if (last?.thinking) Object.assign(last, { at: Date.now() - build.startedAt, text });
    else build.steps.push({ at: Date.now() - build.startedAt, text, thinking: true });
  };
  // Measured time per stage: decide, code, name (in parallel with code), test, install. Code and test add up over repairs.
  const begin = (key) => {
    const stage = (build.stages[key] ||= { ms: 0, runs: 0, since: null });
    Object.assign(stage, { since: Date.now(), runs: stage.runs + 1 });
    if (key !== 'name') build.phase = key;
  };
  const end = (key) => {
    const stage = build.stages[key];
    if (stage?.since) Object.assign(stage, { ms: stage.ms + Date.now() - stage.since, since: null });
  };
  const seen = new Set();
  const once = (key, text) => !seen.has(key) && seen.add(key) && step(text);

  // rejected: the request is outside what a slide tool can do (a deterministic check or the Decisions API).
  const finish = (error, rejected) => {
    if (!isCurrent()) return;
    buildRun = null;
    clearTimeout(timer);
    abort.abort();
    for (const key of Object.keys(build.stages)) end(key);
    if (!error && !rejected && !listTools().includes(build.tool?.name)) error = 'the tool was not installed';
    Object.assign(build, { state: rejected ? 'rejected' : error ? 'error' : 'done', phase: null, finishedAt: Date.now(), error: rejected || error });
    const stages = Object.entries(build.stages).map(([key, s]) => `${key} ${(s.ms / 1000).toFixed(1)}s`).join(', ');
    log(`${rejected ? `declined: ${rejected}` : error ? `error: ${error}` : `installed tools/${build.tool.name}.js`} (${stages}; total ${((build.finishedAt - build.startedAt) / 1000).toFixed(1)}s)`);
  };
  const timer = setTimeout(() => finish(`Timed out after ${BUILD_TIMEOUT_MS / 1000} s`), BUILD_TIMEOUT_MS);

  log(`start request=${JSON.stringify(prompt)}`);
  (async () => {
    const content = slideContent(RAW_FILE);

    // 1. Decide: a deterministic check first, then one Decisions API call.
    begin('decide');
    if (/https?:\/\/|www\.|\.(com|org|net|io)\b/i.test(prompt)) return 'Network access is not supported: a slide tool must work offline from the slide text alone.';
    step(`Asked ${MODELS.decide.name} whether a slide tool can do this`);
    const decision = await decide(prompt, abort.signal);
    end('decide');
    build.decision = decision;
    const confidence = `${Math.round(decision.confidence * 100)}%`;
    step(`Decision: ${decision.supported ? 'supported' : 'not supported'} (confidence ${confidence})${decision.supported ? ` · tests: ${['base', ...decision.features.map((key) => FEATURES[key].label)].join(', ')}` : ''}`);
    if (!decision.supported) return `${MODELS.decide.name} classified the request as unsupported (confidence ${confidence}): a slide tool can change how the slide's own text is presented, not the text, its data or other media.`;

    // 2 and 3 start together: Neon names the tool while Hydrogen designs and writes it.
    begin('name');
    step(`Asked ${MODELS.name.name} to name and describe the tool (in parallel)`);
    const naming = nameTool(prompt, decision.features, abort.signal).then(
      (identity) => {
        end('name');
        if (identity.modelVersion) build.models.name.id = identity.modelVersion;
        build.proposed = { name: identity.name, description: identity.description };
        log(`name usage ${JSON.stringify(identity.usage)}`);
        step(`Name: ${identity.name || '(none)'}() · ${identity.description || '(no description)'}`);
        return identity;
      },
      (err) => {
        end('name');
        step(`${MODELS.name.name} could not name the tool (${err.message}); it will be named from its verified capabilities`);
        return { name: null, description: null };
      }
    );

    begin('code');
    step(`Asked ${MODELS.code.name} to design and write the tool`);
    const required = ['base: no errors, all text exactly as given, nothing cut off or covered', ...decision.features.map((key) => FEATURES[key].rule)];
    const contents = [{ role: 'user', parts: [{ text: `User's request: ${prompt}
Required, and measured by the test: ${required.join('; ')}.
Gemma's slide (one of the test inputs): ${JSON.stringify(content || TOOL_SAMPLE)}
Reply with the module in a single \`\`\`js block.` }] }];
    const system = fs.readFileSync(AGENTS_FILE, 'utf8');
    let tested;
    for (let attempt = 0; ; attempt += 1) {
      const reply = await geminiStream(CODE_MODEL, CODE_THINKING, { system, contents, maxOutputTokens: 16384 }, abort.signal, thinkingRow, (text) => {
        if (!isCurrent()) return;
        const fence = text.indexOf('```');
        if (fence < 0) return;
        const code = text.slice(fence);
        build.lines = Math.max(0, code.split('\n').length - 2);
        for (const [pattern, label] of CODE_MILESTONES) if (pattern.test(code)) once(label, label);
        if (code.indexOf('```', 3) > 0) once(`complete:${attempt}`, `Code complete: ${code.split('\n').length - 2} lines`);
      });
      end('code');
      if (reply.modelVersion) build.models.code.id = reply.modelVersion;
      log(`code usage ${JSON.stringify(reply.usage)}`);
      const match = reply.text.match(/```(?:js|javascript)?[^\n]*\n([\s\S]*?)```/);
      begin('test');
      tested = match ? await testTool(match[1], content, decision.features, step) : { failure: 'Your reply had no ```js code block.', results: [] };
      end('test');
      if (!isCurrent()) return null;
      build.tests = tested.results.map(({ key, label, check, failure }) => {
        const n = textsOf(key === 'slide' ? content : TOOL_SAMPLE).length;
        return {
          key, label, failure, ms: check?.ms,
          values: check && [`${n - check.missing.length}/${n} texts shown`, `${check.issues.length} layout issues`, `${check.errors.length} errors`, ...decision.features.map((f) => `${FEATURES[f].label}: ${FEATURES[f].value(check)}`)],
        };
      });
      if (!tested.failure) {
        for (const t of build.tests) step(`Test passed (${t.label}): ${t.values.slice(3).join(', ') || 'base checks'} · ${(t.ms / 1000).toFixed(1)} s`);
        break;
      }
      step(`Test failed: ${tested.failure}`);
      if (attempt === MAX_REPAIRS) throw new Error(`the tool failed its test: ${tested.failure}`);
      build.repairs = attempt + 1;
      step(`Repair ${attempt + 1}: sending the failure back to ${MODELS.code.name}`);
      contents.push({ role: 'model', parts: [{ text: reply.text }] }, { role: 'user', parts: [{ text: `Testing your tool failed. ${tested.failure}\nFix it. Reply with the complete corrected module in a single \`\`\`js block.` }] });
      begin('code');
    }

    // Install under Neon's name, with a description that claims only capabilities the browser test verified.
    const identity = await naming;
    if (!isCurrent()) return null;
    build.verified = Object.keys(FEATURES).filter((key) => tested.results.every((r) => r.check && !FEATURES[key].fails(r.check)));
    const { name, description, adjusted } = verifiedIdentity(identity, build.verified, prompt);
    if (adjusted.length) step(`Adjusted the ${adjusted.join(' and ')} to claim only verified capabilities (${build.verified.map((key) => FEATURES[key].label).join(', ') || 'base checks'})`);
    build.tool = { name, description };
    begin('install');
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TOOLS_DIR, `${name}.json`), JSON.stringify({ name, description, parameters: TOOL_PARAMETERS }, null, 2) + '\n');
    fs.renameSync(CANDIDATE_FILE, path.join(TOOLS_DIR, `${name}.js`));
    end('install');
    step(`Installed tools/${name}.js and tools/${name}.json: Gemma can now discover ${name}()`);
    return null;
  })().then(
    (rejected) => {
      if (rejected && isCurrent()) step(`Not supported: ${rejected}`);
      finish(null, rejected);
    },
    (err) => finish(err.name === 'AbortError' ? 'cancelled' : err.message)
  ).finally(() => {
    if (!buildRun) fs.rmSync(CANDIDATE_FILE, { force: true });
  });
}

// --- Gemma runs: step 1 (baseline slide), step 3 (same request, with the tools found in tools/), and evaluation ---
const GEMMA_TIMEOUT_MS = 60000;
const idleJob = () => ({ state: 'idle', request: null, startedAt: null, finishedAt: null, error: null, summary: null, steps: [] });
const gemma = { slide: idleJob(), tool: idleJob() };
let gemmaChild = null;
// The current run: started by step 1 ("Create slide"), cleared by New run. The page uses it to reconnect after a refresh.
const current = { startedAt: null, request: null };
const RAW_FILE = path.join(PUBLIC_DIR, 'gemma-raw.html');
const EVAL_DIR = path.join(PUBLIC_DIR, 'eval');

// Everything a run generates: Gemma's slides, Gemini's tool, its output and the evaluation's slides.
function clearArtifacts() {
  for (const file of [ORIGINAL_FILE, RAW_FILE, CANDIDATE_FILE]) fs.rmSync(file, { force: true });
  removeTools();
  fs.rmSync(TOOL_OUTPUT_DIR, { recursive: true, force: true });
  fs.rmSync(EVAL_DIR, { recursive: true, force: true });
}

// New run: stop whatever runs (waiting for it to exit), then remove generated files and reset all state.
async function resetRun() {
  const children = [gemmaChild].filter(Boolean);
  buildRun?.abort.abort();
  gemmaChild = null;
  buildRun = null;
  cancelEvaluation();
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('close', resolve);
          child.kill('SIGTERM');
          setTimeout(resolve, 3000);
        })
    )
  );
  clearArtifacts();
  Object.assign(gemma.slide, idleJob());
  Object.assign(gemma.tool, idleJob());
  Object.assign(build, idleBuild());
  Object.assign(current, { startedAt: null, request: null });
  console.log(`[run] reset${children.length ? ` (stopped ${children.length} process${children.length > 1 ? 'es' : ''})` : ''}`);
}

// Runs gemma-generate.js once and resolves with its summary (rejects on failure; `cancelled` when New run stopped it).
function runGemma({ withTools, request, outDir, onMilestone }) {
  return new Promise((resolve, reject) => {
    const args = [path.join(__dirname, 'gemma-generate.js'), '--stream', ...(withTools ? ['--tools'] : []), ...(outDir ? [`--out=${outDir}`] : []), request];
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], timeout: GEMMA_TIMEOUT_MS });
    gemmaChild = child;
    let summary = null;
    let stderr = '';
    onLines(child.stdout, (line) => {
      try {
        const event = JSON.parse(line);
        if (event.milestone && gemmaChild === child) onMilestone?.(event.milestone);
        if (event.summary) summary = event.summary;
      } catch {
        // Not an event line.
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      if (gemmaChild !== child) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      gemmaChild = null;
      if (!error && !summary) error = 'Gemma harness returned no result';
      if (error) reject(new Error(error));
      else resolve(summary);
    };
    child.on('error', (err) => finish(`Could not start Gemma harness (${err.message})`));
    child.on('close', (code, signal) =>
      finish(code === 0 ? null : (stderr.trim().split('\n')[0] || `Gemma harness stopped (${signal || `exit ${code}`})`).slice(0, 200))
    );
  });
}

// kind 'slide' (step 1) starts a new run with the given request; kind 'tool' (step 3) retries that same request.
function startGemma(kind, request) {
  const job = gemma[kind];
  const withTools = kind === 'tool';
  cancelEvaluation();
  if (withTools) {
    fs.rmSync(TOOL_OUTPUT_DIR, { recursive: true, force: true });
  } else {
    // Step 1 starts the run over: the tool must then be built again, live, by Gemini.
    clearArtifacts();
    Object.assign(gemma.tool, idleJob());
    Object.assign(build, idleBuild());
    Object.assign(current, { startedAt: Date.now(), request });
  }
  Object.assign(job, { ...idleJob(), state: 'running', request: current.request, startedAt: Date.now() });
  runGemma({ withTools, request: current.request, onMilestone: (text) => job.steps.push({ at: Date.now() - job.startedAt, text }) }).then(
    (summary) => {
      Object.assign(job, { state: 'done', finishedAt: Date.now(), summary });
      console.log(`[gemma ${kind} ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s] done firstToken=${summary.firstTokenMs}ms gen=${summary.generationMs}ms tokens=${summary.completionTokens} toolCalls=${JSON.stringify(summary.toolCalls ?? null)}`);
    },
    (err) => {
      if (err.cancelled) return;
      Object.assign(job, { state: 'error', finishedAt: Date.now(), error: err.message });
      console.log(`[gemma ${kind}] error: ${err.message}`);
    }
  );
}

// --- Evaluation: the new tool on unseen slide requests, Gemma alone vs. Gemma with the tool, measured in a browser ---
const EVAL_REQUESTS = [
  'Create a 2027 hiring plan slide for a growing startup',
  'Create a cloud migration roadmap slide for a regional bank',
  'Create a slide on our 2027 sustainability goals',
];
const idleEvaluation = () => ({ state: 'idle', startedAt: null, finishedAt: null, error: null, now: null, tool: null, features: [], tasks: [] });
const evaluation = idleEvaluation();
let evalRun = null;

function cancelEvaluation() {
  if (evalRun && gemmaChild) gemmaChild.kill('SIGTERM');
  evalRun = null;
  Object.assign(evaluation, idleEvaluation());
  fs.rmSync(EVAL_DIR, { recursive: true, force: true });
}

// Measured results for one side (Gemma alone, or Gemma with the tool) of one task.
function sideResult(check, expected, features, extra) {
  return {
    ...extra,
    shown: expected.length - check.missing.length,
    expected: expected.length,
    issues: check.issues.slice(0, 3),
    issueCount: check.issues.length,
    errors: check.errors.slice(0, 2),
    interaction: check.interaction,
    features: Object.fromEntries(features.map((key) => [key, { pass: !FEATURES[key].fails(check), value: FEATURES[key].value(check) }])),
    checkMs: check.ms,
  };
}

function startEvaluation() {
  const token = {};
  evalRun = token;
  const isCurrent = () => evalRun === token;
  fs.rmSync(EVAL_DIR, { recursive: true, force: true });
  const features = build.decision?.features || [];
  const toolName = build.tool?.name;
  const requests = EVAL_REQUESTS.filter((request) => request.toLowerCase() !== String(current.request).toLowerCase());
  Object.assign(evaluation, {
    ...idleEvaluation(),
    state: 'running',
    startedAt: Date.now(),
    tool: toolName,
    features,
    tasks: [
      { key: 'original', request: current.request, unseen: false, alone: { state: 'pending' }, tool: { state: 'pending' } },
      ...requests.map((request, i) => ({ key: `task-${i + 1}`, request, unseen: true, alone: { state: 'pending' }, tool: { state: 'pending' } })),
    ],
  });
  const log = (msg) => console.log(`[eval +${((Date.now() - evaluation.startedAt) / 1000).toFixed(1)}s] ${msg}`);

  // Checks one page in the browser and records the result on the task's side.
  const check = async (task, side, url, expected, extra) => {
    try {
      const result = await checkPage(`http://${HOST}:${PORT}${url}`, expected, { host: HOST });
      if (!isCurrent()) return;
      task[side] = { state: 'done', url, ...sideResult(result, expected, features, extra) };
    } catch (err) {
      if (isCurrent()) task[side] = { state: 'error', error: `browser check failed: ${err.message}`, ...extra };
    }
  };
  // Gemma alone shows its own text (its labels come from CSS); with the tool, the text it passed to the tool.
  const aloneTexts = (content) => textsOf({ ...content, milestones: content.milestones.map((m) => m.split('|').slice(1).join('|')) });
  const toolSide = (summary, content) => {
    const call = summary.toolCalls?.[0];
    let args = null;
    try {
      args = call && JSON.parse(call.arguments);
    } catch {
      // Unparseable arguments: the harness would have failed already.
    }
    return {
      extra: { ms: summary.totalMs, called: call?.name || null, differences: summary.contentDifferences?.length ?? null },
      expected: args?.milestones ? textsOf(args) : aloneTexts(content),
    };
  };

  (async () => {
    // The original task reuses steps 1 and 3 (their pages are already on disk).
    const [original, ...unseen] = evaluation.tasks;
    const originalContent = slideContent(RAW_FILE);
    original.alone.state = original.tool.state = 'checking';
    evaluation.now = 'Checking the original task in a browser';
    const t = toolSide(gemma.tool.summary, originalContent);
    await Promise.all([
      check(original, 'alone', '/gemma-slide.html', aloneTexts(originalContent), { ms: gemma.slide.summary.totalMs }),
      check(original, 'tool', '/gemma-tool/index.html', t.expected, t.extra),
    ]);

    for (const [i, task] of unseen.entries()) {
      if (!isCurrent()) return;
      const dir = path.join(EVAL_DIR, task.key);
      const label = `Unseen task ${i + 1} of ${unseen.length}`;
      try {
        evaluation.now = `${label}: Gemma alone`;
        task.alone.state = 'running';
        const alone = await runGemma({ withTools: false, request: task.request, outDir: dir });
        task.alone.state = 'checking';
        evaluation.now = `${label}: Gemma with ${toolName}()`;
        task.tool.state = 'running';
        const withTool = await runGemma({ withTools: true, request: task.request, outDir: dir });
        task.tool.state = 'checking';
        evaluation.now = `${label}: checking both slides in a browser`;
        const content = slideContent(path.join(dir, 'gemma-raw.html'));
        const w = toolSide(withTool, content);
        await Promise.all([
          check(task, 'alone', `/eval/${task.key}/gemma-slide.html`, aloneTexts(content), { ms: alone.totalMs }),
          check(task, 'tool', `/eval/${task.key}/gemma-tool/index.html`, w.expected, w.extra),
        ]);
        log(`${task.key} alone ${alone.totalMs}ms, tool ${withTool.totalMs}ms called=${w.extra.called} diffs=${w.extra.differences}`);
      } catch (err) {
        if (err.cancelled || !isCurrent()) return;
        for (const side of ['alone', 'tool']) if (task[side].state !== 'done') task[side] = { state: 'error', error: err.message.slice(0, 200) };
        log(`${task.key} error: ${err.message}`);
      }
    }
    if (!isCurrent()) return;
    evalRun = null;
    Object.assign(evaluation, { state: 'done', finishedAt: Date.now(), now: null });
    log('done');
  })().catch((err) => {
    if (!isCurrent()) return;
    evalRun = null;
    Object.assign(evaluation, { state: 'error', finishedAt: Date.now(), now: null, error: err.message });
    log(`error: ${err.message}`);
  });
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

// Live stage timings: a running stage counts up to now.
const withLiveStages = (job) => ({
  ...job,
  stages: Object.fromEntries(Object.entries(job.stages).map(([key, s]) => [key, { ms: s.ms + (s.since ? Date.now() - s.since : 0), runs: s.runs, running: Boolean(s.since) }])),
});

async function sendStatus(res) {
  const [original, tool] = await Promise.all([
    fileSignature(ORIGINAL_FILE),
    dirSignature(TOOL_OUTPUT_DIR, TOOL_OUTPUT_ENTRY),
  ]);
  sendJson(res, 200, {
    now: Date.now(),
    active: Boolean(gemmaChild || buildRun || evalRun),
    run: current,
    original,
    tool,
    tools: listTools(),
    gemma,
    build: withLiveStages(build),
    evaluation,
    evaluationSize: EVAL_REQUESTS.filter((request) => request.toLowerCase() !== String(current.request).toLowerCase()).length,
  });
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

const validPrompt = (value) => {
  const prompt = String(value || '').trim();
  return prompt && prompt.length <= MAX_PROMPT_LENGTH && !prompt.startsWith('-') ? prompt : null;
};
const busy = () => Boolean(gemmaChild || buildRun || evalRun);

function handleImprove(req, res) {
  readJsonPost(req, res, (body) => {
    const prompt = validPrompt(body.prompt);
    if (!prompt) {
      sendText(res, 400, 'Invalid prompt');
      return;
    }
    if (busy() || gemma.slide.state !== 'done') {
      sendJson(res, 409, { build });
      return;
    }
    startBuild(prompt);
    sendJson(res, 202, { build });
  });
}

function handleGemma(req, res) {
  readJsonPost(req, res, (body) => {
    const kind = body.withTools === true ? 'tool' : 'slide';
    const request = kind === 'slide' ? validPrompt(body.prompt) : current.request;
    if (!request) {
      sendText(res, 400, 'Invalid prompt');
      return;
    }
    if (busy() || (kind === 'tool' && (build.state !== 'done' || !listTools().includes(build.tool?.name) || gemma.slide.state !== 'done'))) {
      sendJson(res, 409, { gemma });
      return;
    }
    startGemma(kind, request);
    sendJson(res, 202, { gemma });
  });
}

function handleEvaluate(req, res) {
  readJsonPost(req, res, () => {
    if (busy() || gemma.tool.state !== 'done' || !listTools().includes(build.tool?.name)) {
      sendJson(res, 409, { evaluation });
      return;
    }
    startEvaluation();
    sendJson(res, 202, { evaluation });
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
  if (req.method === 'POST' && route === '/api/evaluate') {
    handleEvaluate(req, res);
    return;
  }
  if (req.method === 'POST' && route === '/api/reset') {
    readJsonPost(req, res, () => resetRun().then(() => sendJson(res, 200, { reset: true }), () => sendText(res, 500, 'Reset failed')));
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
      'Cache-Control': result.cache ? 'public, max-age=86400' : 'no-store',
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
    buildRun?.abort.abort();
    if (gemmaChild) gemmaChild.kill('SIGTERM');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Agent Boost running at http://${HOST}:${PORT}`);
});
