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
| Streamlit page | `index.html` + `styles.css` served by `server.js` |
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

- `server.js` — serves the page and forwards prompts to Hugging Face. Your token stays here and is
  never sent to the browser; `.env` is not web-accessible.
- `script.js` — PDF text extraction, chunking, search, prompt building, chat rendering.
- `index.html`, `styles.css` — the chat page.

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
  nothing you upload is stored on disk.
- **Public documents only.** Never upload private student records, and never commit `.env`.
- **This is a local demo.** It is not a public website yet; hosting it for real students needs
  access control and a rate limit on the model call.

## Testing what you built

Ask three kinds of questions and check the answers against the documents yourself:

- a **fact** with one right answer (a deadline, a fee amount) — is the figure exact?
- a **list** (courses in a semester) — does it stop at what the document says?
- something **not in the documents** (hostel fee, bus routes, a program you did not upload) — it
  must refuse. Any made-up answer here is a bug worth fixing before a demo.
