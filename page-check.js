'use strict';

// Loads a slide page in headless Chrome, driven over the DevTools protocol, and measures what a viewer actually sees
// at 1280x720: rendering errors, whether every expected text is shown, cards or 3D milestone objects cut off at the
// edge or covering each other, its colors, whether it moves on its own, and whether real hover and drag input change
// it. Only the given server is reachable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1280;
const HEIGHT = 720;
const EDGE = 8; // a card or object closer than this to the slide edge counts as cut off

// Runs in the page before its own scripts: hooks Three.js (its devtools event) to see the scene and camera each frame
// renders, and defines the measurement the checker calls once the page has settled.
const PAGE_HOOK = `(() => {
const frames = new Map();
window.__THREE_DEVTOOLS__ = new EventTarget();
__THREE_DEVTOOLS__.addEventListener('observe', (event) => {
  const renderer = event.detail;
  if (!renderer || !renderer.isWebGLRenderer) return;
  const render = renderer.render;
  renderer.render = function (scene, camera) {
    if (scene && camera && camera.isCamera) frames.set(scene, camera);
    return render.call(this, scene, camera);
  };
});
// Screen rectangle of an object and its children (their geometry's bounding boxes, projected with the camera).
const project = (object, camera) => {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, behind = false;
  object.traverseVisible((child) => {
    const geometry = child.geometry;
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    for (let i = 0; i < 8; i += 1) {
      const p = child.position.clone().set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
      p.applyMatrix4(child.matrixWorld).project(camera);
      if (p.z > 1) behind = true;
      const x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  });
  return left === Infinity ? null : { left, top, right, bottom, behind };
};
const want = { list: [] };
const textItems = () => {
  const set = new Set(want.list);
  return [...document.querySelectorAll('body *')].filter((el) => !el.children.length && set.has(el.textContent.trim()))
    .map((el) => ({ el, text: el.textContent.trim(), r: el.getBoundingClientRect() }));
};
// Each text item's card: its nearest ancestor with a background, border or shadow.
const cardOf = (el) => {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (!/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor) || cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none') return node;
  }
  return el;
};
const cardsOf = (items) => [...new Set(items.map((item) => cardOf(item.el)))].filter((card) => card !== document.documentElement)
  .map((card) => ({ card, r: card.getBoundingClientRect(), text: items.find((item) => card.contains(item.el)).text }));
window.__abMeasure = (expected, edge) => {
  want.list = expected;
  const items = textItems();
  const shown = new Set();
  const issues = [];
  const out = (r, m) => r.left < m ? 'left' : r.right > innerWidth - m ? 'right' : r.top < m ? 'top' : r.bottom > innerHeight - m ? 'bottom' : null;
  for (const a of items) {
    const style = getComputedStyle(a.el);
    if (a.r.width < 1 || a.r.height < 1 || style.visibility === 'hidden') continue;
    shown.add(a.text);
    const side = out(a.r, -2);
    if (side) issues.push('"' + a.text + '" is cut off at the ' + side + ' edge');
  }
  const cards = cardsOf(items);
  for (const c of cards) {
    const side = c.r.width < innerWidth * 0.9 && out(c.r, edge);
    if (side) issues.push('the card with "' + c.text + '" is cut off at the ' + side + ' edge (' + Math.round(side === 'left' ? c.r.left : side === 'right' ? innerWidth - c.r.right : side === 'top' ? c.r.top : innerHeight - c.r.bottom) + ' px from it)');
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // Text is unreadable when another card covers a real part of it (touching edges or padding is fine).
  for (const item of items) {
    const own = cardOf(item.el);
    for (const other of cards) {
      if (other.card === own || other.card.contains(own) || own.contains(other.card)) continue;
      if (overlap(item.r, other.r) > 0.25 * item.r.width * item.r.height) issues.push('"' + item.text + '" is covered by the card with "' + other.text + '"');
    }
  }
  // 3D milestone objects (tagged userData.milestone) must be fully in frame.
  let objects = 0;
  let scenes = 0;
  for (const [scene, camera] of frames) {
    scenes += 1;
    scene.traverseVisible((object) => {
      if (typeof object.userData.milestone !== 'number') return;
      objects += 1;
      const r = project(object, camera);
      const side = r && (r.behind ? 'camera' : out(r, 0));
      if (side) issues.push('the 3D object of milestone ' + (object.userData.milestone + 1) + (side === 'camera' ? ' is behind the camera' : ' is cut off at the ' + side + ' edge'));
    });
  }
  return { issues: [...new Set(issues)], shown: [...shown], scenes, objects, canvas: Boolean(document.querySelector('canvas')),
    pos: items.flatMap((item) => [item.r.left, item.r.top]) };
};
// What hovering can change on the cards: position, size and styles.
window.__abSignature = () => JSON.stringify(cardsOf(textItems()).map(({ card, r }) => {
  const cs = getComputedStyle(card);
  return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), cs.transform, cs.backgroundColor, cs.boxShadow, cs.opacity, cs.color, cs.borderColor, cs.outlineStyle];
}));
// The center of the first milestone card (not the title's or subtitle's), to hover over.
window.__abFirstCard = () => {
  const card = cardsOf(textItems()).find((c) => c.text !== want.list[0] && c.text !== want.list[1] && c.r.width > 0);
  return card ? { x: Math.round(card.r.left + card.r.width / 2), y: Math.round(card.r.top + card.r.height / 2) } : null;
};
// Colorfulness of a screenshot: how many hue families (of 12) appear in vivid pixels, and their share of the slide.
window.__abColors = async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Array(12).fill(0);
  let vivid = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, gr, b), delta = max - Math.min(r, gr, b);
    if (max < 0.35 || delta / max < 0.45) continue;
    vivid += 1;
    const h = max === r ? ((gr - b) / delta + 6) % 6 : max === gr ? (b - r) / delta + 2 : (r - gr) / delta + 4;
    buckets[Math.floor(h * 2) % 12] += 1;
  }
  return { hues: buckets.filter((count) => count >= n * 0.004).length, vivid: Math.round((vivid / n) * 100) };
};
// A point to start a drag on: the 3D view itself, not a card or text.
window.__abDragPoint = () => {
  for (const [fx, fy] of [[0.5, 0.55], [0.5, 0.75], [0.3, 0.6], [0.7, 0.6], [0.5, 0.35], [0.2, 0.8], [0.8, 0.8]]) {
    const x = Math.round(innerWidth * fx), y = Math.round(innerHeight * fy);
    const el = document.elementFromPoint(x, y);
    if (el && (el.tagName === 'CANVAS' || !el.textContent.trim())) return { x, y };
  }
  return { x: innerWidth / 2, y: Math.round(innerHeight * 0.55) };
};
})();`;

// Minimal DevTools protocol client over one browser WebSocket (flattened page session).
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('error', () => reject(new Error('could not connect to Chrome')));
    ws.addEventListener('open', () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            pending.set(++nextId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: nextId, method, params, sessionId }));
          }),
        on: (fn) => listeners.add(fn),
        close: () => ws.close(),
      })
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// url: the page (on host:port, the only reachable server). expected: every text that must be shown.
// Returns { errors, missing, issues, canvas, scenes, objects, interaction, animated, colors, ms }.
async function checkPage(url, expected, { host = '127.0.0.1', timeoutMs = 20000 } = {}) {
  const started = Date.now();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-boost-check-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--window-size=${WIDTH},${HEIGHT}`,
    `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${host}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  const timer = setTimeout(() => chrome.kill('SIGKILL'), timeoutMs);
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let log = '';
      chrome.on('error', reject);
      chrome.on('close', () => reject(new Error('Chrome exited before the test')));
      chrome.stderr.on('data', (chunk) => {
        log += chunk;
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolve(match[1]);
      });
    });
    cdp = await connect(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const errors = [];
    let loaded;
    const load = new Promise((resolve) => (loaded = resolve));
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`${d.exception?.description?.split('\n')[0] || d.text} (line ${d.lineNumber + 1})`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon/.test(msg.params.entry.url || '')) {
        errors.push(msg.params.entry.text.slice(0, 200));
      } else if (msg.method === 'Page.loadEventFired') {
        loaded();
      }
    });
    await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Log.enable')]);
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOK });
    await send('Page.navigate', { url });
    await Promise.race([load, sleep(10000)]);

    const evaluate = async (expression, awaitPromise = false) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result.value;
    const measure = () => evaluate(`window.__abMeasure && __abMeasure(${JSON.stringify(expected)}, ${EDGE})`);
    // Judge the first settled view (text positions stable between samples), so intro animations don't count.
    await sleep(500);
    let m = await measure();
    for (let i = 0; i < 12; i += 1) {
      await sleep(300);
      const next = await measure();
      const settled = m && next && next.pos.length === m.pos.length && next.pos.every((v, j) => Math.abs(v - m.pos[j]) < 1.5);
      m = next;
      if (settled) break;
    }
    if (!m) throw new Error('the page did not load');

    const shot = async () => (await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 0.5 } })).data;
    const distance = (a, b) => (a.length && a.length === b.length ? a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / (a.length / 2) : 0);
    const positions = async () => (await measure()).pos;

    // Color and motion: two screenshots of the settled page, 400 ms apart with no input.
    const first = await shot();
    const colors = await evaluate(`__abColors(${JSON.stringify(`data:image/png;base64,${first}`)})`, true);
    const idleStart = await positions();
    await sleep(400);
    const second = await shot();
    const idle = distance(idleStart, await positions());
    const animated = first !== second;

    // Hover over the first milestone card: do its styles change (or, on a still page, any pixels)?
    let hovered = false;
    const card = await evaluate('__abFirstCard()');
    if (card) {
      const before = await evaluate('__abSignature()');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
      await sleep(250);
      hovered = (await evaluate('__abSignature()')) !== before || (!animated && (await shot()) !== second);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await sleep(150);
    }

    // Drag: how far the text moves on screen during a real mouse drag, against the same time left idle.
    const { x, y } = await evaluate('__abDragPoint()');
    const before = await positions();
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + i * 22, y: y + i * 4, button: 'left', buttons: 1 });
      await sleep(15);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 220, y: y + 40, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    const moved = distance(before, await positions());
    const dragged = moved >= 20 && moved > 3 * idle;

    const shown = new Set(m.shown);
    return {
      errors: [...new Set(errors)].slice(0, 5),
      missing: expected.filter((text) => !shown.has(text)),
      issues: m.issues,
      canvas: m.canvas,
      scenes: m.scenes,
      objects: m.objects,
      interaction: { dragged, moved: Math.round(moved), hovered, works: dragged || hovered },
      animated,
      colors,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    cdp?.close();
    chrome.kill('SIGKILL');
    fs.rm(profile, { recursive: true, force: true }, () => {});
  }
}

module.exports = { checkPage };
