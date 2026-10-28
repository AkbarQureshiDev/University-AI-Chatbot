# University AI Chatbot

A student chatbot that answers questions about admissions, fees, courses, deadlines and rules
**from the official university documents you upload**, and always shows which document and page the
answer came from.

This is the RAG method from the beginner guide — *look the information up first, then write the
answer* — implemented in JavaScript so it runs on this computer with no Python install and no paid
API key.

| Guide tool | What this project uses instead |
| --- | --- |
| Python + Google Colab | Node.js (already installed) |
| Streamlit page | `index.html` + `styles.css`, with `api/chat.js` for the model on Vercel |
| PyMuPDF PDF reader | pdf.js, in the browser |
| Sentence Transformers + FAISS | BM25-style keyword search with coverage gate (no model download) |
| Open-source AI model | Free Hugging Face chat endpoint, called through a local proxy |

## Run it

```bash
cp .env.example .env     # then open .env and paste your Hugging Face token
npm start                # http://localhost:3000
```

Get a free token at <https://huggingface.co/settings/tokens>. Without a token the app still works —
it shows the exact matching passages from your documents instead of a written answer.

## Using it

1. **Drop your official PDFs** on the left (admissions prospectus, fee structure, degree catalogue,
   student handbook). Page numbers are kept, so keep them in separate files if you can.
2. **Ask a question**, e.g. "What is the last date to apply for BS Computer Science?"
3. **Read the answer** and the sources underneath it. Click a `[S1]` marker to jump to that passage.

Turn off **Write answers with AI** to see only the matched document passages — useful while you are
checking whether the retrieval is picking the right page.

## How it decides to answer

```
question → find matching passages → enough of the question actually present?
                                      no  → "I could not find that in the official documents"
                                      yes → passages + question go to the model → answer + [S1] sources
```

A passage is only used when the question's important words really appear in it (matched on two
signals: how much of the question is covered, and how many distinct keywords matched). If nothing
qualifies, the model is never called — the bot refuses instead of guessing, which is the whole point
of the project.

## Files

- `api/chat.js` — the model call, as a Vercel serverless function. `GET` reports status, `POST` answers.
- `model-client.js` — the Hugging Face request shared by the function and the local dev server.
- `dev-server.js` — local only: serves the page and routes `/api/chat` so your computer behaves like
  the hosted app while testing.
- `script.js` — PDF text extraction, chunking, search, prompt building, chat rendering.
- `index.html`, `styles.css`, `vercel.json` — the chat page and host configuration.

Your token is read from the environment, never from the browser, and `.env` is never web-accessible.

## Deploying on Vercel

The frontend is plain static files and the model call is one function in `api/`, which is exactly
what Vercel expects — no build step.

1. Push these files to your GitHub repository.
2. In Vercel, open the project → **Settings → Environment Variables** → add `HF_TOKEN` with your
   Hugging Face token (Production + Preview).
3. Set **Framework Preset** to **Other** and leave **Root Directory** at the repository root.
4. Redeploy, then check the log of the `api/chat` function on a test question.

`vercel.json` sets `"framework": null` and gives the function 60 seconds. **Do not add a `main`
field pointing at a server file, and do not add a rewrite that sends every request to
`dev-server.js`** — that bundles only that one file into a function, so `index.html` is missing on
disk and every page returns `{"error":"Not found."}`. If you see that JSON again after a deploy, the
project is being treated as a Node server instead of a static site plus function.

A deployment without `HF_TOKEN` still works: the page loads in "passages only" mode and shows the
exact document text instead of a written answer.

## Notes and honest limits

- **Free tiers change.** Hugging Face free inference has rate limits and models get moved; if the
  default model stops answering, pick another in the panel or set `CHAT_MODEL` in `.env`.
- **Repeated headers and footers are dropped.** A line that appears on 40% or more of the pages
  (a running title, "Page 3", a copyright strip) is removed before indexing, because otherwise every
  passage would "match" a question containing the university's name. Real page numbers are kept.
- **Scanned PDFs have no text.** If a page is a photo of a page, pdf.js finds nothing and the app
  tells you. Run OCR first, or type that section into a `.txt` file and drop it in — `.txt` and
  `.md` work too.
- **Re-uploading is needed after a refresh.** Indexes live in the browser tab only, by design, so
  nothing you upload is stored on disk — and no visitor document ever reaches your account.
- **Public documents only.** Never upload private student records, and never commit `.env`.
- **A hosted site exposes your model quota.** Anyone who finds the URL can make the function call
  your Hugging Face token. `api/chat.js` limits each IP to 30 questions per 5 minutes
  (`MAX_REQUESTS_PER_5MIN`), but that count is per warm server instance, so treat it as a speed
  bump rather than a lock. For a real launch, add access control in front of it.

## Testing what you built

Ask three kinds of questions and check the answers against the documents yourself:

- a **fact** with one right answer (a deadline, a fee amount) — is the figure exact?
- a **list** (courses in a semester) — does it stop at what the document says?
- something **not in the documents** (hostel fee, bus routes, a program you did not upload) — it
  must refuse. Any made-up answer here is a bug worth fixing before a demo.
