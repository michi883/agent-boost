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

  async function poll() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.ok) {
        const status = await response.json();
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
