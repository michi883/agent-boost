'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const GEMMA_URL = process.env.GEMMA_URL || 'http://127.0.0.1:8099';
const DEMO_PROMPT = process.argv[2] || 'Create a 2027 go-to-market roadmap slide';
const OUTPUT_PATH = path.resolve(__dirname, 'public', 'gemma-slide.html');
const RAW_OUTPUT_PATH = path.resolve(__dirname, 'public', 'gemma-raw.html');

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

function extractBody(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)(?:```|$)/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function generateSlide() {
  const totalStart = performance.now();

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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: DEMO_PROMPT },
      ],
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
      if (token) {
        if (firstTokenMs === null) firstTokenMs = performance.now() - totalStart;
        content += token;
      }
    }
  }

  const generationMs = performance.now() - totalStart;
  // The stop sequence strips the closing tag; restore it.
  const body = extractBody(content).replace(/(<\/main>)?\s*$/i, '</main>');
  const sections = (body.match(/<section>/gi) || []).length;

  if (finishReason === 'length' || !/<h1>/i.test(body) || !/<main>/i.test(body) || sections !== 4) {
    throw new Error(
      `Incomplete or invalid slide from Gemma (finishReason=${finishReason}, sections=${sections}, chars=${body.length})\n${content}`
    );
  }

  const html = SHELL_START + body + SHELL_END;
  fs.writeFileSync(RAW_OUTPUT_PATH, content, 'utf8');
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');

  const completionTokens = usage?.completion_tokens ?? null;
  console.log(
    JSON.stringify(
      {
        prompt: DEMO_PROMPT,
        outputPath: OUTPUT_PATH,
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
      },
      null,
      2
    )
  );
}

generateSlide().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
