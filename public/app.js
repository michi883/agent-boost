(() => {
  'use strict';

  const DEFAULT_SLIDE_URL = '/gemma-slide.html';

  const viewport = document.getElementById('slide-viewport');
  const placeholder = document.getElementById('slide-placeholder');
  const frame = document.getElementById('slide-frame');
  const statusBadge = document.getElementById('viewport-status');

  let currentSource = null;

  function setState(state, label) {
    viewport.dataset.state = state;
    if (statusBadge) {
      statusBadge.dataset.state = state;
      statusBadge.textContent = label;
    }
  }

  /**
   * Render a complete Gemma-generated HTML document inside the 16:9 slide viewport.
   */
  function renderSlideHtml(html) {
    if (typeof html !== 'string' || html.trim() === '') {
      clearSlide();
      return false;
    }

    frame.removeAttribute('src');
    frame.srcdoc = html;
    frame.hidden = false;
    placeholder.hidden = true;
    currentSource = { type: 'html' };
    setState('loaded', 'Slide Loaded');
    return true;
  }

  /**
   * Render a saved HTML slide by URL inside the 16:9 slide viewport.
   */
  function renderSlideUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
      clearSlide();
      return false;
    }

    frame.removeAttribute('srcdoc');
    frame.src = url;
    frame.hidden = false;
    placeholder.hidden = true;
    currentSource = { type: 'url', url };
    setState('loaded', 'Slide Loaded');
    return true;
  }

  /**
   * Reset the viewport to the initial "Ready for Gemma" state.
   */
  function clearSlide() {
    if (currentSource !== null) {
      frame.removeAttribute('srcdoc');
      frame.src = 'about:blank';
    }

    frame.hidden = true;
    placeholder.hidden = false;
    currentSource = null;
    setState('empty', '16:9 Viewport');
  }

  /**
   * Automatically load public/gemma-slide.html if present.
   */
  async function loadDefaultSlide() {
    try {
      const response = await fetch(DEFAULT_SLIDE_URL, {
        method: 'HEAD',
        cache: 'no-store',
      });

      if (!response.ok) {
        clearSlide();
        return false;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && Number(contentLength) === 0) {
        clearSlide();
        return false;
      }

      return renderSlideUrl(DEFAULT_SLIDE_URL);
    } catch {
      clearSlide();
      return false;
    }
  }

  function hasSlide() {
    return currentSource !== null;
  }

  window.AgentBoost = Object.freeze({
    renderSlideHtml,
    renderSlideUrl,
    loadDefaultSlide,
    clearSlide,
    hasSlide,
  });

  clearSlide();
  loadDefaultSlide();
})();
