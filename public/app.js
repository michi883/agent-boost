(() => {
  'use strict';

  // Slides render at a fixed 1280x720 and are scaled to fit, so both panels lay out identically.
  const SLIDE_WIDTH = 1280;
  const POLL_MS = 400;
  const GEMMA_REQUEST = 'Create a 2027 go-to-market roadmap slide';

  const panels = [...document.querySelectorAll('.panel')].map((el) => ({
    key: el.dataset.panel,
    src: el.dataset.src,
    viewport: el.querySelector('.slide-viewport'),
    placeholder: el.querySelector('.slide-placeholder'),
    frame: el.querySelector('.slide-frame'),
    signature: undefined,
  }));

  function apply(panel, signature) {
    if (signature === panel.signature) return;
    panel.signature = signature;
    panel.frame.src = signature ? `${panel.src}?v=${encodeURIComponent(signature)}` : 'about:blank';
    panel.frame.hidden = !signature;
    panel.placeholder.hidden = Boolean(signature);
  }

  // --- Three steps: Gemma creates a slide -> Gemini builds a tool -> Gemma retries with it ---
  // The server runs Gemma (llama.cpp) and Gemini (agy); the browser only starts steps and shows their progress.
  const steps = Object.fromEntries(
    ['slide', 'build', 'tool'].map((name) => {
      const el = document.querySelector(`[data-step="${name}"]`);
      const $ = (selector) => el.querySelector(selector);
      return [name, { el, button: $('button'), sub: $('.step-sub'), status: $('.step-status') }];
    })
  );
  const GEMINI_PROMPT = steps.build.el.dataset.prompt;
  const hint = document.getElementById('hint');
  const toolCtx = document.getElementById('tool-ctx');

  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const elapsed = (job) => seconds((job.state === 'running' ? Date.now() : job.finishedAt) - job.startedAt);
  const lastStep = (job, fallback) => job.steps?.[job.steps.length - 1]?.text || fallback;

  // ready: the step's result exists (also after a server restart, when its job is idle again).
  function stepState(job, ready) {
    if (job.state === 'running' || job.state === 'error') return job.state;
    return job.state === 'done' || ready ? 'done' : 'idle';
  }

  function setStep(name, { state, sub, next, disabled, job }) {
    const s = steps[name];
    s.el.dataset.state = state;
    s.el.classList.toggle('next', next);
    s.button.disabled = disabled;
    s.sub.textContent = sub;
    s.sub.title = sub;
    s.status.textContent =
      state === 'running' || (state === 'done' && job.state === 'done') ? elapsed(job) : state === 'error' ? 'Retry' : next ? 'Start' : '';
  }

  // --- Live progress inside a slide viewport ---
  const live = Object.fromEntries(
    panels.map((panel) => {
      const el = panel.viewport.querySelector('.live');
      return [panel.key, { el, head: el.querySelector('.live-head'), phases: el.querySelector('.live-phases'), list: el.querySelector('.live-steps'), key: '' }];
    })
  );

  function showLive(key, view) {
    const v = live[key];
    v.el.hidden = !view;
    if (!view) return;
    const { job, owner, head, phases } = view;
    v.el.dataset.owner = owner;
    v.el.classList.toggle('running', job.state === 'running');
    v.head.textContent = head;
    const rows = [...(job.steps || [])];
    if (job.state === 'error') rows.push({ at: job.finishedAt - job.startedAt, text: `Failed: ${job.error}`, failed: true });
    const signature = JSON.stringify([job.startedAt, job.state, rows.length, rows[rows.length - 1]?.text, phases]);
    if (signature === v.key) return;
    v.key = signature;
    v.phases.hidden = !phases;
    v.phases.replaceChildren(
      ...(phases || []).map((phase) => Object.assign(document.createElement('li'), { className: phase.state, textContent: phase.text }))
    );
    v.list.replaceChildren(
      ...rows.map((row, i) => {
        const li = document.createElement('li');
        if (row.failed) li.className = 'failed';
        else if (job.state === 'running' && i === rows.length - 1) li.className = 'current';
        li.append(Object.assign(document.createElement('time'), { textContent: seconds(row.at) }), row.text);
        return li;
      })
    );
  }

  // Gemini's build as five stages, each marked done by a milestone the server reported.
  function geminiPhases(neon) {
    const has = (prefix) => neon.steps.some((row) => row.text.startsWith(prefix));
    const stages = [
      ['Think', Boolean(neon.plan)],
      ['Plan', Boolean(neon.plan)],
      [neon.lines ? `Code · ${neon.lines} lines` : 'Code', has('Code complete')],
      [neon.steps.some((row) => row.text.startsWith('Repair')) ? 'Test · repaired' : 'Test', has('Test passed') || has('Browser test skipped')],
      ['Install', has('Installed')],
    ];
    const current = stages.findIndex(([, done]) => !done);
    const active = { running: 'current', error: 'failed' }[neon.state] || '';
    return stages.map(([text, done], i) => ({ text, state: done ? 'done' : i === current ? active : '' }));
  }

  const BUILD_PHASES = { starting: 'Starting…', thinking: 'Thinking…', testing: 'Testing the tool…', repairing: 'Fixing a failed test…' };

  let status = { gemma: { slide: { state: 'idle' }, tool: { state: 'idle' } }, neon: { state: 'idle', steps: [] }, tools: [] };
  let ticker = null;

  function render() {
    const { gemma, neon, tools } = status;
    const original = gemma.slide;
    const retry = gemma.tool;
    const model = neon.modelName || 'Gemini';
    const hasOriginal = Boolean(status.original);
    const hasTool = tools.length > 0;
    const hasResult = Boolean(status.tool);
    const gemmaBusy = original.state === 'running' || retry.state === 'running';
    const busy = gemmaBusy || neon.state === 'running';
    const next = busy ? null : !hasOriginal ? 'slide' : !hasTool ? 'build' : !hasResult ? 'tool' : null;

    // Step 1
    const s1 = stepState(original, hasOriginal);
    setStep('slide', {
      state: s1,
      job: original,
      next: next === 'slide',
      disabled: busy,
      sub: s1 === 'running' ? lastStep(original, 'Writing…') : s1 === 'error' ? original.error : `“${GEMMA_REQUEST}”`,
    });

    // Step 2: complete once a tested tool is installed in tools/ (that is what Gemma discovers in step 3).
    const s2 = stepState(neon, hasTool);
    setStep('build', {
      state: s2,
      job: neon,
      next: next === 'build',
      disabled: busy || !hasOriginal,
      sub:
        s2 === 'running'
          ? neon.phase === 'writing code' ? `Writing code · ${neon.lines} lines` : BUILD_PHASES[neon.phase] || 'Working…'
          : s2 === 'error' ? neon.error
          : s2 === 'done' ? 'make_3d_slide() tested and installed'
          : `“${GEMINI_PROMPT}”`,
    });

    // Step 3
    const calls = retry.summary?.toolCalls || [];
    const differences = retry.summary?.contentDifferences;
    const s3 = stepState(retry, hasResult);
    setStep('tool', {
      state: s3,
      job: retry,
      next: next === 'tool',
      disabled: busy || !hasTool || !hasOriginal,
      sub:
        s3 === 'running' ? lastStep(retry, 'Deciding…')
          : s3 === 'error' ? retry.error
          : s3 === 'done' && retry.state === 'done'
            ? calls.length
              ? `Called make_3d_slide() · ${differences?.length ? `${differences.length} text changes` : 'same text ✓'}`
              : 'Answered without the tool'
          : hasTool ? 'Same request · Gemma decides whether to use it'
          : 'Needs the tool from step 2',
    });

    toolCtx.textContent = hasTool || neon.state !== 'idle' ? `tool built by ${model}${neon.state === 'done' ? ` in ${elapsed(neon)}` : ''}` : `tool to be built by ${model}`;

    // Live progress: left while Gemma writes the original; right while Gemini builds or Gemma retries.
    const slideLive = original.state === 'running' || (original.state === 'error' && !hasOriginal);
    showLive('original', slideLive && { job: original, owner: 'gemma', head: 'Gemma 31B is writing the slide' });
    if (retry.state === 'running' || (retry.state === 'error' && !hasResult)) {
      showLive('tool', { job: retry, owner: 'gemma', head: 'Gemma 31B retries, now with make_3d_slide() available' });
    } else if (!hasResult && neon.state !== 'idle') {
      const head = neon.state === 'running' ? `${model} is building make_3d_slide()` : `${model} built make_3d_slide()`;
      showLive('tool', { job: neon, owner: 'gemini', head, phases: geminiPhases(neon) });
    } else {
      showLive('tool', null);
    }

    renderHint({ original, retry, neon, model, hasOriginal, hasTool, hasResult, calls, differences });

    if (busy && !ticker) ticker = setInterval(render, 100);
    if (!busy && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function renderHint({ original, retry, neon, model, hasOriginal, hasTool, hasResult, calls, differences }) {
    let text;
    let error = false;
    if (original.state === 'running') text = 'Gemma 31B is writing the slide on this laptop.';
    else if (neon.state === 'running') text = `${model} writes make_3d_slide(), a reusable tool that turns a roadmap into an interactive 3D slide. The server tests it before Gemma can use it.`;
    else if (retry.state === 'running') text = 'Gemma retries the same request. It now sees make_3d_slide() among its tools and decides on its own whether to call it.';
    else if (original.state === 'error' || neon.state === 'error' || retry.state === 'error') {
      const [step, job] = original.state === 'error' ? [1, original] : neon.state === 'error' ? [2, neon] : [3, retry];
      text = `Step ${step} failed: ${job.error}. Click it to try again.`;
      error = true;
    } else if (!hasOriginal) text = 'Start with step 1: Gemma 31B, running locally on this laptop, makes a slide from a one-line request.';
    else if (!hasTool) text = `Gemma's slide is flat. Step 2: ${model} builds Gemma a reusable tool that renders roadmaps in interactive 3D.`;
    else if (!hasResult) text = 'The tool is tested and installed. Step 3: Gemma retries the same request and can now choose to use it.';
    else if (retry.state !== 'done') text = 'Drag the 3D slide to orbit it.';
    else if (!calls.length) text = 'Gemma answered without calling the tool.';
    else if (differences?.length) text = `Gemma called make_3d_slide() itself, with ${differences.length} text changes from its original slide. Drag the 3D slide to orbit it.`;
    else text = 'Gemma called make_3d_slide() itself, passing exactly the text of its original slide. Drag the 3D slide to orbit it.';
    hint.textContent = text;
    hint.title = text;
    hint.classList.toggle('error', error);
  }

  async function refresh() {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) return;
    status = await response.json();
    render();
    panels.forEach((panel) => apply(panel, status[panel.key] || null));
  }

  async function start(name, url, body) {
    steps[name].button.disabled = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok && response.status !== 409) throw new Error(`request failed (${response.status})`);
      await refresh();
    } catch (err) {
      hint.textContent = `Could not start step: ${err.message === 'Failed to fetch' ? 'server unreachable' : err.message}`;
      hint.classList.add('error');
    }
  }

  steps.slide.button.addEventListener('click', () => start('slide', '/api/gemma', { withTools: false }));
  steps.build.button.addEventListener('click', () => start('build', '/api/improve', { prompt: GEMINI_PROMPT }));
  steps.tool.button.addEventListener('click', () => start('tool', '/api/gemma', { withTools: true }));

  async function poll() {
    try {
      await refresh();
    } catch {
      // Server briefly unavailable; keep showing the last good slides and retry.
    } finally {
      const { gemma, neon } = status;
      const running = [gemma.slide, gemma.tool, neon].some((job) => job.state === 'running');
      setTimeout(poll, running ? 150 : POLL_MS);
    }
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const frame = entry.target.querySelector('.slide-frame');
      frame.style.transform = `scale(${entry.contentRect.width / SLIDE_WIDTH})`;
    }
  });
  panels.forEach((panel) => resizeObserver.observe(panel.viewport));

  poll();
})();
