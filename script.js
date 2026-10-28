import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

const MIN_MATCHES = 2;
const MIN_COVERAGE = 0.34;
const STRONG_COVERAGE = 0.62;
const RELATIVE_CUT = 0.35;
const TOP_K = 4;
const CHUNK_CHARS = 950;
const NOT_FOUND = 'I could not find that in the official documents. Please check with the university admissions office.';

const el = (id) => document.getElementById(id);
const ui = {
  drop: el('dropZone'),
  file: el('fileInput'),
  docs: el('docList'),
  progress: el('progress'),
  progressBar: el('progressBar'),
  progressText: el('progressText'),
  messages: el('messages'),
  form: el('composer'),
  question: el('question'),
  send: el('sendBtn'),
  model: el('modelSelect'),
  customField: el('customModelField'),
  custom: el('customModel'),
  ai: el('aiToggle'),
  test: el('testBtn'),
  status: el('engineStatus'),
  samples: el('samples'),
};

const store = {
  docs: new Map(),
  chunks: [],
  df: new Map(),
  ready: false,
  busy: false,
};

/* ---------- text helpers ---------- */

const STOP = new Set(
  `a an and are as at be been by for from had has have he her him his how i if in into is it its me my of on or our out she that the their them then there these they this to too us was we were what when where which who whom why will with would you your yours
   do does did doing not no yes can could should would may might shall must about after before between during under over in case because so but or nor yet either neither each other same such than
   university universitied student students student's`.split(/\s+/)
);

function normalize(text) {
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/“/g, '"').replace(/”/g, '"').replace(/\s+/g, ' ').trim();
}

function stem(word) {
  return word
    .replace(/(ies|ying)$/,'y').replace(/([^s])s$/,'$1').replace(/(ss)$/,'$1')
    .replace(/(ing|ed|es)$/,'').replace(/[^a-z0-9]/g,'');
}

function tokenize(text) {
  const out = [];
  for (const raw of normalize(text).match(/[\p{L}0-9][\p{L}0-9'.-]*/gu) || []) {
    const word = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase();
    if (!word || STOP.has(word)) continue;
    out.push(stem(word));
  }
  return out.filter((w) => w.length > 1);
}

const NUM = /\d+(?:[.,]\d+)*(?:\s?(?:%|rupees|rs\.?|pkr|inr|usd|\$|lakh|k))?/gi;
const MONTHS = /(january|february|march|april|may|june|july|august|september|october|november|december)\.?\s*\d{1,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/gi;

function entities(text) {
  const found = [...(text.match(NUM) || []), ...(text.match(MONTHS) || [])].map((v) => normalize(v).replace(/[.,:]$/, ''));
  return new Set(found.filter(Boolean));
}

function splitSentences(text) {
  const parts = text.split(/(?<=[.!?;:])\s+(?=["'(A-Z0-9])/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/* ---------- document reading ---------- */

async function readPdf(name, buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: buffer,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/standard_fonts/',
  }).promise;
  const pages = [];
  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], str: item.str });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.str).join(''));
    if (lines.join('').trim().length > 25) pages.push({ num, lines });
  }
  await pdf.destroy?.();
  return pages;
}

function cleanLine(line) {
  return line
    .replace(/\u00ad/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[ \t]+/g, ' ')
    .replace(/^l\s+(?=[A-Z0-9])/i, '• ')
    .trim();
}

function stripBoilerplate(rawPages) {
  const kept = rawPages.map((p) => ({ num: p.num, lines: p.lines.map(cleanLine).filter(Boolean) }));
  if (kept.length >= 3) {
    const onPages = new Map();
    for (const page of kept) {
      for (const key of new Set(page.lines.map(boilerKey))) {
        if (key.length > 2) onPages.set(key, (onPages.get(key) || 0) + 1);
      }
    }
    const minPages = Math.max(3, Math.ceil(kept.length * 0.4));
    for (const page of kept) {
      page.lines = page.lines.filter((line) => (onPages.get(boilerKey(line)) || 0) < minPages);
    }
  }
  return kept.filter((p) => p.lines.length).map((p) => ({ num: p.num, text: cleanText(p.lines.join('\n')) }));
}

const boilerKey = (line) => normalize(line).replace(/\d+/g, '#');

function cleanText(text) {
  return text
    .replace(/\u00ad/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function chunkPages(docName, pages) {
  const chunks = [];
  for (const { num, text } of pages) {
    let current = '';
    for (const sentence of splitSentences(text.replace(/\n/g, ' '))) {
      if (current && (current.length + sentence.length) > CHUNK_CHARS) {
        chunks.push({ doc: docName, page: num, text: current.trim() });
        const tail = current.split(/(?<=[.!?;:])\s/).slice(-2).join(' ');
        current = (tail.length < 240 ? tail + ' ' : '') + sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
      if (current.length > CHUNK_CHARS * 1.6) {
        chunks.push({ doc: docName, page: num, text: current.trim().slice(0, CHUNK_CHARS * 1.6) });
        current = '';
      }
    }
    if (current.trim().length > 40) chunks.push({ doc: docName, page: num, text: current.trim() });
  }
  return chunks;
}

function addDocument(name, pages) {
  const chunks = chunkPages(name, pages).filter((c) => c.text.length > 60);
  if (!chunks.length) return 0;
  removeDocument(name, false);
  store.docs.set(name, { name, pages: pages.length, chunks: chunks.length });
  for (const chunk of chunks) {
    chunk.tokens = tokenize(chunk.text);
    chunk.entity = entities(chunk.text);
    chunk.norm = normalize(chunk.text);
    chunk.freq = new Map();
    for (const t of chunk.tokens) chunk.freq.set(t, (chunk.freq.get(t) || 0) + 1);
    chunk.id = store.chunks.length;
    store.chunks.push(chunk);
  }
  rebuildIndex();
  return chunks.length;
}

function removeDocument(name, rebuild = true) {
  if (!store.docs.has(name)) return;
  store.docs.delete(name);
  store.chunks = store.chunks.filter((c) => c.doc !== name);
  if (rebuild) rebuildIndex();
}

function rebuildIndex() {
  store.df.clear();
  for (const chunk of store.chunks) {
    for (const term of new Set(chunk.tokens)) store.df.set(term, (store.df.get(term) || 0) + 1);
  }
  store.ready = store.chunks.length > 0;
  renderDocs();
}

/* ---------- retrieval ---------- */

function termIdf(term) {
  const total = store.chunks.length;
  const df = store.df.get(term) || 0;
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

function search(question, k = TOP_K) {
  if (!store.ready) return [];
  const qTerms = [...new Set(tokenize(question))];
  if (!qTerms.length) return [];

  const avgLen = store.chunks.reduce((sum, c) => sum + c.tokens.length, 0) / store.chunks.length || 1;
  const qWeight = qTerms.map((t) => ({ term: t, idf: termIdf(t) }));
  const totalWeight = qWeight.reduce((sum, w) => sum + w.idf, 0) || 1;

  const words = normalize(question).split(/[^a-z0-9']+/).filter(Boolean);
  const qEntities = entities(question);
  const scored = [];

  const phraseBonus = (chunk) => {
    for (let len = Math.min(6, words.length); len >= 3; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        if (chunk.norm.includes(words.slice(i, i + len).join(' '))) return (len - 2) * 1.5;
      }
    }
    return 0;
  };

  for (const chunk of store.chunks) {
    let bm25 = 0;
    let matchedWeight = 0;
    const matched = [];
    for (const { term, idf } of qWeight) {
      const tf = chunk.freq.get(term);
      if (!tf) continue;
      matched.push(term);
      matchedWeight += idf;
      const lengthNorm = 1.2 * (0.25 + 0.75 * (chunk.tokens.length / avgLen));
      bm25 += idf * ((tf * 2.2) / (tf + lengthNorm));
    }
    if (!matched.length) continue;

    const coverage = matchedWeight / totalWeight;
    let rank = bm25;
    if (qEntities.size) {
      const hits = [...qEntities].filter((e) => chunk.entity.has(e) || chunk.norm.includes(e)).length;
      rank += 4 * (hits / qEntities.size);
    }
    rank += phraseBonus(chunk);

    scored.push({ chunk, coverage, rank, matched, ents: [...qEntities] });
  }

  const accepted = scored.filter((s) => s.coverage >= STRONG_COVERAGE || (s.matched.length >= MIN_MATCHES && s.coverage >= MIN_COVERAGE));
  if (!accepted.length) return [];
  accepted.sort((a, b) => b.rank - a.rank);
  const ceiling = accepted[0].rank;
  return accepted.filter((s, i) => i === 0 || s.rank >= ceiling * RELATIVE_CUT).slice(0, k);
}

/* ---------- answering ---------- */

function bestExcerpt(result, limit = 480) {
  const { chunk, matched, ents = [] } = result;
  const sentences = splitSentences(chunk.text);
  let best = 0;
  let index = 0;
  sentences.forEach((sentence, i) => {
    const words = new Set(tokenize(sentence));
    const flat = normalize(sentence);
    let hits = matched.reduce((sum, term) => sum + (words.has(term) ? 1 : 0), 0);
    hits += 2 * ents.filter((e) => flat.includes(e)).length;
    if (hits > best) {
      best = hits;
      index = i;
    }
  });
  let text = '';
  for (let i = index; i < sentences.length && text.length < limit; i++) text += (text ? ' ' : '') + sentences[i];
  if (text.length > limit) text = `${text.slice(0, limit).replace(/\s\S*$/, '')}…`;
  return (index > 0 ? '… ' : '') + text;
}

function extractiveAnswer(results) {
  const lead = results.length === 1 ? 'Here is the passage that matches your question.' : `Here are the ${results.length} passages that match your question.`;
  return `${lead} ${bestExcerpt(results[0])}`;
}

function buildMessages(question, results) {
  const passages = results
    .map((r, i) => `[S${i + 1}] (${r.chunk.doc}, page ${r.chunk.page}): """${r.chunk.text}"""`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You answer student questions about a university using ONLY the numbered passages provided.\n' +
        `Rules: never use outside knowledge. Never invent a date, fee, rule or course name. If the passages do not answer the question, reply exactly: "${NOT_FOUND}"\n` +
        'Quote the important figures (dates, amounts, names) as they appear in the passages. End every factual sentence with the passage tags you used, like [S1] or [S2,S4].\n' +
        'Write 40-120 words in plain English. Use a short bullet list if there are several items.',
    },
    { role: 'user', content: `Question: ${question}\n\nPassages:\n${passages}\n\nAnswer:` },
  ];
}

async function askModel(messages, model) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model, maxTokens: 512, temperature: 0.2 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
  return data.answer || '';
}

function currentModel() {
  return ui.model.value === 'custom' ? ui.custom.value.trim() : ui.model.value;
}

/* ---------- rendering ---------- */

function bubble(cls, html) {
  const article = document.createElement('article');
  article.className = `msg ${cls}`;
  const box = document.createElement('div');
  box.className = 'bubble';
  box.innerHTML = html;
  article.append(box);
  ui.messages.append(article);
  ui.messages.scrollTop = ui.messages.scrollHeight;
  return box;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderBody(text) {
  const safe = escapeHtml(text).replace(/\[S(\d+)(?:[,/\s]+S(\d+))?\]/g, (m, a, b) => {
    const ids = b ? [a, b] : [a];
    return ids.map((id) => `<sup class="cite" data-src="${id}" title="Show this passage">[S${id}]</sup>`).join('');
  });
  const blocks = safe.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l) || !l.trim())) {
        const items = lines.map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);
        return `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
      }
      return `<p>${block.replace(/^\s*[-*•]\s+/gm, '')}</p>`;
    })
    .join('');
}

function renderSources(results, usedIds) {
  const box = document.createElement('div');
  box.className = 'sources';
  box.innerHTML = '<h3>Sources</h3>';
  results.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'source';
    btn.dataset.src = String(i + 1);
    const marker = usedIds.has(i + 1) ? '' : '<span class="meta"> (not used in the answer)</span>';
    btn.innerHTML = `<b>[S${i + 1}]</b>${escapeHtml(r.chunk.doc)} — page ${r.chunk.page}${marker}<q>${escapeHtml(
      bestExcerpt(r, 300)
    )}</q>`;
    box.append(btn);
  });
  return box;
}

function renderDocs() {
  ui.docs.innerHTML = '';
  if (!store.docs.size) {
    ui.docs.innerHTML = '<li class="empty">No documents indexed yet.</li>';
    return;
  }
  for (const doc of store.docs.values()) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = doc.name;
    name.title = doc.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${doc.pages}p · ${doc.chunks}x`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this document';
    remove.addEventListener('click', () => removeDocument(doc.name));
    li.append(name, count, remove);
    ui.docs.append(li);
  }
}

function setProgress(label, ratio) {
  ui.progress.hidden = ratio === null;
  if (ratio === null) return;
  ui.progressText.textContent = label;
  ui.progressBar.style.setProperty('--w', `${Math.round(ratio * 100)}%`);
}

/* ---------- ingestion flow ---------- */

async function ingest(files) {
  const list = [...files].filter((f) => /\.(pdf|txt|md)$/i.test(f.name));
  if (!list.length) return;
  ui.busy = true;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    setProgress(`Reading ${file.name}…`, (i + 0.2) / list.length);
    try {
      const buffer = await file.arrayBuffer();
      let pages;
      if (/\.pdf$/i.test(file.name)) {
        pages = stripBoilerplate(await readPdf(file.name, new Uint8Array(buffer)));
      } else {
        const text = cleanText(new TextDecoder().decode(buffer));
        pages = [{ num: 1, text }];
      }
      if (!pages.length) throw new Error('No readable text. If this PDF was scanned, type the text into a .txt file instead.');
      const chunks = addDocument(file.name, pages);
      bubble('bot', `<span class="tag">Indexed</span><p><strong>${escapeHtml(file.name)}</strong> — ${pages.length} page(s) of text, ${chunks} searchable passages.</p>`);
    } catch (err) {
      bubble('bot', `<span class="tag bad">Problem</span><p>${escapeHtml(file.name)}: ${escapeHtml(err.message || 'Could not read this file.')}</p>`);
    }
    setProgress(`Reading ${file.name}…`, (i + 1) / list.length);
  }
  setProgress('', null);
  ui.busy = false;
  ui.question.focus();
}

/* ---------- asking flow ---------- */

async function answer(question) {
  if (ui.busy) return;
  const results = search(question);
  bubble('me', `<p>${escapeHtml(question)}</p>`);
  ui.busy = true;
  ui.send.disabled = true;

  if (!results.length) {
    bubble(
      'bot',
      `<span class="tag warn">Not in the documents</span><p>${NOT_FOUND}</p><p class="dim">${
        store.ready
          ? 'Nothing in the indexed text matched closely enough, so I did not let the model guess.'
          : 'Add a document on the left first.'
      }</p>`
    );
    ui.busy = false;
    ui.send.disabled = false;
    return;
  }

  if (!ui.ai.checked) {
    const box = bubble('bot', `<span class="tag">Passage match</span>${renderBody(extractiveAnswer(results))}`);
    box.append(renderSources(results, new Set([1])));
    ui.busy = false;
    ui.send.disabled = false;
    return;
  }

  const thinking = bubble('bot', '<span class="tag">Thinking</span><p class="typing"><span></span><span></span><span></span></p>');
  try {
    const raw = await askModel(buildMessages(question, results), currentModel());
    if (!raw || normalize(raw).startsWith(normalize(NOT_FOUND).slice(0, 40))) {
      thinking.innerHTML = `<span class="tag warn">Not in the documents</span><p>${NOT_FOUND}</p>`;
    } else {
      thinking.innerHTML = renderBody(raw);
      const used = new Set([...raw.matchAll(/\[S(\d+)/g)].map((m) => Number(m[1])));
      thinking.append(renderSources(results, used.size ? used : new Set([1])));
    }
  } catch (err) {
    thinking.innerHTML = `<span class="tag bad">Model unavailable</span><p>${escapeHtml(err.message)}</p><p class="dim">Here are the matching passages instead — turn AI off in the panel to always see this view.</p>`;
    const fallback = document.createElement('div');
    fallback.innerHTML = renderBody(extractiveAnswer(results));
    thinking.append(fallback, renderSources(results, new Set([1])));
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
  ui.busy = false;
  ui.send.disabled = false;
}

/* ---------- wiring ---------- */

ui.drop.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => {
  ingest(ui.file.files);
  ui.file.value = '';
});
for (const evt of ['dragenter', 'dragover']) ui.drop.addEventListener(evt, (e) => (e.preventDefault(), ui.drop.classList.add('drag')));
for (const evt of ['dragleave', 'drop'])
  ui.drop.addEventListener(evt, (e) => {
    e.preventDefault();
    ui.drop.classList.remove('drag');
    if (evt === 'drop') ingest(e.dataTransfer.files);
  });

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = ui.question.value.trim();
  if (!question) return;
  ui.question.value = '';
  answer(question);
});

ui.samples.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  ui.question.value = e.target.textContent;
  ui.question.focus();
});

ui.messages.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-src]');
  if (!chip) return;
  const card = ui.messages.querySelector(`.source[data-src="${chip.dataset.src}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.animate([{ background: '#fff8dc' }, { background: '#fff' }], { duration: 1200 });
});

ui.model.addEventListener('change', () => {
  ui.customField.hidden = ui.model.value !== 'custom';
  localStorage.setItem('chatbot.model', ui.model.value);
});
ui.ai.addEventListener('change', () => localStorage.setItem('chatbot.ai', String(ui.ai.checked)));

async function checkEngine() {
  try {
    const health = await (await fetch('/api/chat')).json();
    if (health.hasToken) {
      ui.status.textContent = `Model ready · ${health.model.split('/').pop()}`;
      ui.status.className = 'status ok';
    } else {
      ui.status.textContent = 'No token — passages only';
      ui.status.className = 'status bad';
      ui.ai.checked = false;
    }
  } catch {
    ui.status.textContent = 'Model endpoint not reachable';
    ui.status.className = 'status bad';
    ui.ai.checked = false;
  }
}

ui.test.addEventListener('click', async () => {
  ui.test.disabled = true;
  ui.test.textContent = 'Testing…';
  try {
    await askModel([{ role: 'user', content: 'Reply with the single word: connected' }], currentModel());
    ui.test.textContent = 'Model replied correctly ✓';
  } catch (err) {
    ui.test.textContent = err.message.slice(0, 90);
  }
  ui.test.disabled = false;
  setTimeout(() => (ui.test.textContent = 'Test model connection'), 4000);
});

const savedModel = localStorage.getItem('chatbot.model');
if (savedModel && [...ui.model.options].some((o) => o.value === savedModel)) ui.model.value = savedModel;
if (localStorage.getItem('chatbot.ai') === 'false') ui.ai.checked = false;
checkEngine();
