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

  // --- Gemini Neon run (the server runs agy; the browser only starts it and shows progress) ---
  const form = document.getElementById('neon-form');
  const promptInput = document.getElementById('neon-prompt');
  const button = document.getElementById('neon-button');
  const statusEl = document.getElementById('neon-status');
  const improved = panels.find((panel) => panel.key === 'improved');
  const waitingTitle = improved.placeholder.querySelector('.placeholder-title');

  let neon = { state: 'idle' };
  let clickAt = null; // local click time, so elapsed time covers the full click-to-done path
  let ticker = null;

  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const runStart = () =>
    clickAt !== null && neon.startedAt - clickAt >= 0 && neon.startedAt - clickAt < 5000 ? clickAt : neon.startedAt;

  function renderNeon() {
    const running = neon.state === 'running';
    button.disabled = running;
    promptInput.disabled = running;
    waitingTitle.textContent = running ? 'Neon is working…' : 'Waiting for Gemini';

    // Neon may keep refining after the first write (the panel reloads each time), so "done" means agy finished.
    let label = '';
    if (running) label = `Working… ${seconds(Date.now() - runStart())}`;
    else if (neon.state === 'done') label = `Done in ${seconds(neon.finishedAt - runStart())}`;
    else if (neon.state === 'error') label = `Failed: ${neon.error}`;

    statusEl.dataset.state = neon.state;
    statusEl.textContent = label;
    statusEl.title = label;

    if (running && !ticker) ticker = setInterval(renderNeon, 100);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function applyNeon(next) {
    if (!next) return;
    neon = next;
    renderNeon();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (neon.state === 'running') return;
    clickAt = Date.now();
    button.disabled = true;
    try {
      const response = await fetch('/api/improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptInput.value }),
      });
      const data = await response.json().catch(() => null);
      applyNeon(data?.neon || { state: 'error', error: `request failed (${response.status})` });
    } catch {
      applyNeon({ state: 'error', error: 'server unreachable' });
    }
  });

  async function poll() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.ok) {
        const status = await response.json();
        applyNeon(status.neon);
        panels.forEach((panel) => apply(panel, status[panel.key] || null));
      }
    } catch {
      // Server briefly unavailable; keep showing the last good slides and retry.
    } finally {
      setTimeout(poll, POLL_MS);
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
