# Agent Boost: Build Gemma a Tool

This repo runs a live demo. Gemma 31B, a local model, has made a plain roadmap slide. You build Gemma a reusable
tool that renders such slides as an interactive 3D visualization; Gemma then retries the same request and calls
your tool itself. Priorities: speed, visual impact, reliability.

When asked (e.g. "Integrate 3D visualization"), Gemma's current slide is included in the request. Reply with exactly:

1. One sentence: what the flat slide lacks, and the 3D idea your tool adds.
2. The complete `tools/make_3d_slide.js` in a single ```js code block, implementing the interface below. Nothing after it.

The server tests your code and installs it; Gemma then calls it.

## Speed

- Do not call any tools: no reading, writing, searching or commands. Everything you need is here and in the request.
- Minimal code, about 100 lines: one striking 3D idea done well beats many features.

## Interface (fixed, defined in `tools/make_3d_slide.json`)

A CommonJS module with no dependencies that exports one synchronous function:

```js
module.exports = function make_3d_slide({ title, subtitle, milestones }) { return '<!DOCTYPE html>…'; };
```

- `title`, `subtitle`: strings.
- `milestones`: 2–8 strings in order, each `"Label | Theme | point | point | point"` (e.g. `"Q1 | Theme | point | point | point"`).
  Split on `|` and trim; tolerate missing or extra points.
- Return a complete, self-contained HTML page and never throw. Embed the data with `JSON.stringify` and escape `<` as
  `<`; insert text with `textContent`, not `innerHTML`.

## The page it returns

- Its purpose is visual effectiveness: the roadmap should read better and look far more striking than a flat slide.
- It renders in a fixed 1280×720 iframe: fill the window exactly, with no scrollbars and nothing clipped.
- Show all content (title, subtitle, every milestone's label, theme and points), clearly readable, on a dark theme.
- Real 3D with real interaction: drag to orbit, plus motion or hover feedback.
- Render text as HTML (an overlay or `CSS2DRenderer`), not 3D text geometry or font files.
- Use Three.js 0.170.0 via an import map, and nothing else:
  - `three` → `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`
  - `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/`
- Addons are named imports, not members of `THREE`: `import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`,
  `import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'`, then `new CSS2DRenderer()`.
- It must run without errors on first load.
