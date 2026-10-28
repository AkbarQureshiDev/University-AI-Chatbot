const https = require('node:https');

const FALLBACK_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

const endpoint = () => process.env.HF_BASE_URL || 'https://router.huggingface.co/v1/chat/completions';
const defaultModel = () => (process.env.CHAT_MODEL || FALLBACK_MODEL).trim();
const token = () => (process.env.HF_TOKEN || '').trim();

function status() {
  return { hasToken: Boolean(token()), model: defaultModel(), endpoint: endpoint() };
}

function upstream(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(endpoint());
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token()}`,
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

function hint(statusCode) {
  if (statusCode === 401) return 'Add a token in your host environment (Hugging Face settings → tokens) and redeploy.';
  if (statusCode === 403) return 'This model needs access approval on Hugging Face. Pick another model in the page settings.';
  if (statusCode === 410 || statusCode === 503) return 'This model is not available on the free router right now. Pick another model in the page settings.';
  if (statusCode === 429) return 'Free rate limit reached. Wait a minute and ask again.';
  return '';
}

function ask({ messages, model, maxTokens, temperature }) {
  if (!token()) {
    return Promise.resolve({ status: 500, payload: { error: 'No Hugging Face token is configured, so only document passages can be shown.' } });
  }
  if (!Array.isArray(messages) || !messages.length || !messages.every((m) => typeof m.content === 'string')) {
    return Promise.resolve({ status: 400, payload: { error: 'Missing messages.' } });
  }

  const body = JSON.stringify({
    model: typeof model === 'string' && model.trim() ? model.trim() : defaultModel(),
    messages,
    temperature: Math.min(Math.max(Number(temperature) || 0.2, 0), 1),
    max_tokens: Math.min(Math.max(Number(maxTokens) || 512, 32), 1536),
    stream: false,
  });

  return upstream(body, Number(process.env.HF_TIMEOUT_MS) || 60_000)
    .then(({ status: code, text }) => {
      if (code >= 200 && code < 300) {
        const data = JSON.parse(text);
        const answer = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
        return { status: 200, payload: { answer: answer.trim(), model: data?.model ?? body.model } };
      }
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.error || detail;
      } catch {
        /* keep the raw text */
      }
      return { status: 502, payload: { error: `Model request failed (HTTP ${code}). ${hint(code)}`, detail: String(detail) } };
    })
    .catch((err) => ({ status: 502, payload: { error: err.message || 'Could not reach the model provider.' } }));
}

module.exports = { ask, status };
