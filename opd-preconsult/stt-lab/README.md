# STT Test Lab — multi-engine benchmark (local + cloud)

An isolated test harness to compare speech-to-text engines on the **same recording**:

- **Local** faster-whisper on your NVIDIA 4060 — `medium.en` and `large-v3`
- **Cloud** — Gemini audio, OpenAI Whisper, Deepgram

It runs **natively on Windows** (no Docker) and serves a small mic test page with an **engine
dropdown** so you can speak once and switch engines to compare quality + latency.

This folder does **not** touch the main OPD app.

---

## Cloud engine keys (optional — local works without any)

Cloud engines read their keys from the main project env file, `..\.env`
(`opd-preconsult\.env`). The lab reuses the keys already there:

```
OPENAI_API_KEY=...      # OpenAI Whisper
GEMINI_API_KEY=...      # Gemini audio (free)
DEEPGRAM_API_KEY=...    # Deepgram — add this one (free to create at deepgram.com)
```

Any engine whose key is missing simply appears **disabled** in the dropdown — the rest still work.
You can also drop a `stt-lab\.env` with the same keys to override.

---

## 1. One-time setup

From this folder (`opd-preconsult/stt-lab`) in PowerShell:

```powershell
# Create and activate a virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt
```

> If activation is blocked, run once:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

---

## 2. Run

```powershell
uvicorn stt_server:app --port 5005
```

Then open **http://localhost:5005/** in Chrome, pick an **engine** from the dropdown, click
**Start recording**, speak an English sentence, click **Stop**. The transcript, engine, detail,
and latency appear.

The first time you use a local model, the terminal prints which device loaded:

```
[stt-lab] Loaded local model=medium.en on device=cuda (float16)
```

`device=cuda` means the 4060 is being used. `device=cpu` means it fell back (see below).

---

## 3. A/B test engines

Use the **engine dropdown** on the page — no restart needed:

- `Local — medium.en` / `Local — large-v3` (each local model loads once on first use, then stays
  resident; both fit on the 8GB 4060)
- `Cloud — Gemini` / `Cloud — OpenAI Whisper` / `Cloud — Deepgram` (shown only if their key is set)

Record the **same phrase**, then switch engines and re-record to compare transcript quality
(especially drug brand names) vs the `ms` latency shown on the page.

| Local model | Size   | Notes                                              |
|-------------|--------|----------------------------------------------------|
| `medium.en` | ~1.5GB | Strong English, ~1-3s on the 4060                  |
| `large-v3`  | ~3GB   | Best accuracy (incl. medical terms), still fast on GPU |

Models download automatically on first use and are cached in your user profile
(`%USERPROFILE%\.cache\huggingface`).

---

## 4. GPU not picked up? (`device=cpu` in the log)

`faster-whisper` uses CTranslate2, which needs **CUDA 12 + cuDNN 9** libraries on Windows.
If the server logs a CUDA failure and falls back to CPU, install the libs into the venv:

```powershell
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

Then rerun. (Alternatively, install the NVIDIA CUDA 12.x toolkit + cuDNN 9 and ensure their
`bin` folders are on your `PATH`.) Make sure your NVIDIA driver is recent.

If you just want to confirm the pipeline works while sorting out CUDA, CPU mode still
transcribes — it's only slower.

---

## Files

| File              | Purpose                                              |
|-------------------|------------------------------------------------------|
| `stt_server.py`   | FastAPI server: loads the model, `/transcribe`, `/`  |
| `index.html`      | Minimal mic test page                                |
| `requirements.txt`| Python deps                                          |
