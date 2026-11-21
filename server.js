'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fs.realpathSync(path.resolve(__dirname, 'public'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(message);
}

function resolvePublicFile(requestUrl) {
  let pathname;
  try {
    const parsed = new URL(requestUrl, `http://${HOST}`);
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { error: 400 };
  }

  if (pathname.includes('\0')) {
    return { error: 400 };
  }

  const normalized = pathname.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Block path traversal and all dotfiles (including .env)
  if (segments.some((seg) => seg === '..' || seg.startsWith('.'))) {
    return { error: 404 };
  }

  const relativePath = segments.length === 0 ? 'index.html' : segments.join('/');
  const candidatePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!candidatePath.startsWith(PUBLIC_DIR + path.sep)) {
    return { error: 404 };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(candidatePath);
  } catch {
    return { error: 404 };
  }

  if (!realPath.startsWith(PUBLIC_DIR + path.sep)) {
    return { error: 404 };
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { error: 404 };
  }

  if (!stat.isFile()) {
    return { error: 404 };
  }

  return { filePath: realPath };
}

// Files the viewer watches. A signature changes whenever the content is rewritten.
const ORIGINAL_FILE = path.join(PUBLIC_DIR, 'gemma-slide.html');
const IMPROVED_DIR = path.join(PUBLIC_DIR, 'gemini');
const IMPROVED_ENTRY = path.join(IMPROVED_DIR, 'index.html');

async function fileSignature(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size > 0 ? `${Math.round(stat.mtimeMs)}-${stat.size}` : null;
  } catch {
    return null;
  }
}

// Covers every file under the improved slide's folder, so edits to its JS/CSS also trigger a reload.
async function dirSignature(dir, entry) {
  if (!(await fileSignature(entry))) return null;

  let maxMtime = 0;
  let totalSize = 0;
  let count = 0;
  const pending = [dir];

  while (pending.length > 0 && count < 500) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        pending.push(fullPath);
      } else if (dirent.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          maxMtime = Math.max(maxMtime, stat.mtimeMs);
          totalSize += stat.size;
          count += 1;
        } catch {
          // File vanished mid-scan; the next poll picks up the new state.
        }
      }
    }
  }

  return `${Math.round(maxMtime)}-${totalSize}-${count}`;
}

async function sendStatus(res) {
  const [original, improved] = await Promise.all([
    fileSignature(ORIGINAL_FILE),
    dirSignature(IMPROVED_DIR, IMPROVED_ENTRY),
  ]);
  const body = JSON.stringify({ original, improved });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/status') {
    sendStatus(res).catch(() => sendText(res, 500, 'Internal Server Error'));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const result = resolvePublicFile(req.url || '/');
  if (result.error) {
    sendText(res, result.error, result.error === 400 ? 'Bad Request' : 'Not Found');
    return;
  }

  const ext = path.extname(result.filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(result.filePath, (err, data) => {
    if (err) {
      sendText(res, 500, 'Internal Server Error');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Boost running at http://${HOST}:${PORT}`);
});
