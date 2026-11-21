# Agent Boost: Build Gemma a Tool

This repo runs a live demo. Gemma 31B, a local model, has made a plain roadmap slide. You build Gemma a reusable tool,
`make_3d_slide`, that renders such slides as an interactive 3D visualization designed the way the user's request asks.
Gemma then retries its slide and calls your tool itself. Priorities: follow the request, speed, visual impact, reliability.

Each request gives you the user's request and Gemma's current slide.

## First: is the request supported?

The tool's interface is fixed (below): it receives a title, a subtitle and milestones, and returns one self-contained
interactive 3D HTML page.

- Supported: anything about how that content is presented in 3D: visual metaphor, layout, shapes, colors, lighting,
  motion, interaction, emphasis, mood.
- Not supported: anything this interface cannot do, such as new, changed or translated text or data (numbers, charts
  of values), other inputs or outputs (images, video, audio, files, other kinds of slides), network access or live
  data, or changes to Gemma or this app.

If the request is not supported, reply with exactly one line and nothing else:
`UNSUPPORTED: <one sentence on what is not possible and why>`

## Otherwise, reply with exactly

1. One sentence: how your tool realizes the user's request (name the specific idea taken from the request).
2. The complete `tools/make_3d_slide.js` in a single ```js code block. Nothing after it.

Design the tool from the request, not from a template: a different request should produce a visibly different design.
The server renders your page in a browser (offline), checks that all text is shown and readable, and installs it only
if it works; otherwise it sends you the exact problem to fix.

## Speed

- Do not call any tools: no reading, writing, searching or commands. Everything you need is here and in the request.
- Minimal code, about 120 lines: one striking 3D idea done well beats many features.

## Interface (fixed, defined in `tools/make_3d_slide.json`)

A CommonJS module with no dependencies that exports one synchronous function:

```js
module.exports = function make_3d_slide({ title, subtitle, milestones }) { return '<!DOCTYPE html>…'; };
```

- `title`, `subtitle`: strings.
- `milestones`: 2–8 strings in order, each `"Label | Theme | point | point | point"` (e.g. `"Q1 | Theme | point | point | point"`).
  Split on `|` and trim; tolerate missing or extra points.
- Return a complete, self-contained HTML page and never throw. Embed the data with `JSON.stringify` and escape `<` as
  `\u003c`; insert text with `textContent`, not `innerHTML`.

## The page it returns

- It renders in a fixed 1280×720 iframe: fill the window exactly, with no scrollbars and nothing clipped.
- Light theme: a white or very light background, dark readable text, and vivid, saturated colors for the 3D objects.
- Large and engaging: frame the camera so the visualization fills most of the slide (the milestones span at least 80% of
  the width), with label cards big enough to read when projected (points at least 15px, themes at least 20px). At the
  first view every card must be fully inside the frame and must not overlap another card (the server measures this).
- Show all of the content exactly as given: title, subtitle, and every milestone's label, theme and points. Never add,
  drop or reword text.
- Real 3D with real interaction: drag to orbit, plus motion or hover feedback.
- Render text as HTML (an overlay or `CSS2DRenderer`), not 3D text geometry or font files.
- Use Three.js 0.170.0, served locally by this app, via an import map, and nothing else (the page must work offline):
  - `three` → `/vendor/three/build/three.module.js`
  - `three/addons/` → `/vendor/three/examples/jsm/`
- Addons are named imports, not members of `THREE`: `import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`,
  `import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'`, then `new CSS2DRenderer()`.
- It must run without errors on first load.
