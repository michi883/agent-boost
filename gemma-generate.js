'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const GEMMA_URL = process.env.GEMMA_URL || 'http://127.0.0.1:8099';
const WITH_TOOLS = process.argv.includes('--tools');
// --stream: print progress milestones as NDJSON {"milestone"} lines and the summary as a final {"summary"} line.
const STREAM = process.argv.includes('--stream');
const seenMilestones = new Set();
function milestone(text) {
  if (!STREAM || seenMilestones.has(text)) return;
  seenMilestones.add(text);
  process.stdout.write(JSON.stringify({ milestone: text }) + '\n');
}

// Milestones read from what Gemma has generated so far: its choice of tool, the title, then each quarter's theme.
function trackMilestones(content, call) {
  if (call) {
    if (call.name) milestone(`Chose tool: ${call.name}`);
    const title = call.arguments.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (title) milestone(`Title: ${title[1]}`);
    for (const m of call.arguments.matchAll(/"([^"|]+?)\s*\|\s*([^"|]+?)\s*\|[^"]*"/g)) milestone(`${m[1]} · ${m[2]}`);
  } else {
    const title = content.match(/<h1>(.*?)<\/h1>/);
    if (title) milestone(`Title: ${title[1]}`);
    [...content.matchAll(/<h2>(.*?)<\/h2>/g)].forEach((m, i) => milestone(`Q${i + 1} · ${m[1]}`));
  }
}
const DEMO_PROMPT = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'Create a 2027 go-to-market roadmap slide';
const OUTPUT_PATH = path.resolve(__dirname, 'public', 'gemma-slide.html');
const RAW_OUTPUT_PATH = path.resolve(__dirname, 'public', 'gemma-raw.html');
const TOOLS_DIR = path.resolve(__dirname, 'tools');
const TOOL_OUTPUT_DIR = path.resolve(__dirname, 'public', 'gemma-tool');

// Fixed, reusable 16:9 frame. Gemma writes the slide body; this shell only supplies styling.
// Quarter labels (Q1-Q4) come from a CSS counter so Gemma doesn't spend tokens on them.
const BASE_SLIDE_CSS =
  '*{box-sizing:border-box;margin:0}body{height:100vh;padding:6vh 5vw;background:#0b1220;color:#f1f5f9;font:16px/1.45 system-ui;display:flex;flex-direction:column;justify-content:center;gap:4vh;overflow:hidden}h1{font-size:clamp(28px,5.2vh,54px);letter-spacing:-.02em}header p{margin-top:1vh;color:#94a3b8;font-size:clamp(14px,2.2vh,22px)}main{display:grid;grid-template-columns:repeat(4,1fr);gap:2vw;counter-reset:q}section{background:#162033;border-top:4px solid var(--a,#38bdf8);border-radius:10px;padding:3.2vh 2vw;display:flex;flex-direction:column;gap:1.4vh}section:nth-child(2){--a:#60a5fa}section:nth-child(3){--a:#818cf8}section:nth-child(4){--a:#a78bfa}section::before{counter-increment:q;content:"Q" counter(q);font-weight:700;color:var(--a,#38bdf8);font-size:clamp(12px,1.7vh,15px);letter-spacing:.06em}h2{font-size:clamp(18px,2.6vh,26px)}ul{padding-left:1.1em;color:#cbd5e1;font-size:clamp(13px,1.9vh,18px);display:flex;flex-direction:column;gap:.8vh}';

const SHELL_START = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_SLIDE_CSS}</style></head><body>`;
const SHELL_END = '</body></html>';

const SYSTEM_PROMPT =
  'Output ONLY minified HTML body markup, no prose or fences, in exactly this shape:\n' +
  '<header><h1>short title</h1><p>one-line subtitle</p></header><main>' +
  '<section><h2>1-2 word theme, no quarter label</h2><ul><li>2-3 words</li><li>2-3 words</li><li>2-3 words</li></ul></section>' +
  ' x4 (one per quarter, no attributes)</main>';

// With --tools, Gemma decides for itself whether a tool fits; the prompt never names one.
const TOOL_SYSTEM_PROMPT =
  'You create slides. When a provided tool can make the requested slide, call it. Otherwise o' + SYSTEM_PROMPT.slice(1);
// The retry continues the conversation that produced the original slide, so Gemma reuses its own content.
const RETRY_PROMPT = 'Make the same slide again. You now have tools; keep exactly the same text.';

function readOriginal() {
  try {
    return fs.readFileSync(RAW_OUTPUT_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Text of the original slide (Gemma's own markup) vs. the text Gemma passed to the tool.
function contentDifferences(raw, args) {
  const decode = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
  const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();
  const sections = [...raw.matchAll(/<section>([\s\S]*?)<\/section>/g)].map(([, html]) => ({
    theme: html.match(/<h2>(.*?)<\/h2>/)?.[1],
    points: [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => norm(m[1])).join(' | '),
  }));
  const milestones = (Array.isArray(args.milestones) ? args.milestones : []).map((m) => String(m).split('|').map((x) => x.trim()));
  const diffs = [];
  const check = (what, before, after) => norm(before) !== norm(after) && diffs.push(`${what}: "${norm(before)}" → "${norm(after)}"`);
  check('title', raw.match(/<h1>(.*?)<\/h1>/)?.[1], args.title);
  check('subtitle', raw.match(/<header>[\s\S]*?<p>(.*?)<\/p>/)?.[1], args.subtitle);
  if (milestones.length !== sections.length) diffs.push(`quarters: ${sections.length} → ${milestones.length}`);
  sections.forEach((section, i) => {
    const [, theme, ...points] = milestones[i] || [];
    check(`Q${i + 1} theme`, section.theme, theme);
    check(`Q${i + 1} points`, section.points, points.join(' | '));
  });
  return diffs;
}

// A tool is tools/<name>.json (OpenAI function schema: name, description, parameters) plus tools/<name>.js
// (module.exports = (args) => complete HTML page). Tools are discovered on every run, so adding the files adds the tool.
function loadTools() {
  let files;
  try {
    files = fs.readdirSync(TOOLS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json') && files.includes(file.replace(/\.json$/, '.js')))
    .map((file) => {
      const schema = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8'));
      const run = require(path.join(TOOLS_DIR, file.replace(/\.json$/, '.js')));
      if (schema.name !== path.basename(file, '.json') || typeof run !== 'function') {
        throw new Error(`Invalid tool ${file}: name must match the file and the module must export a function`);
      }
      return { schema, run };
    });
}

function extractBody(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)(?:```|$)/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function validBody(content, finishReason) {
  // The stop sequence strips the closing tag; restore it.
  const body = extractBody(content).replace(/(<\/main>)?\s*$/i, '</main>');
  const sections = (body.match(/<section>/gi) || []).length;
  if (finishReason === 'length' || !/<h1>/i.test(body) || !/<main>/i.test(body) || sections !== 4) {
    throw new Error(
      `Incomplete or invalid slide from Gemma (finishReason=${finishReason}, sections=${sections}, chars=${body.length})\n${content}`
    );
  }
  return body;
}

async function generateSlide() {
  const totalStart = performance.now();
  const tools = WITH_TOOLS ? loadTools() : [];
  if (WITH_TOOLS && tools.length === 0) throw new Error('No tools installed in tools/');
  const original = WITH_TOOLS ? readOriginal() : null;
  milestone(WITH_TOOLS ? `Same request, now offered: ${tools.map((tool) => tool.schema.name).join(', ')}` : 'Request sent to Gemma 31B');

  const response = await fetch(`${GEMMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 400,
      stop: ['</main>'],
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: WITH_TOOLS ? TOOL_SYSTEM_PROMPT : SYSTEM_PROMPT },
        { role: 'user', content: DEMO_PROMPT },
        ...(original ? [{ role: 'assistant', content: original }, { role: 'user', content: RETRY_PROMPT }] : []),
      ],
      ...(WITH_TOOLS && {
        tools: tools.map((tool) => ({ type: 'function', function: tool.schema })),
        tool_choice: 'auto',
      }),
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemma server error ${response.status}: ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let firstTokenMs = null;
  let usage = null;
  let timings = null;
  let finishReason = null;
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.usage) usage = parsed.usage;
      if (parsed.timings) timings = parsed.timings;
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const token = choice.delta?.content;
      const callDeltas = choice.delta?.tool_calls || [];
      if (firstTokenMs === null && (token || callDeltas.length)) firstTokenMs = performance.now() - totalStart;
      if (token) content += token;
      // Tool calls stream as fragments: the name first, then the JSON arguments piece by piece.
      for (const delta of callDeltas) {
        const call = (toolCalls[delta.index ?? 0] ||= { name: '', arguments: '' });
        call.name += delta.function?.name || '';
        call.arguments += delta.function?.arguments || '';
      }
      if (token || callDeltas.length) trackMilestones(content, toolCalls[0]);
    }
  }

  const generationMs = performance.now() - totalStart;
  let html;
  let toolMs = null;
  let differences = null;
  let outputPath = OUTPUT_PATH;

  if (!WITH_TOOLS) {
    html = SHELL_START + validBody(content, finishReason) + SHELL_END;
    fs.writeFileSync(RAW_OUTPUT_PATH, content, 'utf8');
    fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  } else {
    const call = toolCalls[0];
    if (call) {
      const tool = tools.find((t) => t.schema.name === call.name);
      if (!tool) throw new Error(`Gemma called an unknown tool: ${call.name}`);
      // Gemma's own string delimiter leaking through means the server mis-parsed the call and content was lost.
      if (call.arguments.includes('<|')) throw new Error(`Garbled arguments in ${call.name} call: ${call.arguments}`);
      let args;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        throw new Error(`Invalid JSON arguments in ${call.name} call: ${call.arguments}`);
      }
      if (original) {
        differences = contentDifferences(original, args);
        milestone(differences.length ? `Content differs from the original slide (${differences.length})` : 'Same text as the original slide');
      }
      const toolStart = performance.now();
      html = await tool.run(args);
      toolMs = performance.now() - toolStart;
      if (typeof html !== 'string' || !/<html[\s>]/i.test(html)) throw new Error(`${call.name} did not return an HTML page`);
      milestone(`${call.name} returned the slide (${(html.length / 1024).toFixed(1)} KB in ${toolMs.toFixed(1)} ms)`);
    } else {
      // Gemma chose not to use any tool and wrote the slide itself.
      html = SHELL_START + validBody(content, finishReason) + SHELL_END;
      milestone('Gemma wrote the slide itself (no tool call)');
    }
    outputPath = path.join(TOOL_OUTPUT_DIR, 'index.html');
  }

  const completionTokens = usage?.completion_tokens ?? null;
  const summary = {
    prompt: DEMO_PROMPT,
    outputPath,
    ...(WITH_TOOLS && {
      toolsOffered: tools.map((tool) => tool.schema.name),
      toolCalls, // exactly as Gemma emitted them (raw JSON arguments)
      toolMs: toolMs !== null ? Number(toolMs.toFixed(1)) : null,
      continuedFromOriginal: Boolean(original),
      contentDifferences: differences, // null when there was no tool call or no original to compare
    }),
    finishReason,
    bytes: Buffer.byteLength(html, 'utf8'),
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens,
    firstTokenMs: firstTokenMs !== null ? Number(firstTokenMs.toFixed(1)) : null,
    generationMs: Number(generationMs.toFixed(1)),
    tokensPerSec:
      completionTokens && generationMs > 0
        ? Number((completionTokens / (generationMs / 1000)).toFixed(1))
        : null,
    draftAccepted: timings?.draft_n_accepted ?? null,
    draftProposed: timings?.draft_n ?? null,
    totalMs: Number((performance.now() - totalStart).toFixed(1)),
  };

  if (WITH_TOOLS) {
    // The record goes first so the viewer's reload (triggered by index.html) sees a complete folder.
    fs.mkdirSync(TOOL_OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(TOOL_OUTPUT_DIR, 'run.json'), JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(outputPath, html, 'utf8');
  }
  console.log(STREAM ? JSON.stringify({ summary }) : JSON.stringify(summary, null, 2));
}

generateSlide().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
