(() => {
  'use strict';

  // Slides render at a fixed 1280x720 and are scaled to fit, so both panels lay out identically.
  const SLIDE_WIDTH = 1280;
  const POLL_MS = 400;

  const panels = [...document.querySelectorAll('.panel')].map((el) => ({
    key: el.dataset.panel,
    src: el.dataset.src,
    viewport: el.querySelector('.slide-viewport'),
    placeholder: el.querySelector('.slide-placeholder'),
    frame: el.querySelector('.slide-frame'),
    badge: el.querySelector('.status-badge'),
    signature: undefined,
  }));

  function setBadge(panel, state, label) {
    panel.viewport.dataset.state = state;
    panel.badge.dataset.state = state;
    panel.badge.textContent = label;
  }

  function showSlide(panel, signature) {
    panel.frame.src = `${panel.src}?v=${encodeURIComponent(signature)}`;
    panel.frame.hidden = false;
    panel.placeholder.hidden = true;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    setBadge(panel, 'loaded', `Updated ${time}`);
  }

  function clearSlide(panel) {
    panel.frame.src = 'about:blank';
    panel.frame.hidden = true;
    panel.placeholder.hidden = false;
    setBadge(panel, 'empty', 'Waiting');
  }

  function apply(panel, signature) {
    if (signature === panel.signature) return;
    panel.signature = signature;
    if (signature) showSlide(panel, signature);
    else clearSlide(panel);
  }

  // --- Three steps: Gemma creates a slide -> Neon builds a tool -> Gemma retries the same request with it ---
  // The server runs Gemma (llama.cpp) and Neon (agy); the browser only starts steps and shows their progress.
  const step = (name) => document.querySelector(`[data-step="${name}"]`);
  const steps = { slide: step('slide'), build: step('build'), tool: step('tool') };
  const buttons = { slide: steps.slide.querySelector('button'), build: steps.build.querySelector('button'), tool: steps.tool.querySelector('button') };
  const form = document.getElementById('neon-form');
  const promptInput = document.getElementById('neon-prompt');
  const placeholders = panels.map((panel) => {
    const title = panel.placeholder.querySelector('.placeholder-title');
    return { panel, title, waiting: title.textContent };
  });

  // --- Live progress: milestones from Gemma's output (steps 1 and 3) and Gemini's build (step 2) ---
  const live = Object.fromEntries(
    panels.map((panel) => {
      const el = panel.viewport.querySelector('.live');
      return [panel.key, { el, head: el.querySelector('.live-head'), list: el.querySelector('.live-steps'), key: '' }];
    })
  );

  function showLive(key, job, head) {
    const v = live[key];
    v.el.hidden = !job;
    if (!job) return;
    v.head.textContent = head;
    const steps = [...(job.steps || [])];
    if (job.state === 'error') steps.push({ at: job.finishedAt - job.startedAt, text: `Failed: ${job.error}`, failed: true });
    const signature = `${job.startedAt}|${job.state}|${steps.length}|${steps[steps.length - 1]?.text}`;
    if (signature === v.key) return;
    v.key = signature;
    v.list.replaceChildren(
      ...steps.map((step, i) => {
        const li = document.createElement('li');
        if (step.failed) li.className = 'failed';
        else if (job.state === 'running' && i === steps.length - 1) li.className = 'current';
        const time = document.createElement('time');
        time.textContent = seconds(step.at);
        li.append(time, step.text);
        return li;
      })
    );
  }

  const PHASES = { starting: 'Starting', thinking: 'Thinking', 'writing code': 'Writing code', testing: 'Testing' };

  let status = { gemma: { slide: { state: 'idle' }, tool: { state: 'idle' } }, neon: { state: 'idle' }, tools: [] };
  let ticker = null;

  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  function jobLabel(job) {
    if (job.state === 'running') return `Working… ${seconds(Date.now() - job.startedAt)}`;
    if (job.state === 'done') return `Done in ${seconds(job.finishedAt - job.startedAt)}`;
    if (job.state === 'error') return `Failed: ${job.error}`;
    return '';
  }

  function setStep(name, state, label) {
    steps[name].dataset.state = state;
    const el = steps[name].querySelector('.step-status');
    el.textContent = label;
    el.title = label;
  }

  function render() {
    const { gemma, neon, tools } = status;
    const gemmaBusy = gemma.slide.state === 'running' || gemma.tool.state === 'running';
    const neonBusy = neon.state === 'running';

    setStep('slide', gemma.slide.state, jobLabel(gemma.slide));

    // Step 2 is complete once a tool is installed in tools/; that is what Gemma discovers in step 3.
    if (neonBusy) setStep('build', 'running', `${PHASES[neon.phase] || 'Working'}… ${seconds(Date.now() - neon.startedAt)}`);
    else if (neon.state === 'error') setStep('build', 'error', jobLabel(neon));
    else if (tools.length) setStep('build', 'done', neon.state === 'done' ? `Built ${tools.join(', ')} · ${seconds(neon.finishedAt - neon.startedAt)}` : `Added ${tools.join(', ')}`);
    else setStep('build', 'idle', neon.state === 'done' ? 'No tool written' : '');

    const run = gemma.tool;
    if (run.state === 'done') {
      const called = (run.summary?.toolCalls || []).map((call) => call.name);
      setStep('tool', 'done', `${called.length ? `Called ${called.join(', ')}` : 'No tool call'} · ${seconds(run.finishedAt - run.startedAt)}`);
    } else {
      setStep('tool', run.state, run.state === 'idle' && !tools.length ? 'Needs a tool' : jobLabel(run));
    }

    buttons.slide.disabled = gemmaBusy;
    buttons.build.disabled = promptInput.disabled = neonBusy;
    buttons.tool.disabled = gemmaBusy || neonBusy || !tools.length;

    const panelJob = { original: gemma.slide, tool: gemma.tool };
    placeholders.forEach(({ panel, title, waiting }) => {
      title.textContent = panelJob[panel.key].state === 'running' ? 'Gemma is working…' : waiting;
    });

    const slideLive = gemma.slide.state === 'running' || (gemma.slide.state === 'error' && !status.original);
    showLive('original', slideLive && gemma.slide, 'Gemma 31B is creating the slide');
    // Right panel: Gemma's retry while step 3 runs; otherwise Gemini's build until a Gemma + tool slide exists.
    if (run.state === 'running') showLive('tool', run, 'Gemma 31B is retrying with the new tool');
    else if (!status.tool && run.state === 'error') showLive('tool', run, 'Gemma 31B with the new tool');
    else if (!status.tool && neon.state !== 'idle') showLive('tool', neon, `${neon.model} is ${neon.state === 'running' ? 'building' : 'done building'} make_3d_slide`);
    else showLive('tool', null);

    const running = gemmaBusy || neonBusy;
    if (running && !ticker) ticker = setInterval(render, 100);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  async function refresh() {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) return;
    const next = await response.json();
    status = next;
    render();
    panels.forEach((panel) => apply(panel, next[panel.key] || null));
  }

  async function start(name, url, body) {
    buttons[name].disabled = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok && response.status !== 409) throw new Error(`request failed (${response.status})`);
      await refresh();
    } catch (err) {
      setStep(name, 'error', `Failed: ${err.message === 'Failed to fetch' ? 'server unreachable' : err.message}`);
    }
  }

  buttons.slide.addEventListener('click', () => start('slide', '/api/gemma', { withTools: false }));
  buttons.tool.addEventListener('click', () => start('tool', '/api/gemma', { withTools: true }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    start('build', '/api/improve', { prompt: promptInput.value });
  });

  async function poll() {
    try {
      await refresh();
    } catch {
      // Server briefly unavailable; keep showing the last good slides and retry.
    } finally {
      // Poll faster while something runs so streamed text appears smoothly.
      const { gemma, neon } = status;
      const busy = [gemma.slide, gemma.tool, neon].some((job) => job.state === 'running');
      setTimeout(poll, busy ? 150 : POLL_MS);
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
