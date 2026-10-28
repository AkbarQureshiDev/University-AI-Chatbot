const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const model = require('./model-client');

const ROOT = __dirname;
const HOST = process.env.DEV_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}
loadDotEnv();

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  if (Buffer.isBuffer(payload)) res.end(payload);
  else res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        req.resume();
        return;
      }
      if (!tooBig) parts.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error('Question text is too long.');
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(parts).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 200_000));
  } catch (err) {
    return send(res, err.status || 400, { error: err.status === 413 ? err.message : 'The request was not valid JSON.' });
  }
  const { status, payload } = await model.ask(body);
  return send(res, status, payload);
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 404, { error: 'Not found.' }, { 'Content-Type': 'text/plain' });
  const ext = path.extname(target).toLowerCase();
  if (path.basename(target).startsWith('.env') || !TYPES[ext] || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return send(res, 404, { error: 'Not found.' }, { 'Content-Type': 'text/plain' });
  }
  send(res, 200, fs.readFileSync(target), { 'Content-Type': TYPES[ext] });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/api/chat') {
    if (req.method === 'GET') return send(res, 200, model.status());
    if (req.method === 'POST') return handleChat(req, res);
    return send(res, 405, { error: 'Method not allowed.' }, { 'Content-Type': 'text/plain' });
  }
  if (req.method === 'GET') return serveStatic(pathname, res);
  send(res, 405, { error: 'Method not allowed.' }, { 'Content-Type': 'text/plain' });
});

server.listen(PORT, HOST, () => {
  console.log(`University chatbot running at http://localhost:${PORT}`);
  console.log(model.status().hasToken ? 'Model answers: ready (token loaded).' : 'Model answers: NO TOKEN — the app will still show the matching document passages.');
});
