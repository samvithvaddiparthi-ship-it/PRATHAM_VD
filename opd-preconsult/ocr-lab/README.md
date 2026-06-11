# OCR Test Lab — local VLM (Ollama) vs cloud Gemini

An isolated test harness to compare medical-document extraction on the **same image**:

- **Local** — a Vision-Language Model (default `qwen2.5vl:7b`) served by **Ollama** on your GPU
- **Cloud** — Google Gemini vision (`gemini-2.5-flash`)

Both use the **same extraction prompt** the real app uses, so it's a fair comparison. Upload a
printed prescription or lab report and see the structured JSON + latency from each engine.

This folder does **not** touch the main OPD app.

---

## 1. Install Ollama + pull the model (local engine)

Ollama is a separate app (not a pip package). It runs the VLM on your GPU automatically — no
CUDA/cuDNN setup needed.

1. Install Ollama for Windows: https://ollama.com/download
2. Pull the vision model (one-time, ~6GB):
   ```powershell
   ollama pull qwen2.5vl:7b
   ```
3. Ollama runs in the background at `http://localhost:11434`. Verify:
   ```powershell
   ollama list
   ```

> To try other models later, pull them and set `OCR_LOCAL_MODEL`, e.g.
> `ollama pull qwen2.5vl:3b` then `$env:OCR_LOCAL_MODEL="qwen2.5vl:3b"`.

---

## 2. Cloud key (cloud engine)

The Gemini engine reuses `GEMINI_API_KEY` from the main project env file, `..\.env`
(`opd-preconsult\.env`). If it's missing, the Cloud — Gemini option appears disabled; the local
engine still works.

---

## 3. Run

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn ocr_server:app --port 5006
```

Open **http://localhost:5006/**:
1. Pick an **engine** from the dropdown.
2. Choose a document image (printed prescription / lab report works best).
3. Click **Extract** — the structured fields (medications, lab values, diagnosis…) render on the
   right, with the raw JSON and the latency below.

The first local extraction loads the model into VRAM and is slower; subsequent runs are fast.

---

## 4. A/B test

Run the **same image** through `Local — qwen2.5vl:7b` and `Cloud — Gemini`, and compare:
- Did the local model get the **drug names / doses** right?
- Did it get the **lab values + abnormal flags** right?
- How does the **latency** compare?

That tells us whether local Qwen2.5-VL is good enough on printed docs to become the offline OCR
path in the main app.

---

## Files

| File              | Purpose                                              |
|-------------------|------------------------------------------------------|
| `ocr_server.py`   | FastAPI server: `/extract`, `/engines`, `/`          |
| `engines.py`      | Local (Ollama) + cloud (Gemini) dispatch             |
| `prompt.py`       | Extraction prompt + JSON parser (copied from the app)|
| `index.html`      | Upload + compare test page                           |
| `requirements.txt`| Python deps                                          |

## Scope

Printed documents first (prescriptions, lab reports). Handwriting, PDFs, and wiring into the main
app are later phases.
