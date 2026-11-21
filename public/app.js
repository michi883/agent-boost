(() => {
  'use strict';

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

  function hasSlide() {
    return currentSource !== null;
  }

  window.AgentBoost = Object.freeze({
    renderSlideHtml,
    renderSlideUrl,
    clearSlide,
    hasSlide,
  });

  clearSlide();
})();
