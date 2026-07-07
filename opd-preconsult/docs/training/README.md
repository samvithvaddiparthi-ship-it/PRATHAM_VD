# Staff Training — OPD Pre-Consultation Pilot

Three one-page guides, one per role. **Print each and keep it at that station.**
They are deliberately short and non-technical — hand them out on day one and walk each
group through their guide once before the pilot opens.

| Role | Guide | Give to |
|------|-------|---------|
| Help-desk / social workers | [helpdesk-social-workers.md](helpdesk-social-workers.md) | Front desk, intake volunteers, kiosk helpers |
| Doctors | [doctors.md](doctors.md) | Every doctor using the dashboard |
| Admin / HIS operator | [admin.md](admin.md) | HIS operators, floor supervisors |

## The three messages every staff member must hear
1. **It fills the wait, it doesn't replace the doctor.** The AI drafts; the doctor decides.
2. **It's private.** Patient data is confidential PHI — only the care team may see it.
3. **There's always a paper fallback.** If the system is down, switch to paper and keep
   the queue moving (see the downtime SOP in `deploy/OPERATIONS.md`).

## Before go-live
- [ ] Admin has created real departments + doctors and **deactivated the demo doctors**.
- [ ] Every doctor has **changed their default PIN**.
- [ ] The **OPD poster QR** points at the live HTTPS address and is placed in the waiting area.
- [ ] Help-desk **tablet** is charged, on wifi, and can complete a test form.
- [ ] One **end-to-end test patient** has gone through successfully.
- [ ] Each station has this guide printed + the **support contact** card.

## Feedback during the pilot
- Doctors: rate each summary **Accurate / Inaccurate** (and edit when wrong) — this is our
  main quality signal.
- Everyone: note problems on the **feedback sheet** at each station or tell the shift lead;
  the team reviews them daily.
