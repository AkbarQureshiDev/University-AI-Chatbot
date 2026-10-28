const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM = process.env.HF_BASE_URL || 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = process.env.CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

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

function loadToken() {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN.trim();
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return '';
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*HF_TOKEN\s*=/.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
}

const TOKEN = loadToken();

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

function callUpstream(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(UPSTREAM);
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'university-chatbot/1.0',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`The model did not answer within ${Math.round(timeoutMs / 1000)}s.`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function handleChat(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req, 1_000_000));
  } catch (err) {
    return send(res, err.status || 400, { error: err.status === 413 ? err.message : 'The request was not valid JSON.' });
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (!messages.length || !messages.every((m) => typeof m.content === 'string')) {
    return send(res, 400, { error: 'Missing messages.' });
  }

  const upstreamBody = JSON.stringify({
    model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL,
    messages,
    temperature: Math.min(Math.max(Number(parsed.temperature) || 0.2, 0), 1),
    max_tokens: Math.min(Math.max(Number(parsed.maxTokens) || 512, 32), 1536),
    stream: false,
  });

  try {
    const { status, text } = await callUpstream(upstreamBody, Number(process.env.HF_TIMEOUT_MS) || 75_000);
    if (status >= 200 && status < 300) {
      const data = JSON.parse(text);
      const answer = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
      return send(res, 200, { answer: answer.trim(), model: data?.model ?? parsed.model });
    }
    let detail = text.slice(0, 400);
    try {
      detail = JSON.parse(text)?.error?.message || JSON.parse(text)?.error || detail;
    } catch {
      /* keep raw text */
    }
    const hint =
      status === 401
        ? 'Add a token to .env (huggingface.co/settings/tokens) and restart.'
        : status === 410 || status === 503
          ? 'This model is not available on the free router right now. Pick another model in the page settings.'
          : status === 429
            ? 'Free rate limit reached. Wait a minute and ask again.'
            : '';
    return send(res, 502, { error: `Model request failed (HTTP ${status}). ${hint}`, detail: String(detail) });
  } catch (err) {
    return send(res, 502, { error: err.message || 'Could not reach the model provider.' });
  }
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
  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { hasToken: Boolean(TOKEN), model: DEFAULT_MODEL, endpoint: UPSTREAM });
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (!TOKEN) return send(res, 500, { error: 'No Hugging Face token found. Copy .env.example to .env, add your token, then restart the server.' });
    return handleChat(req, res);
  }
  if (req.method === 'GET') return serveStatic(pathname, res);
  send(res, 405, { error: 'Method not allowed.' }, { 'Content-Type': 'text/plain' });
});

server.listen(PORT, HOST, () => {
  console.log(`University chatbot running at http://localhost:${PORT}`);
  console.log(TOKEN ? 'Model answers: ready (token loaded).' : 'Model answers: NO TOKEN — the app will still show the matching document passages.');
});
