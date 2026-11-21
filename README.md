# Agent Boost

Minimal local web app with a single 16:9 slide viewport ready for Gemma-generated HTML slides.

## Run Locally

```bash
node server.js
```

Open `http://127.0.0.1:3000` in your browser. Set `PORT` to use a different port (for example, `PORT=8080 node server.js`).

## Structure

- `server.js` — zero-dependency Node static server confined to `public/` (never serves `.env` or dotfiles)
- `public/index.html`, `public/styles.css`, `public/app.js` — plain HTML/CSS/JS single-screen 16:9 viewport
- `.gitignore` — prevents `.env` from being committed

## Rendering Slides (Ready for Step 2)

`window.AgentBoost` exposes:

- `renderSlideHtml(html)` — renders Gemma-generated HTML into the 16:9 iframe via `srcdoc`
- `renderSlideUrl(url)` — loads a saved slide URL into the 16:9 iframe
- `clearSlide()` — restores the `Ready for Gemma` state
