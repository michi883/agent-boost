# Agent Boost: Live Slide Improvement

This repo runs a live demo. Gemma 31B has just generated a roadmap slide; you improve it on stage.
Priorities: speed (~10 seconds), visual impact, reliability.

When asked to improve the slide (e.g. "Integrate 3D visualization"):

1. Read `public/gemma-slide.html`. It is the only file you need. Never modify it.
2. Write one self-contained file, `public/gemini/index.html`: the same roadmap transformed into an impressive, interactive 3D visualization.
3. Stop. The viewer reloads automatically when the file appears.

## Speed

- Exactly two tool calls: one read, one write. Do not explore the repo, run commands, install packages, start servers, open a browser, or re-read your output.
- Write the whole file in a single write. Keep it compact (about 200 lines).
- Reply with one short sentence when done.

## Requirements

- It renders in a fixed 1280×720 iframe: fill the window exactly, with no scrollbars and nothing clipped.
- Keep all of the slide's actual content (title, subtitle, every quarter and bullet), clearly readable, on a dark theme.
- Real 3D with real interaction: drag to orbit, plus motion or hover feedback. It must look striking at first glance.
- Render text as HTML (an overlay or `CSS2DRenderer`), not 3D text geometry or font files.
- Use Three.js 0.170.0 via an import map, and nothing else:
  - `three` → `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`
  - `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/`
- It must run without errors on first load.
