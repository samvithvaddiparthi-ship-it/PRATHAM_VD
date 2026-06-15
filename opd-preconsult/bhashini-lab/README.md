# Bhashini STT Test Lab (regional Indian languages)

A standalone harness to **evaluate Bhashini ASR** (Govt-of-India speech-to-text) on
**English, Hindi, and Kannada** — record speech, get a transcript. Isolated from the main OPD app;
nothing here is wired into the product until Bhashini is proven.

## How Bhashini ASR works (two-step)
1. **Pipeline config** (`meity-auth.ulcacontrib.org/.../getModelsPipeline`) → returns the live ASR
   `serviceId` for a language.
2. **Inference** (`dhruva-api.bhashini.gov.in/services/inference/pipeline`) → send base64 WAV audio
   with that `serviceId`, get the transcript back.

The lab does both; if the config call can't be reached/authorised it falls back to a known
`serviceId` per language so inference still works.

## 1. Keys
Credentials live in `bhashini-lab/.env` (gitignored — never committed):
```
BHASHINI_UDYAT_KEY=...
BHASHINI_INFERENCE_API_KEY=...
```
(Copy `.env.example` → `.env` and fill in. The keys come from the Bhashini Udyat dashboard,
app "pratham".)

## 2. Run
```powershell
cd opd-preconsult\bhashini-lab
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn bhashini_server:app --port 5007
```
Open **http://localhost:5007/**, pick a language, record, and read the transcript (with the
serviceId used and latency).

## 3. Evaluate
Speak a sentence in **Hindi**, **Kannada**, and **English**; judge accuracy and latency. This tells
us whether Bhashini is worth integrating for regional STT vs the local Whisper path.

## Accuracy notes (hosted ASR — no "beam size" knob)
Unlike the local Whisper lab, Bhashini is a hosted API: you can't make its server "try harder".
The inference config only accepts `language`, `serviceId`, `audioFormat`, `samplingRate`. The levers
that actually move accuracy are:
1. **Model (`serviceId`)** — the config call already returns Bhashini's recommended model per
   language (en: `whisper-medium-en`, hi: `conformer-hi`, kn: `conformer-multilingual-dravidian`).
2. **Audio quality** — the biggest lever you control. The mic page now captures mono @ 16 kHz with
   echo cancellation, noise suppression, and auto gain on. Record in a quiet room, close to the mic.
3. **Post-processing** — `postProcessors=["itn","punctuation"]` is sent by default: spoken numbers
   become digits (doses/BP/dates) and punctuation is restored. Tune via `BHASHINI_POSTPROCESSORS`
   in `.env` (set empty for the raw transcript).

## Auth note (the one empirical unknown)
The **inference** call uses `Authorization: <BHASHINI_INFERENCE_API_KEY>` — well established.
The **config** call's auth (how the Udyat key maps to headers) is the part to confirm. The lab
currently sends `Authorization: <BHASHINI_UDYAT_KEY>` on the config call. If that returns 401/403,
the config call will log it and fall back to the hardcoded serviceId (inference still runs). To make
the config call succeed, try these header variants in `bhashini.py` `get_service_id()`:
- `{"ulcaApiKey": UDYAT_KEY, "userID": "<userID from dashboard>"}` (classic ULCA), or
- `{"Authorization": UDYAT_KEY}` (current), or whatever the Udyat dashboard specifies.

## Files
| File | Purpose |
|------|---------|
| `bhashini.py` | ASR client: config call, inference call, webm→wav transcode |
| `bhashini_server.py` | FastAPI: `/transcribe`, `/languages`, `/` |
| `index.html` | Mic test page with language dropdown |
| `requirements.txt` | Python deps |
| `.env` | Real keys (gitignored) · `.env.example` is the template |

## Scope
English / Hindi / Kannada, batch (record → transcribe). Streaming (WebSocket ASR), more languages,
and app integration come later if the evaluation is positive.
