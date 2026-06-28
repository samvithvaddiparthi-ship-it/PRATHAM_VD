# Changes handoff — for Samvith

Summary of Dhyan's recent work on Pratham, split into **(A) already on `main`** (pull
to get) and **(B) pending push** (not committed yet — listed so you know what's coming).

---

## A. Already pushed to `main`

Pull and you'll have these three commits:

| Commit | What |
|---|---|
| `8f2c590` | **OCR: Groq Llama-4 vision** as a fallback provider — keeps OCR on a real vision model when Gemini's quota is spent (instead of dropping to Tesseract). |
| `1f67682` | **OCR prompt sharpened** (force generic inference, snap a misread brand to the closest real Indian brand, exclude non-drugs) **+ on-shore local vision provider** (Qwen2.5-VL via Ollama) in `llm_client.py` — env-gated, OFF by default. |
| `84e2f8c` | **Auth hardening + admin login + clinical-use disclaimer + login UX.** (Details below — this one needs `.env` changes from you.) |

### ⚠️ Action required for `84e2f8c` (auth)
The old `dev_secret` JWT fallback is gone and endpoints are now role-gated. Add to your **`.env`** (gitignored, per-machine):
```
ADMIN_PASSCODE=<ask Dhyan>                  # shared dev passcode — get the exact value from Dhyan (not committed)
JWT_SECRET=<strong random>                 # generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                                           # (or: python -c "import secrets;print(secrets.token_hex(32))")
```
Then rebuild: `docker compose build node-backend frontend && docker compose up -d && docker compose restart gateway`.

**What changed in auth:**
- No `dev_secret`; in production the server refuses to start without a strong `JWT_SECRET` (dev uses a random per-boot key). All inline `dev_secret` verifies in `doctor.js` replaced with a shared `verifyToken`.
- JWT now carries a **role** (`patient`/`doctor`/`admin`); new `requireRole` middleware gates mutating **admin / doctor-management / analytics / protocol / prescription** endpoints.
- **HIS dashboard (`/his`) now requires an admin passcode login** (`POST /api/admin/login`, env `ADMIN_PASSCODE`). Use it on **port 80 (`localhost/his`)**, not `:3000`.
- Persistent **"Investigational — not for clinical use"** disclaimer banner (localized en/hi/te on patient pages).
- HIS admin login is desktop-centered; **Show/Hide toggle** on the HIS + doctor login password fields.
- **Gateway `/his/` routing fix** — `nginx.conf` now sends only `/his/fhir` to the backend so the frontend owns `/his` and `/his/` (fixes "Cannot GET /his/"). nginx.conf is volume-mounted, so just `docker compose restart gateway`.

Doctor login (PIN 1234) and the patient flow are unchanged.

---

## B. Pending push (uncommitted in Dhyan's tree)

Two features, all **additive**. When pushed you'll need:
`docker compose build python-backend frontend && docker compose up -d && docker compose restart gateway`.
**No new API keys** — Bhashini TTS reuses the existing `BHASHINI_INFERENCE_API_KEY`.

### B1. Bhashini Text-to-Speech (read-aloud)
On-shore TTS for the patient "Listen" buttons (natural en/hi/te voices). **Additive — does not touch your STT/NMT code.**
- **New** `services/python-backend/src/bhashini/tts.py` — `synthesize(text, lang)`; reuses the keys/URLs/TLS from `asr.py`. Uses verified fallback service IDs (en=`indic-tts-coqui-misc`, hi=`indo_aryan`, te=`dravidian`); config-discovery is skipped unless a ULCA Udyat key is set (it was returning bad serviceIds → 500s).
- **New** `services/python-backend/src/routers/tts.py` — `POST /api/tts {text, lang}` → `audio/wav` (caps text at 1000 chars).
- `main.py` — registers the `tts` router.
- `gateway/nginx.conf` — adds `location /api/tts` → python-backend.

### B2. Elderly / low-literacy patient UX
- **New** `components/A11yProvider.jsx` — patient-only accessibility bar: **text-size A / A+ / A++** (font-scaling via a `--fs` CSS var, reflows on mobile — not zoom) and an **♿ Assist (Easy) mode** = max font + high-contrast theme + auto-read-aloud of questions.
- **New** `components/ListenButton.jsx` — 🔊 read-aloud via Bhashini TTS with **browser-TTS fallback**; plays the question and each option as **separate clips with a ~1 s gap**; `autoPlay` for Assisted mode; hi/te slowed to 0.85×.
- `components/QuestionCard.jsx` — Listen button + auto-read; **Yes/No now have ✓/✗ icons**; options spoken as separate segments.
- `app/patient/register/page.jsx` — **gender dropdown → 👨 👩 🧑 icon buttons**; uniform button sizing.
- `app/patient/{consent,documents,interview,vitals}/page.jsx` — uniform button sizing (removed hardcoded `fontSize:13` so all buttons scale together); **vitals page gets a Listen button**.
- `app/globals.css` — `--fs` scaling on `.btn`/`.input`/`.lang-btn`/`body`; `.assist` high-contrast theme.
- `app/layout.jsx` — wraps children in `<A11yProvider>`.
- `lib/i18n.js` — **consent text rewritten** (en/hi/te): removed the misleading "request deletion anytime" line; now states the hospital **retains records per medical-record guidelines**.

### Caveats worth knowing
- **TTS latency** ~1–3 s per tap; Assisted auto-read fires reliably after any user tap (browser autoplay policy).
- Text-scaling uses CSS **`font-size`** (mobile-safe, reflows) — verified single-column on narrow widths.
- Bhashini TTS **config-discovery is bypassed** (no Udyat key) — uses verified fallback service IDs.

### Not for push (stays local)
- `CLAUDE.md` (kept current, never committed — per Dhyan's rule).
- `eval/` (OCR accuracy harness + gitignored prescription data).

---

## C. Doctor dashboard & patient-flow improvements (today)

> ### ⚠️ DB MIGRATION — read before pulling
> This batch adds **migration `011`** (new `consulted_at` column for the Consulted tab).
> Migrations run automatically on **node-backend startup**, so after you pull you **must rebuild node-backend** — a plain `restart` runs the old image and the new code will hit a missing column → **the app breaks**.
> ```
> docker compose build node-backend && docker compose up -d node-backend
> ```
> If it didn't auto-apply, run it manually:
> ```
> docker compose exec -T postgres psql -U opd_user -d opd_preconsult < db/migrations/011_consulted_at.sql
> ```

### Dashboard gating & visit logic
- **Doctor-dashboard gating** — patients now appear on the doctor's dashboard only after completing the full pre-consult (report generated), not the moment they type credentials.
- **Visit-count rule** — "Previous visits" count (and returning-patient detection) only counts *completed* visits (finished + submitted), not abandoned/partial sessions.
- **First-vs-follow-up is now automatic** — removed the "Is this your first visit or a follow-up?" page. The system determines it server-side from the patient's completed-visit history, so it's always accurate.
- **Removed "What did you come for last time?"** — dropped from the follow-up flow; questionnaire re-pointed around it.
- **"How are you feeling compared to last visit?"** — kept, but now correctly shown only to returning patients (was wrongly appearing for first-timers due to a stale client-side flag — fixed by moving the decision to the backend).

### Patient flow
- **Page order finalized** — Register → Welcome card → Consent → Documents → Health questions → Vitals.
- **"Go Back" hardened across the whole flow** — deterministic navigation, no page-reordering bugs, verified end-to-end.

### "NEW" (unread) badge
- **NEW badge = unread marker** — a patient shows a "NEW" badge until the doctor opens them once, then it permanently becomes an expand arrow (like a WhatsApp unread mark). Persists across page refreshes (stored per-visit); a genuinely new visit re-triggers "NEW".
- **Clears on actual open** — the badge clears only when the doctor opens the filled visit (consulting it / sending it to Consulted), not when merely clicking the name to expand it.

### Consulted tab
- **Deduped & stable order** — shows one row per patient (their latest consulted visit) instead of one per visit.
- Ordered by a fixed "first-consulted" timestamp so re-opening a patient no longer reshuffles the list (new DB column `consulted_at`, **migration 011**).

### Header & status UI
- Live date + clock and a time-of-day greeting ("Good evening, Dr. …").
- List-header bar above each list: "N waiting · N seen" — a patient the doctor has opened counts as *seen*, not *waiting*.
- Triage breakdown shown only for non-zero levels as compact colour dots + counts (hover for label), so it never wraps or congests.

### Polish
- Loading skeletons on first load of each tab (no abrupt pop-in, no flicker on auto-refresh).
- Triage levels renamed from generic urgency words to a single consistent acuity scale; harsh primary colours softened. Fixed-colour emoji (🔴 🟡 🟢, which can't be recoloured to match a palette) replaced with matching CSS dots.
- **Independent scrolling** — layout locked to the viewport (`height:100vh; overflow:hidden`) so the page no longer nudges at the edges. Left patient list and right report pane are each their own fixed-height scroll container while the header/tabs/search stay pinned. Always-visible thin custom scrollbar (`.scrolly`) on both panes.
- **Refresh control** — replaced the bulky full-width Refresh button with a compact labelled ↻ pill in the list header. Refreshes whichever tab is active (was queue-only). On click it spins, shows grey ghost rows in place of the list, and switches to a disabled "Refreshing" state — held to a ~0.5 s minimum so a near-instant local reload still visibly registers.

### Safety & validation
- **Logout confirmation** — clicking Logout now opens a confirm dialog before signing the doctor out.
- **Patient name cap** — registration name limited to 40 chars (`maxLength` + slice), with overflow-wrap safety so a long single-word name can't overflow the welcome banner or dashboard cards.
- **Age required** — registration rejects an empty age with the same inline red error style as the phone/gender checks ("Please enter the age."), keeping the 0–120 cap.

### Doctor management
- **Reactivate** for deactivated doctors.
- **Edit doctor details** (name / department / phone) + optional PIN reset.
- **Phone-uniqueness guard** on add & edit (rejects duplicates).

### Vitals
- **Per-department vitals toggle** — vitals can be required for every department or not, configurable in the HIS (implemented). Changes the report flow accordingly.

---

## Still open / next
- **Data deletion** (DPDP right-to-erasure) — needs a policy call (retention period, who approves, anonymize vs delete). Consent text now sets the retention expectation; an actual request→staff-review→delete flow is TBD.
- `DEMO_QR_SECRET` still has a weak default (prescription QR signing) — quick hardening pending.
- **python-backend cross-service auth** — `/api/ocr|report|triage|scribe` are unauthenticated (phase 2).
- Scale the OCR eval to ~30 verified Indian labels for a trustworthy accuracy number.
