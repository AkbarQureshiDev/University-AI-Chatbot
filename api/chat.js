const model = require('../model-client');

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.MAX_REQUESTS_PER_5MIN) || 30;
const hits = new Map();

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) {
      for (const [key, value] of hits) if (now - value.start > WINDOW_MS) hits.delete(key);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, model.status());
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return json(res, 429, { error: 'Too many questions from this device in the last 5 minutes. Please wait.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { status, payload } = await model.ask(body);
  return json(res, status, payload);
};
