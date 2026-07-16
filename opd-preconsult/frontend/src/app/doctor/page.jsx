'use client';
import { useState, useEffect, useRef, useMemo } from 'react';
import QRCode from 'qrcode';
import { api, setToken } from '../../lib/api';
import { formatPhoneDisplay } from '../../lib/phone';
import PasswordInput from '../../components/PasswordInput';
import TriageBadge from '../../components/TriageBadge';
import ReactMarkdown from 'react-markdown';
import { useConfirm, ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import VitalsForm, { hasVitals } from '../../components/VitalsForm';

const TRIAGE_COLORS = { RED: '#D9544D', AMBER: '#E0A82E', GREEN: '#3FA869' };
const TRIAGE_SEVERITY = { RED: 0, AMBER: 1, GREEN: 2 };

// True on phone-width viewports. The doctor dashboard is a desktop two-pane
// layout (queue list + report side by side); on phones we can't fit both, so we
// switch to a master-detail flow — the list OR the open patient's report, one at
// a time — driven by this flag. SSR-safe (defaults to false until mounted).
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);
  return isMobile;
}

function fmtVisitDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return ts; }
}

// Group a flat list of completed sessions into a patient directory keyed by
// phone. Each patient's visits are sorted newest-first; the newest visit is the
// "latest", and if it was completed within the active window (is_recent) the
// patient is treated as "filled now" — which drives the highlight and the
// triage colour on the patient heading. Patients with a filled-now visit float
// to the top (ordered by triage severity), the rest follow by recency.
function groupByPatient(list, myDept) {
  const map = new Map();
  for (const s of list) {
    // One phone may serve a whole family, so a patient is keyed by phone + name
    // (case/space-insensitive) — not phone alone — otherwise two different people
    // sharing a number would collapse into one card.
    const nameKey = (s.patient_name || '').trim().toLowerCase();
    const key = s.patient_phone ? `${s.patient_phone}|${nameKey}` : s.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const RELEASE_RECENT = v => !!v.released_at && (Date.now() - new Date(v.released_at).getTime() < 24 * 3600 * 1000);
  // A visit's "queue recency": a just-released visit ranks by its release time, so
  // releasing an OLD visit makes it the patient's representative entry (it floats
  // to the top of the queue), otherwise by when it was filled.
  const recencyOf = v => new Date((RELEASE_RECENT(v) && v.released_at) || v.created_at).getTime();
  const patients = [];
  for (const [key, visits] of map) {
    visits.sort((a, b) => recencyOf(b) - recencyOf(a));
    // Queue status (lock/consulting/triage/recency) is driven by the most recent
    // visit IN THIS DOCTOR'S department, so a patient reassigned across departments
    // never looks "active" in the wrong queue. `visits` still lists every visit
    // (all departments) so the full prior-visit history shows when expanded.
    const dep = myDept ? String(myDept).toUpperCase() : null;
    const latest = (dep && visits.find(v => String(v.department || '').toUpperCase() === dep)) || visits[0];
    const filledNow = !!latest.is_recent;
    patients.push({
      key,
      phone: latest.patient_phone || '',
      name: latest.patient_name || 'Unregistered',
      age: latest.patient_age,
      gender: latest.patient_gender,
      visits,
      latest,
      filledNow,
      releasedRecent: RELEASE_RECENT(latest),
      dispatched: !!latest.dispatched_at,            // finished (Save & QR) → leaves queue
      lockedById: latest.dispatched_at ? null : (latest.assigned_doctor_id || null),
      lockedByName: latest.dispatched_at ? null : (latest.doctor_name || null),
      // consulted_at is stamped only when a doctor actively OPENS a patient (and
      // cleared on reassign). It — not mere assignment — marks an active
      // consultation, so a patient just handed to me isn't counted as "open".
      consultedAt: latest.dispatched_at ? null : (latest.consulted_at || null),
      triage: filledNow ? latest.triage_level : null,
      // Optional patient-chosen preferred doctor (shown as a badge; not auto-routed).
      preferredDoctorId: latest.preferred_doctor_id || null,
      preferredDoctorName: latest.preferred_doctor_name || null,
    });
  }
  patients.sort((a, b) => {
    // A freshly-released visit pops to the very top (most recent release first),
    // so a doctor's deliberate "send back to queue" is immediately visible.
    if (a.releasedRecent !== b.releasedRecent) return a.releasedRecent ? -1 : 1;
    if (a.releasedRecent && b.releasedRecent) return new Date(b.latest.released_at) - new Date(a.latest.released_at);
    if (a.filledNow !== b.filledNow) return a.filledNow ? -1 : 1;
    if (a.filledNow && b.filledNow) {
      const d = (TRIAGE_SEVERITY[a.triage] ?? 3) - (TRIAGE_SEVERITY[b.triage] ?? 3);
      if (d !== 0) return d;
    }
    // Within the same triage level: first-come-first-served. The patient who
    // completed their pre-consult EARLIEST (waiting longest) comes first (FIFO).
    // Ascending arrival time — not newest-first, which would be unfair LIFO.
    return new Date(a.latest.created_at) - new Date(b.latest.created_at);
  });
  return patients;
}

// Loading placeholder rows (shown until the first queue/consulted fetch lands).
function SkeletonRows({ n = 4 }) {
  return (
    <div>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ background: '#fff', borderRadius: 8, padding: 12, marginBottom: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ height: 12, width: '55%', background: '#e6ebf1', borderRadius: 6, marginBottom: 8, animation: 'skpulse 1.2s ease-in-out infinite' }} />
          <div style={{ height: 10, width: '35%', background: '#eef2f6', borderRadius: 6, animation: 'skpulse 1.2s ease-in-out infinite' }} />
        </div>
      ))}
    </div>
  );
}

function PinLogin({ onLogin }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api.doctorLogin(phone, pin);
      onLogin(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: 16 }}>
      <form onSubmit={handleSubmit} style={{
        background: '#fff', borderRadius: 16, padding: 32, width: '100%', maxWidth: 360,
        boxShadow: '0 4px 24px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: 16
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 'calc(40px * var(--fs))', marginBottom: 8 }}>👨‍⚕️</div>
          <h2 style={{ color: 'var(--primary)', fontSize: 'calc(20px * var(--fs))' }}>Doctor Login</h2>
          <p style={{ color: 'var(--text-light)', fontSize: 'calc(13px * var(--fs))', marginTop: 4 }}>Enter your phone number and PIN</p>
        </div>
        <div>
          <label style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>Phone Number</label>
          <input className="input" type="tel" inputMode="numeric" maxLength={10} value={phone}
            onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="9876500001" required autoFocus />
        </div>
        <div>
          <label style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>PIN (4-6 digits)</label>
          <PasswordInput className="input" inputMode="numeric" maxLength={6} value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" required
            style={{ fontSize: 'calc(24px * var(--fs))', letterSpacing: 8, textAlign: 'center' }} />
        </div>
        {error && <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))', textAlign: 'center' }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading || pin.length < 4}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', textAlign: 'center' }}>Demo: Phone 9876500001, PIN 1234</p>
      </form>
    </div>
  );
}

function DoctorDashboard({ doctor }) {
  const [tab, setTab] = useState('queue'); // queue | consulted
  const [sessions, setSessions] = useState([]);
  const [consulted, setConsulted] = useState([]);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [docs, setDocs] = useState([]);                // patient-uploaded documents (prescriptions/reports) from MinIO
  const [loading, setLoading] = useState(false);
  const [doctors, setDoctors] = useState([]);
  const [rightTab, setRightTab] = useState('report'); // report | prescribe | uploaded (Scribe is embedded in Prescribe)
  // Once the doctor opens Prescribe for the selected patient we keep that panel
  // MOUNTED (just hidden) while they flip to Report/Scribe, so the saved
  // prescription + QR survive sub-tab switches instead of being rebuilt fresh.
  // Reset whenever a different patient is selected (see selectSession).
  const [prescribeMounted, setPrescribeMounted] = useState(false);
  const [feedbackGiven, setFeedbackGiven] = useState(null); // { id, val } — inline report-accuracy confirmation
  const [vitals, setVitals] = useState(null);        // selected session's vitals row (null = not loaded/none)
  const [vitalsOpen, setVitalsOpen] = useState(false); // doctor-side "add vitals" accordion expanded?
  const [vitalsSaving, setVitalsSaving] = useState(false);
  const [vitalsErr, setVitalsErr] = useState('');
  const [editing, setEditing] = useState(false);           // full report-edit editor open?
  const [editText, setEditText] = useState('');            // working copy of the report markdown
  const [savingEdit, setSavingEdit] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false); // toggle AI original vs doctor-edited
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);       // kebab (⋯) menu
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState({}); // patient phone -> open/closed in the tree
  const [seenNew, setSeenNew] = useState({});   // visit id -> doctor has opened it (clears the NEW badge, like WhatsApp unread)
  const [pinned, setPinned] = useState({});     // phones that showed up with a recent fill — kept visible even after that visit is deleted
  const [search, setSearch] = useState('');     // search (name or phone) — used on both tabs
  const [now, setNow] = useState(() => new Date()); // live clock
  const [queueLoaded, setQueueLoaded] = useState(false);       // first queue fetch done? (for skeletons)
  const [consultedLoaded, setConsultedLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);          // brief spin on the refresh icon
  const [voiceClips, setVoiceClips] = useState([]);             // patient's recorded voice answers for the selected visit
  const [audioOpen, setAudioOpen] = useState(false);            // patient-audio panel toggle (in the header, not a workflow tab)
  const [activeLock, setActiveLock] = useState(null);           // phone of the patient I've opened & not yet dispatched
  const [switchBlocked, setSwitchBlocked] = useState(false);    // tried to open another patient before finishing → red flash + message
  const [departments, setDepartments] = useState([]);           // all departments (for cross-dept reassign)
  const [reassignOpen, setReassignOpen] = useState(false);      // reassign popover toggle
  const isMobile = useIsMobile();                               // phone → master-detail (list OR report), not side-by-side

  useEffect(() => {
    loadQueue();
    // ALL active doctors (any dept) + departments — for cross-department reassign.
    api.listDoctors().then(setDoctors).catch(() => {});
    api.getDepartments().then(setDepartments).catch(() => {});
    const interval = setInterval(loadQueue, 10000);
    return () => clearInterval(interval);
  }, []);

  // Live clock — ticks every second for the header date/time.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function loadQueue() {
    try { setSessions(await api.doctorQueue()); } catch {} finally { setQueueLoaded(true); }
  }

  // Load the set of already-opened "NEW" visits so the badge stays cleared
  // across refreshes (like a read receipt). Keyed by visit id, so a genuinely
  // new fill (a new session) shows NEW again.
  useEffect(() => {
    try { setSeenNew(JSON.parse(localStorage.getItem('seen_new_visits') || '{}')); } catch {}
  }, []);

  // Remember every patient who has shown up with a recent ("filled now") visit.
  // They stay in the Queue tree even if that recent visit is later deleted, so
  // deleting one entry doesn't make the whole patient (and their older visits)
  // vanish. Patients who never had a recent fill are never pinned, so they stay
  // hidden. Resets on a full page reload (then the recent-only rule applies).
  useEffect(() => {
    const recent = groupByPatient(sessions, doctor?.department).filter(p => p.filledNow).map(p => p.key);
    if (!recent.length) return;
    setPinned(prev => {
      let changed = false;
      const next = { ...prev };
      for (const k of recent) if (!next[k]) { next[k] = true; changed = true; }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Keep activeLock in sync with the server's truth: whatever patient is locked
  // to me (assigned, not yet dispatched) IS my active consultation. This both
  // restores the lock after a browser reload and clears it once I finish/abandon
  // — so I can never get stuck, and can never hold two at once.
  useEffect(() => {
    // My active consultation = a patient assigned to me that I've OPENED
    // (consulted_at set). A patient merely reassigned to me (consulted_at null)
    // is NOT an active consultation, so it never holds the single-consult lock.
    const mine = groupByPatient(sessions, doctor?.department).find(p => p.lockedById === doctor.id && p.consultedAt && !p.dispatched);
    if (mine && activeLock !== mine.key) setActiveLock(mine.key);
    else if (!mine && activeLock) setActiveLock(null);
  }, [sessions]);

  // One-time toast when a patient is reassigned TO me (specific-doctor handoff).
  // Seeds silently on the first real queue load so pre-existing handoffs don't
  // toast on page open; only genuinely new, unacknowledged handoffs notify.
  const handoffNotifiedRef = useRef(null);
  useEffect(() => {
    if (!queueLoaded) return;
    // Pending handoff to me = assigned to me, has a "reassigned_by", and I haven't
    // opened it yet (consulted_at null). Cleared automatically once I open it.
    const mine = sessions.filter(s =>
      s.assigned_doctor_id === doctor.id && s.reassigned_by && !s.consulted_at && !s.dispatched_at);
    if (handoffNotifiedRef.current === null) {
      handoffNotifiedRef.current = new Set(mine.map(s => s.id));
      return;
    }
    for (const s of mine) {
      if (!handoffNotifiedRef.current.has(s.id)) {
        handoffNotifiedRef.current.add(s.id);
        toast(`⇄ ${s.patient_name || 'A patient'} was assigned to you by ${s.reassigned_by}`, 'success');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, queueLoaded]);

  function markSeen(visitId) {
    setSeenNew(prev => {
      if (prev[visitId]) return prev;
      const next = { ...prev, [visitId]: true };
      try { localStorage.setItem('seen_new_visits', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function loadConsulted() {
    try { setConsulted(await api.doctorConsulted()); } catch {} finally { setConsultedLoaded(true); }
  }

  function switchTab(t) {
    // Can't leave to Consulted mid-consultation — finish (Save & Generate QR) first.
    if (t === 'consulted' && activeLock) { setSwitchBlocked(true); return; }
    setTab(t);
    setSelected(null);
    setReport(null);
    setSearch('');
    if (t === 'consulted') loadConsulted();
    else loadQueue();   // queue + consulting both derive from the queue fetch
  }

  async function selectSession(s) {
    setSelected(s);
    setReport(null);
    setRightTab('report');
    setPrescribeMounted(false);   // fresh Prescribe panel for the newly-opened patient
    setReassignOpen(false);       // close any open reassign popover
    setLoading(true);
    // No auto-assign here — locking a queue patient happens explicitly via
    // openPatient() (with the confirm dialog). selectSession just loads a visit.
    try { setReport(await api.getReport(s.id)); } catch { setReport(null); }
    setLoading(false);
    // Load any documents the patient uploaded at entry (prescriptions, lab reports,
    // etc. — stored in MinIO) so the doctor can view the originals. May be several.
    setDocs([]);
    api.getDocuments(s.id).then(d => setDocs(Array.isArray(d) ? d : [])).catch(() => setDocs([]));
    // Load the patient's recorded voice answers (if any) for playback.
    setVoiceClips([]);
    setAudioOpen(false);
    api.getAnswerAudio(s.id).then(c => setVoiceClips(Array.isArray(c) ? c : [])).catch(() => setVoiceClips([]));
    // Load vitals so we can offer late entry when the patient skipped them.
    setVitals(null); setVitalsOpen(false); setVitalsErr('');
    api.getVitals(s.id).then(setVitals).catch(() => setVitals(null));
    // Reset the report-correction editor for the new patient.
    setEditing(false); setEditText(''); setShowOriginal(false);
  }

  async function saveReportEdit() {
    if (!selected) return;
    setSavingEdit(true);
    try {
      await api.saveReportEdit(selected.id, editText);
      setReport(await api.getReport(selected.id));   // now carries the edited body
      setEditing(false);
      setShowOriginal(false);
      setFeedbackGiven({ id: selected.id, val: 'inaccurate' });
    } catch {
      toast('Could not save the edited report — please try again', 'error');
    } finally {
      setSavingEdit(false);
    }
  }

  // Doctor/nurse records vitals for a patient who skipped them. Same sequence as
  // the patient side — re-run triage + regenerate the report so the values (and
  // any escalation) show up here. Then refresh the report + vitals in place.
  async function saveVitals(data) {
    if (!selected) return;
    setVitalsSaving(true);
    setVitalsErr('');
    try {
      await api.submitVitals(selected.id, { ...data, source: 'nurse' });
      const tri = await api.evaluate(selected.id);
      await api.generateReport(selected.id, { force: true });   // vitals changed → refresh in place
      const [rep, v] = await Promise.all([api.getReport(selected.id), api.getVitals(selected.id)]);
      setReport(rep);
      setVitals(v);
      setVitalsOpen(false);
      // Reflect any triage change immediately on the selected patient's badge.
      setSelected(prev => (prev && prev.id === selected.id ? { ...prev, triage_level: tri.level } : prev));
      loadQueue();  // refresh the queue list too
    } catch (err) {
      setVitalsErr('Could not save vitals: ' + (err.message || 'unknown error') + '. Please try again.');
    } finally {
      setVitalsSaving(false);
    }
  }

  async function handleUnassign() {
    if (!selected) return;
    if (!(await confirm({
      title: 'Release this patient?',
      message: 'This returns the patient to the unassigned pool so another doctor can pick them up.',
      confirmLabel: 'Release',
    }))) return;
    try {
      await api.doctorUnassign(selected.id);
      setSelected(null);
      setReport(null);
      loadQueue();
    } catch (err) {
      toast('Release failed: ' + (err.message || 'unknown error'), 'error');
    }
  }

  // Open a QUEUE patient (the tree root). Confirms, then acquires an exclusive
  // lock. While I hold a lock on someone, clicking a DIFFERENT patient is blocked
  // (red flash + message) until I finish them with Save & Generate QR.
  async function openPatient(p) {
    // ACTIVE consultation I already hold = assigned to me AND opened (consulted_at
    // set), or the optimistic activeLock. A patient merely reassigned to me
    // (consulted_at null) is NOT yet open — it must go through the lock flow below,
    // so it still counts against the "one consultation at a time" rule.
    const activelyMine = (p.lockedById === doctor.id && p.consultedAt) || activeLock === p.key;
    const lockedByOther = p.lockedById && p.lockedById !== doctor.id && activeLock !== p.key;

    // Already my open consultation → no confirm needed.
    if (activelyMine) {
      // Desktop: both panes are on screen, so this is a pure accordion — toggle the
      // visit tree and leave the report pane alone.
      //
      // Phone: the report pane is display:none until something is selected, and the
      // visit tree is the only thing that moves. Tapping your own open patient
      // therefore looked like a dead tap — you had to know to tap the visit row
      // underneath. Select the latest visit too, so one tap opens the report (the
      // tree stays expanded, so "← Back to list" still shows the visit history).
      if (isMobile) {
        setExpanded(e => ({ ...e, [p.key]: true }));
        if (p.latest) { markSeen(p.latest.id); selectSession({ ...p.latest, assigned_doctor_id: doctor.id }); }
      } else {
        setExpanded(e => ({ ...e, [p.key]: !e[p.key] }));
      }
      return;
    }
    // I'm mid-consultation with someone else → block opening a second one.
    if (activeLock && activeLock !== p.key) {
      setSwitchBlocked(true);
      return;
    }
    // Held by another doctor → can't open.
    if (lockedByOther) {
      toast(`Being consulted by ${p.lockedByName || 'another doctor'}`, 'error');
      return;
    }
    // Free → confirm, then lock.
    if (!(await confirm({
      title: 'Open & lock this patient?',
      message: `${p.name} · ${formatPhoneDisplay(p.phone)}\nOnce you open them, other doctors won't be able to view this patient until you finish (Save & Generate QR).`,
      confirmLabel: 'Open & lock',
    }))) return;

    const res = await api.doctorOpen(p.latest.id).catch(() => ({ ok: false, error: true }));
    if (res.ok) {
      setActiveLock(p.key);
      setExpanded(e => ({ ...e, [p.key]: true }));
      markSeen(p.latest.id);
      // The server just assigned this visit to me (doctorOpen). Reflect that on the
      // selected object right away — otherwise `selected.assigned_doctor_id` stays
      // null (the pre-open cache) and the Reassign button stays hidden until a
      // fresh reselect.
      selectSession({ ...p.latest, assigned_doctor_id: doctor.id });
      setTab('consulting');   // patient is now in-progress → move to the Consulting tab
      loadQueue();
    } else if (res.locked) {
      toast(res.message || `Being consulted by ${res.locked_by || 'another doctor'}`, 'error');
      loadQueue();
    } else {
      toast('Could not open patient — please try again.', 'error');
    }
  }

  // Called by PrescriptionPanel after a successful Save & Generate QR: the visit
  // is dispatched (now in Consulted, gone from the queue) and the lock is freed.
  function handleDispatched() {
    setActiveLock(null);
    // Mark the currently-selected visit dispatched in-memory right away, so the
    // tab flips to "Prescribed" immediately — without waiting for a reselect or
    // the queue refetch to land.
    setSelected(prev => (prev && !prev.dispatched_at ? { ...prev, dispatched_at: new Date().toISOString() } : prev));
    loadQueue();
    loadConsulted();
    // After Save & Generate QR the visit belongs to Consulted, so jump the left
    // list there. To revert to "stay on Queue", delete just this one line.
    setTab('consulted');
  }

  // Release the patient I've opened back to the active queue — for when a patient
  // was opened by mistake. Clears the doctor link + consulted stamp on the server
  // (which also frees my active lock) and pops the visit to the top of the queue as
  // a NEW entry. We also un-"see" the visit locally so its NEW badge shows again.
  async function handleRelease() {
    if (!selected) return;
    if (!(await confirm({
      title: 'Release back to queue?',
      message: 'This ends your consultation with this patient and sends them back to the top of the active queue as a new entry.',
      confirmLabel: 'Release',
    }))) return;
    try {
      await api.doctorRelease(selected.id);
      setSeenNew(prev => {
        if (!prev[selected.id]) return prev;
        const next = { ...prev };
        delete next[selected.id];
        try { localStorage.setItem('seen_new_visits', JSON.stringify(next)); } catch {}
        return next;
      });
      setSelected(null);
      setReport(null);
      loadConsulted();
      loadQueue();
      toast('Released back to the queue', 'success');
    } catch (err) {
      toast('Release failed: ' + (err.message || 'unknown error'), 'error');
    }
  }

  // Reassign the selected queue patient to a specific doctor (their department
  // follows, so the visit lands in that doctor's queue).
  async function handleReassignDoctor(doc) {
    if (!selected || !doc) return;
    if (!(await confirm({
      title: 'Reassign patient?',
      message: `Reassign ${selected.patient_name || 'this patient'} to ${doc.name} (${doc.department}). They'll move to that doctor's queue and leave yours.`,
      confirmLabel: 'Reassign',
    }))) return;
    try {
      await api.doctorReassign(selected.id, doc.id);
      setReassignOpen(false); setSelected(null); setReport(null); loadQueue();
      toast(`Reassigned to ${doc.name}`, 'success');
    } catch (err) {
      toast('Reassign failed: ' + (err.message || 'unknown error'), 'error');
    }
  }

  // Reassign the selected queue patient to another department's general queue.
  async function handleReassignDept(dept) {
    if (!selected || !dept) return;
    if (!(await confirm({
      title: 'Send to another department?',
      message: `Move ${selected.patient_name || 'this patient'} to the ${dept.name} general queue. They'll leave your queue and any ${dept.name} doctor can pick them up.`,
      confirmLabel: 'Move to ' + dept.name,
    }))) return;
    try {
      await api.doctorReassignDept(selected.id, dept.code);
      setReassignOpen(false); setSelected(null); setReport(null); loadQueue();
      toast(`Moved to ${dept.name} queue`, 'success');
    } catch (err) {
      toast('Reassign failed: ' + (err.message || 'unknown error'), 'error');
    }
  }

  // Permanently delete the selected patient entry. Irreversible, so it is the one
  // confirmation that also demands an explicit acknowledgement tick.
  async function handleDelete() {
    if (!selected || deleting) return;
    const ok = await confirm({
      title: 'Remove patient entry?',
      message: (
        <>
          This removes <strong>{selected.patient_name}</strong> from the active dashboard (Queue) and from
          the patient's previous-visit history. If this visit was consulted, it <strong>stays in your
          Consulted history</strong> for the record — so you keep what they were seen for.
        </>
      ),
      acknowledge: 'I understand this removes the patient from the active dashboard.',
      confirmLabel: 'Remove from Dashboard',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.doctorDeleteSession(selected.id);
      setSelected(null);
      setReport(null);
      loadQueue();
      loadConsulted();
    } catch (err) {
      toast('Delete failed: ' + (err.message || 'unknown error'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function handleFeedback(val) {
    if (!selected) return;
    try {
      await api.submitFeedback(selected.id, val);
      setFeedbackGiven({ id: selected.id, val });
    } catch {
      setFeedbackGiven({ id: selected.id, val: 'error' });
    }
  }

  // Refresh the active tab. Spins only for the actual fetch — no artificial delay.
  async function refreshActive() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await (tab === 'consulted' ? loadConsulted() : loadQueue());
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogout() {
    if (!(await confirm({
      title: 'Log out?',
      message: 'You’ll be returned to the login screen and will need your PIN to sign back in.',
      confirmLabel: 'Log out',
    }))) return;
    setToken(null);
    sessionStorage.removeItem('doctor_token');
    sessionStorage.removeItem('doctor_info');
    window.location.reload();
  }


  // Mandatory report review before prescribing: the doctor must record a verdict
  // (Report Accurate, or Inaccurate via saving an edit) before the Prescribe tab
  // unlocks. Persists via the saved doctor_feedback, so a reviewed patient stays
  // unlocked when reopened. If there's no report at all, don't trap them.
  const reportReviewed = !report
    || !!report.doctor_feedback
    || (feedbackGiven?.id === selected?.id && (feedbackGiven?.val === 'accurate' || feedbackGiven?.val === 'inaccurate'));
  const prescribeLocked = tab !== 'consulted' && !!selected && !reportReviewed;
  // A finished visit (already dispatched via Save & Generate QR) is a done record,
  // not an action — so the tab reads "Prescribed" (past tense) and is never locked.
  const visitDone = !!selected && !!selected.dispatched_at;
  // Queue tree: show patients with a "filled now" visit (completed in the last
  // 24h) — i.e. patients who are actually here now — plus any patient already
  // pinned this session (they appeared with a recent fill, so they stay visible
  // even after that visit is deleted). A patient with ONLY old visits and no
  // recent fill (never pinned) does not show up.
  // Queue excludes DISPATCHED patients (finished via Save & Generate QR — they
  // move to Consulted). Locked-but-not-finished patients stay (shown in-progress).
  // Split the active (non-dispatched) patients into WAITING (Queue) and
  // IN-PROGRESS (Consulting). A patient a doctor has opened (consulted_at set) is
  // being consulted → Consulting tab; everyone else openable → Queue. This keeps
  // the Queue from filling up with patients already under consultation.
  const allActive = groupByPatient(sessions, doctor?.department).filter(p => !p.dispatched);
  const waitingPatients = allActive.filter(p => (p.filledNow || pinned[p.key]) && !p.consultedAt);
  const consultingPatients = allActive.filter(p => !!p.consultedAt);
  const patients = tab === 'consulting' ? consultingPatients : waitingPatients; // active tab's list
  // Consulted: a flat list of INDIVIDUAL consulted visits (NOT grouped per
  // patient). Every form a patient filled and the doctor consulted is its own
  // entry — so a returning patient who fills the form again appears as a new,
  // separate row, with that visit's OWN triage colour (a past RED visit stays
  // red; a later YELLOW visit shows yellow, independently). Order is FIXED by
  // when each visit was first consulted (consulted_at, stamped once), newest
  // consult first, so re-opening a visit never reshuffles the list.
  const consultedList = [...consulted].sort((a, b) => {
    const ta = a.dispatched_at || a.consulted_at || a.updated_at;
    const tb = b.dispatched_at || b.consulted_at || b.updated_at;
    return new Date(tb) - new Date(ta);
  });

  // Search (name OR phone, case-insensitive), applied to whichever tab is active.
  const q = search.trim().toLowerCase();
  const filteredConsulted = !q ? consultedList : consultedList.filter(s =>
    (s.patient_name || '').toLowerCase().includes(q) || (s.patient_phone || '').includes(search.trim())
  );
  const filteredPatients = !q ? patients : patients.filter(p =>
    (p.name || '').toLowerCase().includes(q) || (p.phone || '').includes(search.trim())
  );

  // Shadow (ghost) prediction: complete the search with the best match from the
  // active tab's list — name first, then phone — whose value STARTS WITH input.
  const searchSource = tab === 'consulted'
    ? consultedList.map(s => ({ name: s.patient_name || '', phone: s.patient_phone || '' }))
    : patients.map(p => ({ name: p.name, phone: p.phone }));
  const suggestion = (() => {
    if (!q) return '';
    for (const e of searchSource) if ((e.name || '').toLowerCase().startsWith(q)) return e.name;
    for (const e of searchSource) if ((e.phone || '').startsWith(search.trim())) return e.phone;
    return '';
  })();
  const shadowRemainder = suggestion && suggestion.length > search.length ? suggestion.slice(search.length) : '';

  // Triage counts among current queue patients (legend + summary bar).
  const triageCounts = patients.reduce((acc, p) => {
    if (p.triage) acc[p.triage] = (acc[p.triage] || 0) + 1;
    return acc;
  }, { RED: 0, AMBER: 0, GREEN: 0 });

  // Triage counts among the (filtered) consulted visits — same breakdown bar
  // for the Consulted tab as the Queue tab.
  const consultedTriageCounts = filteredConsulted.reduce((acc, s) => {
    if (s.triage_level) acc[s.triage_level] = (acc[s.triage_level] || 0) + 1;
    return acc;
  }, { RED: 0, AMBER: 0, GREEN: 0 });

  // "Consulted today" count.
  const todayStr = now.toDateString();
  const consultedTodayCount = consultedList.filter(s => {
    const t = s.dispatched_at || s.consulted_at || s.updated_at;
    return t && new Date(t).toDateString() === todayStr;
  }).length;

  // Header date/time + time-of-day greeting.
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <div className="doctor-layout" style={{ display: 'flex', gap: 16, boxSizing: 'border-box',
      // Desktop: two fixed-height panes side by side. Phone: stack, let the page
      // scroll normally so nothing is clipped off the right edge.
      flexDirection: isMobile ? 'column' : 'row',
      height: isMobile ? 'auto' : '100vh',
      minHeight: isMobile ? '100dvh' : undefined,
      overflow: isMobile ? 'visible' : 'hidden' }}>
      {dialog}
      {toastView}
      {/* Blocked-switch notice — you must finish the current patient first.
          Rendered at the top level (not inside the report pane) so it also shows
          on phones, where the report pane is display:none while the list is up.
          Uses ConfirmDialog (hideCancel ⇒ role="alertdialog") for the focus trap
          and Escape handling. Not routed through useConfirm: the same
          `switchBlocked` flag also tints the report pane red, so it has to stay a
          plain boolean rather than a promise. */}
      {switchBlocked && (
        <ConfirmDialog
          hideCancel
          danger
          icon="✋"
          title="Finish current patient first"
          message={<>You're currently consulting a patient. Complete their prescription and click <strong>Save &amp; Generate QR</strong> before opening another patient.</>}
          confirmLabel="OK"
          onConfirm={() => setSwitchBlocked(false)}
          onCancel={() => setSwitchBlocked(false)}
        />
      )}
      {/* Left Panel — fixed-height column: the header/tabs/search stay put while
          only the patient list below scrolls in its own scrollbar. On phone it
          becomes full-width and is hidden once a patient is opened (detail view). */}
      <div style={{
        width: isMobile ? '100%' : 340,
        flexShrink: 0,
        position: isMobile ? 'static' : 'sticky',
        top: isMobile ? undefined : 16,
        height: isMobile ? 'auto' : 'calc(100vh - 32px)',
        display: (isMobile && selected) ? 'none' : 'flex',
        flexDirection: 'column' }}>
        <style>{`@keyframes skpulse { 0%,100% { opacity:1 } 50% { opacity:.45 } } @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', margin: 0 }}>{greeting},</p>
            <h2 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', margin: '1px 0' }}>{doctor.name}</h2>
            <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', margin: 0 }}>{doctor.department} Department</p>
            <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 5 }}>🗓️ {dateStr} · {timeStr}</p>
          </div>
          <button onClick={handleLogout} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>Logout</button>
        </div>

        {/* Tabs: Waiting → In-progress → Done */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button className={`btn ${tab === 'queue' ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: 1, fontSize: 'calc(12px * var(--fs))', minHeight: 36, padding: '0 6px' }} onClick={() => switchTab('queue')}>
            Queue ({waitingPatients.length})
          </button>
          <button className={`btn ${tab === 'consulting' ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: 1, fontSize: 'calc(12px * var(--fs))', minHeight: 36, padding: '0 6px' }} onClick={() => switchTab('consulting')}>
            Consulting ({consultingPatients.length})
          </button>
          <button className={`btn ${tab === 'consulted' ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: 1, fontSize: 'calc(12px * var(--fs))', minHeight: 36, padding: '0 6px' }} onClick={() => switchTab('consulted')}>
            Consulted
          </button>
        </div>

        {/* Search box (both tabs) — filters by name or phone, with inline ghost prediction */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <div aria-hidden style={{ position: 'absolute', inset: 0, padding: '8px 10px', border: '1px solid transparent', fontSize: 'calc(13px * var(--fs))', fontFamily: 'inherit', whiteSpace: 'pre', overflow: 'hidden', pointerEvents: 'none', color: 'var(--text-light)', boxSizing: 'border-box' }}>
            <span style={{ visibility: 'hidden' }}>{search}</span>{shadowRemainder}
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Tab' || e.key === 'ArrowRight') && shadowRemainder) { e.preventDefault(); setSearch(suggestion); }
              else if (e.key === 'Escape') setSearch('');
            }}
            placeholder="🔍 Search name or phone…"
            style={{ position: 'relative', background: 'transparent', width: '100%', padding: '8px 10px', border: '1px solid #ccc', borderRadius: 8, fontSize: 'calc(13px * var(--fs))', fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
        </div>

        {/* QUEUE tab → patient directory tree (grouped by phone). Each patient
            heading is coloured by the triage of their latest visit, but only if
            that visit was "filled now" (completed within the active window). */}
        {/* List header — the count for the active tab on the left, and (queue
            only) the triage breakdown for non-zero levels on the right. Sits
            directly above the list it describes, with a divider, instead of
            floating in the middle of the panel. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 2px 7px', borderBottom: '1px solid #e6ebf1', marginBottom: 10 }}>
          <span style={{ fontSize: 'calc(12.5px * var(--fs))', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
            {tab === 'queue'
              ? <>{filteredPatients.length} waiting</>
              : tab === 'consulting'
              ? <>{filteredPatients.length} in consultation</>
              : <>{filteredConsulted.length} consulted{consultedTodayCount > 0 && <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> · {consultedTodayCount} today</span>}</>}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {(() => {
              const counts = tab === 'consulted' ? consultedTriageCounts : triageCounts;
              return ['RED', 'AMBER', 'GREEN'].some(l => counts[l] > 0) && (
                <span style={{ display: 'inline-flex', gap: 9, fontSize: 'calc(12px * var(--fs))' }}>
                  {['RED', 'AMBER', 'GREEN'].filter(l => counts[l] > 0).map(l => (
                    <span key={l} title={l === 'RED' ? 'Severe' : l === 'AMBER' ? 'Moderate' : 'Mild'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: TRIAGE_COLORS[l], fontWeight: 700 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: TRIAGE_COLORS[l], display: 'inline-block' }} />
                      {counts[l]}
                    </span>
                  ))}
                </span>
              );
            })()}
            {/* Compact labelled refresh — reloads whichever tab is active. The
                word keeps it discoverable; spins briefly on click. */}
            <button onClick={refreshActive} disabled={refreshing}
              title="Refresh list" aria-label="Refresh"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 10px', borderRadius: 13, border: '1px solid #d5dce4', background: '#fff', color: 'var(--secondary)', cursor: refreshing ? 'default' : 'pointer', fontSize: 'calc(12px * var(--fs))', fontWeight: 600, lineHeight: 1, opacity: refreshing ? 0.7 : 1 }}>
              <span style={{ display: 'inline-block', fontSize: 'calc(14px * var(--fs))', animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}>↻</span>
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </span>
        </div>

        {/* Scrollable list region — flex:1 so it fills the remaining column
            height, with its own vertical scrollbar (the rest of the panel and
            the right report pane stay fixed). */}
        <div className="scrolly" style={{ flex: 1, minHeight: 0, marginRight: -6, paddingRight: 6 }}>
        {(tab === 'queue' || tab === 'consulting') && (!queueLoaded || refreshing) && <SkeletonRows n={Math.max(3, Math.min(filteredPatients.length || 4, 6))} />}
        {(tab === 'queue' || tab === 'consulting') && queueLoaded && !refreshing && filteredPatients.map(p => {
          const assignedToMe = !!(p.lockedById && p.lockedById === doctor.id);
          // "Locked by me" = an ACTIVE consultation I've opened (consulted_at set),
          // not a patient merely assigned/handed to me (those stay in the queue).
          const lockedByMe = (assignedToMe && p.consultedAt) || activeLock === p.key;
          const lockedByOther = p.lockedById && p.lockedById !== doctor.id && activeLock !== p.key;
          // Pending handoff: reassigned to me and not yet opened — shows the alert chip.
          const pendingHandoff = assignedToMe && p.latest.reassigned_by && !p.consultedAt;
          // Only the patient I currently hold shows its visit tree — others can't
          // be expanded/peeked (opening = locking, which requires the confirm).
          const isOpen = lockedByMe && !!expanded[p.key];
          const headColor = p.triage ? TRIAGE_COLORS[p.triage] : null;
          return (
            <div key={p.key} style={{ marginBottom: 8 }}>
              {/* Patient heading */}
              <div onClick={() => openPatient(p)}
                /* Header tinted by the patient's current triage; greyed out when
                   another doctor holds the lock. */
                style={{ display: 'flex', alignItems: 'stretch', gap: 8, cursor: lockedByOther ? 'not-allowed' : 'pointer', padding: '8px 10px', borderRadius: 8, background: lockedByOther ? '#F2F3F5' : (headColor ? `${headColor}14` : '#fff'), boxShadow: '0 1px 3px rgba(0,0,0,0.06)', opacity: lockedByOther ? 0.75 : 1, outline: lockedByMe ? '2px solid var(--secondary)' : 'none', outlineOffset: -2 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fs))', color: 'var(--text)', overflowWrap: 'anywhere' }}>{p.name}</p>
                  <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{formatPhoneDisplay(p.phone)} · {p.visits.length} visit{p.visits.length > 1 ? 's' : ''}</p>
                  {lockedByOther && (
                    <p style={{ fontSize: 'calc(10.5px * var(--fs))', color: '#C0392B', fontWeight: 600, marginTop: 2 }}>🔒 Being consulted by {p.lockedByName || 'another doctor'}</p>
                  )}
                  {lockedByMe && (
                    <p style={{ fontSize: 'calc(10.5px * var(--fs))', color: 'var(--secondary)', fontWeight: 600, marginTop: 2 }}>● You're consulting</p>
                  )}
                  {pendingHandoff && (
                    <span style={{ display: 'inline-block', marginTop: 4, fontSize: 'calc(10.5px * var(--fs))', fontWeight: 700, color: '#0D47A1', background: '#E3F2FD', border: '1px solid #64B5F6', borderRadius: 4, padding: '3px 7px' }}>
                      ⇄ Assigned to you by {p.latest.reassigned_by}
                    </span>
                  )}
                  {p.preferredDoctorName && (
                    // Patient's preferred doctor — green "prefers you" when it's this
                    // doctor, amber otherwise. A hint for manual routing, not a lock.
                    <span style={{ display: 'inline-block', marginTop: 4, fontSize: 'calc(10.5px * var(--fs))', fontWeight: 700,
                      color: p.preferredDoctorId === doctor.id ? '#1E8449' : '#8A6D1A',
                      background: p.preferredDoctorId === doctor.id ? '#E8F6EE' : '#FCF3D9',
                      border: `1px solid ${p.preferredDoctorId === doctor.id ? '#9AD3B2' : '#E5C77A'}`,
                      borderRadius: 4, padding: '3px 7px' }}>
                      ⭐ Prefers {p.preferredDoctorName}{p.preferredDoctorId === doctor.id ? ' (you)' : ''}
                    </span>
                  )}
                </div>
                <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6 }}>
                  {p.triage ? <TriageBadge level={p.triage} compact /> : <span />}
                  {lockedByOther ? (
                    <span style={{ fontSize: 'calc(14px * var(--fs))' }}>🔒</span>
                  ) : (p.filledNow && !seenNew[p.latest.id]) ? (
                    // Not tinted by triage: white on the amber swatch is 1.93:1, and
                    // the TriageBadge chip directly above already carries the level.
                    // This badge only means "arrived since you last looked".
                    <span style={{ fontSize: 'calc(10px * var(--fs))', background: 'var(--primary)', color: '#fff', padding: '2px 6px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.3 }}>NEW</span>
                  ) : (
                    <span style={{ fontSize: 'calc(14px * var(--fs))', color: 'var(--text-light)' }}>{isOpen ? '▾' : '▸'}</span>
                  )}
                </div>
              </div>
              {/* Visits (newest first) */}
              {isOpen && (
                <div style={{ marginLeft: 14, marginTop: 4, borderLeft: '1px solid #E0E0E0', paddingLeft: 10 }}>
                  {p.visits.map((v, vi) => {
                    const isFilledNow = vi === 0 && p.filledNow;
                    const isReleased = vi === 0 && p.releasedRecent;
                    const isSel = selected?.id === v.id;
                    // Every visit row gets a light tint of its OWN triage colour
                    // (matching the outer cards). The current "filled now" visit is
                    // only slightly deeper + a soft, low-opacity triage border —
                    // a gentle highlight, not the old harsh yellow-and-bright-edge.
                    const vColor = v.triage_level ? TRIAGE_COLORS[v.triage_level] : null;
                    return (
                      <div key={v.id} onClick={() => { markSeen(v.id); selectSession(v); }}
                        style={{ padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 6,
                          // Each visit is its own boxed card. Triage is shown via
                          // the chip; the active "Filled now" visit (or selected)
                          // is accented with a coloured 3px left rail.
                          background: isSel ? '#EAF2F8' : '#fff',
                          border: '1px solid #E6EBF1',
                          borderLeftWidth: 3,
                          borderLeftColor: isSel ? 'var(--secondary)' : (isFilledNow && vColor ? vColor : '#E6EBF1'),
                          boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {v.triage_level && <TriageBadge level={v.triage_level} compact />}
                          <div style={{ flex: 1 }}>
                            <p style={{ fontSize: 'calc(12px * var(--fs))', fontWeight: 600 }}>
                              {isReleased ? '↩ Returned to queue' : isFilledNow ? '★ Filled now' : fmtVisitDate(v.created_at)}
                            </p>
                            {(isFilledNow || isReleased) && <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>{fmtVisitDate(v.created_at)}</p>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {(tab === 'queue' || tab === 'consulting') && queueLoaded && !refreshing && filteredPatients.length === 0 && (
          <p style={{ color: 'var(--text-light)', padding: 16, textAlign: 'center' }}>
            {q ? `No patients match “${search.trim()}”`
              : tab === 'consulting' ? 'No patients currently being consulted'
              : 'No patients waiting'}
          </p>
        )}

        {tab === 'consulted' && (!consultedLoaded || refreshing) && <SkeletonRows n={Math.max(3, Math.min(filteredConsulted.length || 4, 6))} />}

        {/* CONSULTED tab → every consulted visit as its own individual entry,
            each with that visit's own triage colour, newest-consult first. */}
        {tab === 'consulted' && consultedLoaded && !refreshing && filteredConsulted.map(s => {
          const tColor = s.triage_level ? TRIAGE_COLORS[s.triage_level] : null;
          const isSel = selected?.id === s.id;
          return (
          <div key={s.id} className="queue-item" onClick={() => selectSession(s)}
            style={{ background: tColor ? `${tColor}14` : undefined, outline: isSel ? '2px solid var(--secondary)' : 'none', outlineOffset: -2 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <p style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fs))', color: 'var(--text)', minWidth: 0, overflowWrap: 'anywhere' }}>{s.patient_name || 'Unregistered'}</p>
                {s.triage_level && <div style={{ flexShrink: 0 }}><TriageBadge level={s.triage_level} compact /></div>}
              </div>
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>
                {s.patient_age ? `${s.patient_age}y` : ''} {s.patient_gender || ''}
              </p>
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>
                🕒 Consulted: {fmtVisitDate(s.dispatched_at || s.consulted_at || s.updated_at)}
              </p>
              {s.doctor_feedback && (
                <span style={{ fontSize: 'calc(10px * var(--fs))', background: s.doctor_feedback === 'accurate' ? '#D5F5E3' : '#FADBD8',
                  color: s.doctor_feedback === 'accurate' ? '#1E8449' : '#C0392B', padding: '2px 6px', borderRadius: 4 }}>
                  {s.doctor_feedback === 'accurate' ? '✓ Accurate' : '✗ Inaccurate'}
                </span>
              )}
            </div>
          </div>
          );
        })}
        {tab === 'consulted' && consultedLoaded && !refreshing && filteredConsulted.length === 0 && (
          <p style={{ color: 'var(--text-light)', padding: 16, textAlign: 'center' }}>
            {q ? `No consulted entries match “${search.trim()}”` : 'No consulted patients yet'}
          </p>
        )}
        </div>
      </div>

      {/* Right Panel — own height + internal scroll so the report scrolls
          inside the card and never nudges the whole page at the edges. */}
      <div className="scrolly" style={{ flex: 1, minWidth: 0,
        // Desktop: fixed full-height pane that scrolls internally. Phone: hidden
        // until a patient is picked, then full-width with natural page scroll.
        display: (isMobile && !selected) ? 'none' : 'block',
        height: isMobile ? 'auto' : '100%',
        overflowY: isMobile ? 'visible' : undefined,
        padding: isMobile ? 16 : 24,
        background: switchBlocked ? '#FDF1EF' : 'var(--card-bg)', borderRadius: 16, border: switchBlocked ? '1.5px solid #E6A79F' : '1.5px solid transparent', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', transition: 'background 0.15s, border-color 0.15s' }}>
        {/* Phone-only: return to the queue list (the list is hidden while a
            patient is open). Deselecting only changes the view — any active
            consultation lock is kept, so the patient can be reopened. */}
        {isMobile && selected && (
          <button onClick={() => { setSelected(null); setReport(null); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, background: 'none', border: '1px solid #d5dce4', borderRadius: 8, padding: '7px 12px', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, color: 'var(--secondary)', cursor: 'pointer' }}>
            ← Back to list
          </button>
        )}
        {!selected && (
          <div style={{ textAlign: 'center', marginTop: 90, color: 'var(--text-light)' }}>
            <div style={{ fontSize: 'calc(56px * var(--fs))', marginBottom: 14, opacity: 0.45 }}>{tab === 'consulted' ? '📋' : tab === 'consulting' ? '🩺' : '🩺'}</div>
            <p style={{ fontSize: 'calc(16px * var(--fs))', fontWeight: 600, color: 'var(--text)', margin: '0 0 6px' }}>No patient selected</p>
            <p style={{ fontSize: 'calc(13px * var(--fs))', margin: 0 }}>
              {tab === 'queue'
                ? 'Pick a patient from the queue to view their pre-consult report.'
                : tab === 'consulting'
                ? 'Pick a patient you are consulting to continue, or open a new one from the Queue.'
                : 'Pick a consulted visit to review its report and prescription.'}
            </p>
          </div>
        )}

        {selected && (
          <>
            <div style={{ marginBottom: 16 }}>
              {/* Top row: triage badge on the left, actions on the right. The
                  patient name always sits on its OWN line below the triage (kept
                  consistent for every entry), prefixed with a small "PATIENT"
                  label so it can't be mistaken for the triage or the meta line. */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                <TriageBadge level={selected.triage_level} />
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center', position: 'relative' }}>
                {/* Queue / Consulting: reassign — to another department's general
                    queue, or to a specific doctor (searchable). Release (open by
                    mistake) lives on the Consulting side. */}
                {tab !== 'consulted' && selected.assigned_doctor_id && (
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setReassignOpen(o => !o)} title="Reassign this patient"
                      style={{ background: 'none', border: '1px solid #ccc', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
                      ⇄ Reassign ▾
                    </button>
                    {reassignOpen && (
                      <>
                        <div onClick={() => setReassignOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: '#fff', border: '1px solid #E0E0E0', borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', zIndex: 20, width: 280, padding: 12 }}>
                          {/* 1) To a different department → general queue */}
                          <label style={{ fontSize: 'calc(11px * var(--fs))', fontWeight: 600, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>To a department (general queue)</label>
                          <select defaultValue="" onChange={e => { const d = departments.find(x => x.code === e.target.value); e.target.value = ''; if (d) handleReassignDept(d); }}
                            style={{ width: '100%', border: '1px solid #ccc', borderRadius: 8, padding: '6px 8px', fontSize: 'calc(13px * var(--fs))', cursor: 'pointer', marginBottom: 12 }}>
                            <option value="">Choose department…</option>
                            {departments.filter(d => d.code !== selected.department).map(d => (
                              <option key={d.code} value={d.code}>{d.name}</option>
                            ))}
                          </select>

                          {/* 2) To a specific doctor → searchable, scrollable */}
                          <label style={{ fontSize: 'calc(11px * var(--fs))', fontWeight: 600, color: 'var(--text-light)', display: 'block', marginBottom: 4 }}>To a specific doctor</label>
                          <DoctorPicker doctors={doctors.filter(d => d.id !== doctor.id && d.is_active !== false)}
                            onPick={handleReassignDoctor} />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Consulting: opened a patient by mistake? Release them back to the
                    active queue (clears your lock so you can open the right one). */}
                {tab === 'consulting' && (
                  <button onClick={handleRelease}
                    title="Send this patient back to the active queue"
                    style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
                    ↩ Release to queue
                  </button>
                )}

                {/* Discrete kebab (⋯) menu — holds the destructive Delete action.
                    Only on the Queue tab: consulted visits are a permanent record
                    and can't be deleted, so the menu would be empty there. */}
                {tab === 'queue' && (
                  <>
                    <button onClick={() => setMenuOpen(o => !o)} title="More options"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(22px * var(--fs))', lineHeight: 1, padding: '2px 8px', color: 'var(--text-light)', borderRadius: 6 }}>
                      ⋯
                    </button>
                    {menuOpen && (
                      <>
                        {/* click-away overlay */}
                        <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#fff', border: '1px solid #E0E0E0', borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.14)', zIndex: 10, minWidth: 190, overflow: 'hidden' }}>
                          <button onClick={() => { setMenuOpen(false); handleDelete(); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '11px 14px', cursor: 'pointer', fontSize: 'calc(13px * var(--fs))', color: 'var(--red)' }}>
                            🗑 Delete patient entry
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
                </div>
              </div>

              {/* Patient name on its own line, clearly labelled, with the
                  age / gender / department as a lighter meta line beneath it. */}
              <div style={{ fontSize: 'calc(10.5px * var(--fs))', fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 1 }}>Patient</div>
              <h2 style={{ fontSize: 'calc(22px * var(--fs))', margin: 0, lineHeight: 1.2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{selected.patient_name}</h2>
              <p style={{ margin: '3px 0 0', color: 'var(--text-light)', fontSize: 'calc(13px * var(--fs))' }}>
                {selected.patient_age ? `${selected.patient_age}y` : ''} {selected.patient_gender || ''} · {selected.department}
              </p>

              {/* Patient-captured voice answers — reference material, NOT a doctor
                  workflow step, so it lives here under the patient identity with a
                  distinct teal accent (not the workflow-blue of Report/Prescribe/
                  Scribe). Collapsed by default; expands inline on click. */}
              {/* Always shown for a selected patient — count 0 when none recorded
                  (muted, non-expandable), expandable when clips exist. */}
              <div style={{ marginTop: 12 }}>
                  <button onClick={() => voiceClips.length && setAudioOpen(o => !o)} disabled={voiceClips.length === 0}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: (audioOpen && voiceClips.length) ? '#E8F8F5' : '#fff', border: '1px solid var(--accent)', color: '#117D68', borderRadius: 20, padding: '5px 13px', cursor: voiceClips.length ? 'pointer' : 'default', fontSize: 'calc(12.5px * var(--fs))', fontWeight: 600, opacity: voiceClips.length ? 1 : 0.6 }}>
                    🔊 Patient audio ({voiceClips.length})
                    {voiceClips.length > 0 && <span style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>{audioOpen ? '▲' : '▼'}</span>}
                  </button>
                  {audioOpen && voiceClips.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10, borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>
                      {voiceClips.map(clip => {
                        // Label each clip by the question it answers (the transcript
                        // is already in the report).
                        const label = clip.question_id
                          ? clip.question_id.replace(/^q_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
                          : 'Voice answer';
                        return (
                          <div key={clip.id} style={{ background: '#F7F9FB', border: '1px solid #E6EBF1', borderRadius: 10, padding: '10px 12px' }}>
                            <p style={{ margin: '0 0 8px', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, color: 'var(--text)' }}>
                              {label}
                              {clip.duration_ms ? <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> · {(clip.duration_ms / 1000).toFixed(1)}s</span> : null}
                            </p>
                            <audio controls preload="metadata" src={clip.url} style={{ width: '100%', height: 36 }} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
            </div>

            {/* Delete confirmation lives in handleDelete() via useConfirm — it was
                the only hand-rolled overlay that was genuinely a confirmation, and
                it had no dialog semantics, focus trap, or Escape handling. */}

            {/* Report / Prescribe tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              <button className={`btn ${rightTab === 'report' ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 32, width: 'auto', padding: '0 16px' }}
                onClick={() => setRightTab('report')}>Report</button>
              <button className={`btn ${rightTab === 'prescribe' ? 'btn-primary' : 'btn-outline'}`}
                title={visitDone ? 'Prescription already issued' : (prescribeLocked ? 'Mark the report Accurate or Inaccurate first' : 'Prescribe')}
                style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 32, width: 'auto', padding: '0 16px', opacity: (prescribeLocked && !visitDone) ? 0.5 : 1, cursor: (prescribeLocked && !visitDone) ? 'not-allowed' : 'pointer' }}
                onClick={() => {
                  // A finished visit just shows its issued prescription — never locked.
                  if (prescribeLocked && !visitDone) { toast('Review the report first — mark it Accurate or Inaccurate.', 'error'); return; }
                  setRightTab('prescribe'); setPrescribeMounted(true);
                }}>{visitDone ? 'Prescribed' : (prescribeLocked ? '🔒 ' : '') + 'Prescribe'}</button>
              {/* Patient-uploaded documents (prescriptions, lab reports…). Only shown
                  when the patient actually uploaded something — no empty tab clutter. */}
              {docs.length > 0 && (
                <button className={`btn ${rightTab === 'uploaded' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 32, width: 'auto', padding: '0 16px' }}
                  onClick={() => setRightTab('uploaded')}>📎 Uploaded ({docs.length})</button>
              )}
            </div>

            {rightTab === 'report' && (
              <>
                {loading && (
                  <div style={{ padding: 40, textAlign: 'center' }}>
                    <div style={{ width: '100%', height: 20, background: '#F0F0F0', borderRadius: 4, marginBottom: 8 }} />
                    <div style={{ width: '70%', height: 16, background: '#F0F0F0', borderRadius: 4, marginBottom: 8 }} />
                    <p style={{ color: 'var(--text-light)', marginTop: 12 }}>Loading report...</p>
                  </div>
                )}

                {report ? (
                  <>
                    {/* If the doctor edited the report, that becomes the report shown
                        (the AI original is preserved and viewable via the toggle). */}
                    {report.doctor_correction && !showOriginal && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'calc(12px * var(--fs))', fontWeight: 600, color: 'var(--amber-on-tint)', background: '#FEF9E7', border: '1px solid #F7DC6F', borderRadius: 6, padding: '3px 9px' }}>✎ Edited by doctor</span>
                        <button onClick={() => setShowOriginal(true)} style={{ background: 'none', border: 'none', color: 'var(--secondary)', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer', textDecoration: 'underline' }}>View original (AI)</button>
                      </div>
                    )}
                    {report.doctor_correction && showOriginal && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 'calc(12px * var(--fs))', fontWeight: 600, color: 'var(--text-light)' }}>Original AI report</span>
                        <button onClick={() => setShowOriginal(false)} style={{ background: 'none', border: 'none', color: 'var(--secondary)', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer', textDecoration: 'underline' }}>Back to edited</button>
                      </div>
                    )}
                    <div style={{ lineHeight: 1.8, fontSize: 'calc(15px * var(--fs))' }}>
                      <ReactMarkdown>{(report.doctor_correction && !showOriginal) ? report.doctor_correction : report.report_md}</ReactMarkdown>
                    </div>

                    {/* Vitals not recorded → let the doctor/nurse add them (re-triages + regenerates). */}
                    {!hasVitals(vitals) && (
                      <div style={{ marginTop: 16, background: 'var(--bg)', borderRadius: 12, overflow: 'hidden' }}>
                        <button type="button" onClick={() => { setVitalsErr(''); setVitalsOpen(o => !o); }} aria-expanded={vitalsOpen}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', padding: 14, cursor: 'pointer' }}>
                          <span style={{ fontSize: 'calc(20px * var(--fs))', lineHeight: 1 }}>🩺</span>
                          <span style={{ flex: 1, textAlign: 'left' }}>
                            <span style={{ display: 'block', fontSize: 'calc(14px * var(--fs))', fontWeight: 600, color: 'var(--primary)' }}>Vitals not recorded — add them</span>
                            <span style={{ display: 'block', fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginTop: 2 }}>Patient skipped vitals · entering them updates triage &amp; the report</span>
                          </span>
                          <span style={{ color: 'var(--text-light)', fontSize: 'calc(12px * var(--fs))', transition: 'transform .15s', transform: vitalsOpen ? 'rotate(180deg)' : 'none' }}>▼</span>
                        </button>
                        {vitalsOpen && (
                          <div style={{ padding: '12px 14px 14px', borderTop: '1px solid #E0E0E0' }}>
                            <VitalsForm lang="en" loading={vitalsSaving} error={vitalsErr}
                              submitLabel="Save vitals" loadingLabel="Saving…" onSubmit={saveVitals} />
                          </div>
                        )}
                      </div>
                    )}

                    {tab !== 'consulted' && (
                      <div style={{ marginTop: 24, borderTop: '1px solid #E0E0E0', paddingTop: 16 }}>
                        {editing ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <label style={{ fontSize: 'calc(12px * var(--fs))', fontWeight: 600, color: 'var(--primary)' }}>Edit the report — your changes replace what's shown; the original AI version is kept for the record.</label>
                            <textarea className="input" value={editText}
                              onChange={e => setEditText(e.target.value)}
                              placeholder="Edit the report text…"
                              style={{ minHeight: 280, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button className="btn btn-outline" style={{ width: 'auto', minHeight: 'auto', padding: '8px 16px', fontSize: 'calc(13px * var(--fs))' }}
                                onClick={() => setEditing(false)} disabled={savingEdit}>Cancel</button>
                              <button className="btn btn-primary" style={{ width: 'auto', minHeight: 'auto', padding: '8px 16px', fontSize: 'calc(13px * var(--fs))' }}
                                onClick={saveReportEdit} disabled={savingEdit || !editText.trim()}>
                                {savingEdit ? 'Saving…' : 'Save report'}
                              </button>
                            </div>
                          </div>
                        ) : feedbackGiven?.id === selected?.id ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, fontSize: 'calc(13px * var(--fs))', fontWeight: 600,
                              background: feedbackGiven.val === 'accurate' ? '#D5F5E3' : feedbackGiven.val === 'error' ? '#FADBD8' : '#FCF3CF',
                              color: feedbackGiven.val === 'accurate' ? '#1E8449' : feedbackGiven.val === 'error' ? '#C0392B' : '#B9770E',
                            }}>
                              {feedbackGiven.val === 'accurate' ? '✓ Marked as accurate — thank you'
                                : feedbackGiven.val === 'error' ? '⚠ Couldn’t save — please try again'
                                : '✓ Flagged as incorrect history — thank you'}
                            </span>
                            <button onClick={() => setFeedbackGiven(null)}
                              style={{ background: 'none', border: 'none', color: 'var(--text-light)', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer', textDecoration: 'underline' }}>
                              {feedbackGiven.val === 'error' ? 'Retry' : 'Change'}
                            </button>
                          </div>
                        ) : (
                          <>
                            {prescribeLocked && (
                              <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--amber-on-tint)', fontWeight: 600, marginBottom: 8 }}>
                                ⚠ Review this report before prescribing — mark it Accurate, or Inaccurate (then save your edit).
                              </p>
                            )}
                            <div style={{ display: 'flex', gap: 12 }}>
                              <button className="btn btn-accent" style={{ flex: 1 }} onClick={() => handleFeedback('accurate')}>Report Accurate</button>
                              <button className="btn btn-outline" style={{ flex: 1, borderColor: 'var(--red)', color: 'var(--red)' }}
                                onClick={() => { setEditText(report?.doctor_correction || report?.report_md || ''); setShowOriginal(false); setEditing(true); }}>Incorrect History — Edit</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  !loading && <p style={{ color: 'var(--text-light)' }}>No report generated yet for this patient.</p>
                )}
              </>
            )}

            {/* Patient-uploaded documents (prescriptions, lab reports, etc.) —
                the ORIGINAL images from MinIO, every one the patient uploaded. */}
            {rightTab === 'uploaded' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {docs.map(d => (
                  <div key={d.id} style={{ border: '1px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                      <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, textTransform: 'capitalize' }}>{String(d.doc_type || 'document').replace(/_/g, ' ')}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{d.created_at ? fmtVisitDate(d.created_at) : ''}</span>
                    </div>
                    <div style={{ padding: 12 }}>
                      {d.image_url ? (
                        <a href={d.image_url} target="_blank" rel="noreferrer">
                          <img src={d.image_url} alt="uploaded document"
                            style={{ width: '100%', objectFit: 'contain', borderRadius: 6, border: '1px solid #EEF2F6', background: '#fff', cursor: 'zoom-in' }} />
                        </a>
                      ) : (
                        <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>
                          Original file not available — this was uploaded before document storage was enabled.
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Kept mounted (just hidden) once opened so the saved prescription +
                QR persist when the doctor flips to Report and back. The Scribe now
                lives inside this panel (collapsible), not as its own tab. */}
            {prescribeMounted && (
              <div style={{ display: rightTab === 'prescribe' ? 'block' : 'none' }}>
                <PrescriptionPanel session={selected} doctor={doctor} onDispatched={handleDispatched} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Common-OPD formulary (generic names), alphabetical. Kept in sync with the
// backend's drug_data.GENERIC_DRUGS (the source of truth for interactions and
// brand→generic OCR normalization).
const DRUG_LIST = [
  "acarbose","aceclofenac","acenocoumarol","alprazolam","ambroxol","amiodarone","amitriptyline",
  "amlodipine","amoxicillin","ampicillin","apixaban","aspirin","atenolol","atorvastatin",
  "azithromycin","bisoprolol","budesonide","calcium","canagliflozin","carbimazole","carvedilol",
  "cefixime","ceftriaxone","cefuroxime","cephalexin","cetirizine","chlorpheniramine",
  "chlorthalidone","cholecalciferol","cilnidipine","ciprofloxacin","clarithromycin","clindamycin",
  "clonazepam","clopidogrel","cloxacillin","cotrimoxazole","dabigatran","dapagliflozin",
  "deflazacort","dexamethasone","diclofenac","dicyclomine","digoxin","diltiazem","domperidone",
  "doxycycline","empagliflozin","enalapril","enoxaparin","erythromycin","escitalopram",
  "esomeprazole","etoricoxib","ezetimibe","famotidine","fenofibrate","ferrous sulfate",
  "fexofenadine","folic acid","formoterol","furosemide","gabapentin","gliclazide","glimepiride",
  "glipizide","guaifenesin","heparin","hydrochlorothiazide","hydrocortisone","hydroxyzine",
  "ibuprofen","indapamide","insulin","isosorbide","ivabradine","ketorolac","levocetirizine",
  "levofloxacin","levosalbutamol","levothyroxine","linagliptin","lisinopril","loratadine",
  "losartan","mefenamic","metformin","methylcobalamin","methylprednisolone","metoclopramide",
  "metoprolol","metronidazole","montelukast","naproxen","nebivolol","nifedipine","nimesulide",
  "nitrofurantoin","nitroglycerin","norfloxacin","ofloxacin","olmesartan","omeprazole",
  "ondansetron","ornidazole","ors","pantoprazole","paracetamol","perindopril","pioglitazone",
  "prasugrel","prednisolone","pregabalin","propranolol","rabeprazole","ramipril","ranitidine",
  "rivaroxaban","rosuvastatin","salbutamol","serratiopeptidase","sertraline","simvastatin",
  "sitagliptin","spironolactone","sucralfate","telmisartan","teneligliptin","theophylline",
  "ticagrelor","torsemide","tramadol","valsartan","verapamil","vildagliptin","vitamin b12",
  "vitamin d3","warfarin","zinc",
];

const FREQ_OPTIONS = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'Weekly'];

const titleCase = (s) => (s || '').replace(/\b\w/g, c => c.toUpperCase());

// Stable per-row IDs so React keys prescription/med rows by identity, not index
// (keying by index misaligns input state when a middle row is deleted/reordered).
let _rxSeq = 0;
const rxUid = () => `rx${Date.now().toString(36)}${(_rxSeq++).toString(36)}`;
const makeItem = (extra = {}) => ({ id: rxUid(), drug_name: '', dose: '', frequency: 'OD', duration: '', instructions: '', ...extra });

// Parse the patient's free-text intake allergy answer (e.g. "Penicillin allergy,
// insulin allergy", "Sulfa & aspirin") into clean allergen tokens. Drops "no"
// answers ("None", "Nil", "NKDA", "no known drug allergies") so they don't show
// as a false allergy. Strips filler words like "allergy"/"allergic to".
const _ALLERGY_NEGATIVES = new Set([
  'none', 'nil', 'no', 'na', 'n/a', 'nka', 'nkda', 'nkma', 'nope', '-', '--',
  'no known', 'not known', 'no allergies', 'no known allergies',
  'no known drug allergies', 'no drug allergies', 'denies', 'unknown',
]);
function parseAllergyText(txt) {
  const raw = (txt || '').trim();
  if (!raw || _ALLERGY_NEGATIVES.has(raw.toLowerCase())) return [];
  return raw
    .split(/[,;/&\n]|\band\b/i)
    .map(s => s.replace(/\b(allerg(y|ic)|to|reaction|sensitivity)\b/gi, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(s => !_ALLERGY_NEGATIVES.has(s.toLowerCase()) && !/^no\b/i.test(s));
}

// Keep only the leading dose token, dropping composition/ingredient text the OCR
// sometimes captures: "625mg (500mg Amoxycillin + 125mg Clavulanate)" -> "625mg",
// "400mg Vitamin C + 7.5mg Zinc" -> "400mg". Falls back to the trimmed original
// when there's no recognizable dose token (e.g. a "1-0-1" schedule).
const DOSE_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?|tablets?|tabs?|capsules?|caps?|drops?|puffs?|%)/i;
function primaryDose(s) {
  if (!s) return '';
  const m = String(s).match(DOSE_TOKEN_RE);
  return m ? m[0].replace(/\s+/g, '') : String(s).trim();
}

// Split a free-text medicine entry into { name, dose } so a patient-typed string
// like "Dolo 650" or "Acutret 10mg" pre-fills the dose column instead of dumping
// the whole thing into the drug-name field. Handles an explicit strength token
// ("10mg", "500 mcg") and the Indian bare-number shorthand ("Dolo 650" = 650).
// Doctor still verifies/edits before prescribing.
function splitNameDose(s) {
  const str = String(s || '').trim();
  if (!str) return { name: '', dose: '' };
  const unit = str.match(DOSE_TOKEN_RE);
  if (unit) {
    const name = str.replace(unit[0], '').replace(/[\s,–-]+$/, '').replace(/^[\s,–-]+/, '').trim();
    return { name: name || str, dose: unit[0].replace(/\s+/g, '') };
  }
  const bare = str.match(/^(.*\S)[\s-]+(\d+(?:\.\d+)?)$/);   // trailing bare number = strength
  if (bare) return { name: bare[1].trim(), dose: bare[2] };
  return { name: str, dose: '' };
}

// Searchable drug dropdown: filters DRUG_LIST as you type, supports keyboard
// (↑/↓/Enter/Esc) and click selection, closes on click-away. Free text is still
// allowed (whatever is typed is the value) so doctors aren't limited to the list.
// Searchable, scrollable doctor picker (shows a few rows, type to filter by name
// or department). Used in the reassign popover. Picking calls onPick(doctor).
function DoctorPicker({ doctors, onPick }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = query
    ? doctors.filter(d => (d.name || '').toLowerCase().includes(query) || (d.department || '').toLowerCase().includes(query))
    : doctors;
  return (
    <div>
      <input className="input" value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search doctor or department…" autoComplete="off"
        style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 32 }} />
      <div style={{ border: '1px solid #D5D8DC', borderRadius: 6, marginTop: 4, maxHeight: 200, overflowY: 'auto' }}>
        {matches.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>No doctors match.</div>
        )}
        {matches.map(d => (
          <div key={d.id}
            onMouseDown={(e) => { e.preventDefault(); onPick(d); }}
            onMouseEnter={e => { e.currentTarget.style.background = '#EBF5FB'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            style={{ padding: '7px 10px', fontSize: 'calc(13px * var(--fs))', cursor: 'pointer', borderBottom: '1px solid #F0F0F0' }}>
            {d.name} <span style={{ color: 'var(--text-light)', fontSize: 'calc(11px * var(--fs))' }}>· {d.department}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DrugCombobox({ value, onChange, placeholder, style, options = DRUG_LIST }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef(null);

  const q = (value || '').trim().toLowerCase();
  // Show the WHOLE formulary (the panel is scrollable). No slice cap, so the list
  // isn't truncated alphabetically and reflects every drug the API returns —
  // including ones added via the HIS admin dashboard.
  const matches = q
    ? options.filter(d => d.includes(q))
    : options;

  // Close when clicking outside the widget.
  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function choose(name) {
    onChange(titleCase(name));
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      if (open && matches[hi]) { e.preventDefault(); choose(matches[hi]); }
    } else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input className="input" value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder} style={style} autoComplete="off" />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
          background: '#fff', border: '1px solid #D5D8DC', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto', marginTop: 2,
        }}>
          {matches.map((d, i) => (
            <div key={d}
              onMouseDown={(e) => { e.preventDefault(); choose(d); }}
              onMouseEnter={() => setHi(i)}
              style={{
                padding: '7px 10px', fontSize: 'calc(13px * var(--fs))', cursor: 'pointer',
                background: i === hi ? '#EBF5FB' : '#fff',
              }}>
              {titleCase(d)}
            </div>
          ))}
        </div>
      )}
      {open && q && matches.length === 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
          background: '#fff', border: '1px solid #D5D8DC', borderRadius: 6,
          padding: '7px 10px', fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginTop: 2,
        }}>
          No match — "{value}" will be used as typed.
        </div>
      )}
    </div>
  );
}

// One interaction/allergy/AI warning row, shown in full. Visibility of the whole
// list is controlled by the single dropdown in the Warnings block.
function WarningRow({ w }) {
  const ai = w.source === 'ai';
  const bg = ai ? '#EAF3FB' : (w.severity === 'block' ? '#FADBD8' : '#FFF3CD');
  const fg = ai ? '#1B4F72' : (w.severity === 'block' ? '#C0392B' : '#856404');
  const label = ai ? 'AI-ASSESSED · UNVERIFIED' : (w.severity === 'block' ? 'BLOCKED' : 'WARNING');
  return (
    <div style={{ background: bg, padding: 10, fontSize: 'calc(13px * var(--fs))', borderBottom: '1px solid rgba(0,0,0,0.1)', borderLeft: ai ? '3px solid #2E86AB' : 'none' }}>
      <strong style={{ color: fg }}>{label}{ai && w.severity === 'block' ? ' (severe)' : ''}:</strong>{' '}
      {w.description}
      {w.drug_a && w.drug_b && <span style={{ color: 'var(--text-light)' }}> ({w.drug_a} + {w.drug_b})</span>}
      {w.drug && w.allergy && <span style={{ color: 'var(--text-light)' }}> ({w.drug} / allergy: {w.allergy})</span>}
      {ai && typeof w.confidence === 'number' && (
        <span style={{ color: 'var(--text-light)' }}> · confidence {Math.round(w.confidence * 100)}%</span>
      )}
    </div>
  );
}

function PrescriptionPanel({ session, doctor, onDispatched }) {
  const [items, setItems] = useState(() => [makeItem()]);
  const [allergies, setAllergies] = useState([]);          // doctor-added (patient_allergies table)
  const [intakeAllergens, setIntakeAllergens] = useState([]); // parsed from the patient's intake answer
  const [warnings, setWarnings] = useState([]);
  const [warnOpen, setWarnOpen] = useState(false);   // the single Warnings dropdown open?
  const [interactionChecked, setInteractionChecked] = useState(false);
  const [unknownDrugs, setUnknownDrugs] = useState([]);   // prescribed drugs not in the formulary
  const [aiChecked, setAiChecked] = useState(false);      // has the AI advisory run for the current drugs?
  const [aiNote, setAiNote] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const [drugList, setDrugList] = useState(DRUG_LIST); // hardcoded fallback; replaced by /api/drugs
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  // The allergies the checker + banner use: the patient's intake answer MERGED
  // with anything the doctor added manually (case-insensitive de-dupe). This is
  // why a penicillin-allergic patient is flagged even if the doctor never adds it.
  const allergyList = useMemo(() => {
    const byKey = new Map();
    const add = v => { const k = (v || '').trim(); if (k) byKey.set(k.toLowerCase(), k); };
    intakeAllergens.forEach(add);
    allergies.forEach(a => add(a.allergen));
    return [...byKey.values()];
  }, [allergies, intakeAllergens]);

  // The Warnings dropdown auto-opens when there's a block/allergy (so critical
  // alerts are never hidden) and collapses when there are only warnings/AI
  // advisories. The doctor can still toggle it either way.
  useEffect(() => {
    setWarnOpen(warnings.some(w => w.severity === 'block'));
  }, [warnings]);

  // Fetch the formulary once (single source of truth in the backend). On any
  // failure we silently keep the bundled DRUG_LIST fallback, so the dropdown
  // always works even offline.
  useEffect(() => {
    let alive = true;
    api.getDrugs()
      .then(res => { if (alive && Array.isArray(res?.drugs) && res.drugs.length) setDrugList(res.drugs); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const draftKey = session?.id ? `rx_draft_${session.id}` : null;

  // Persist the in-progress prescription for this patient so it survives tab
  // switches / navigation. Cleared automatically once the Rx is saved.
  function persistDraft(nextItems, nextNotes) {
    if (!draftKey) return;
    const hasContent = nextItems.some(i => i.drug_name?.trim()) || (nextNotes || '').trim();
    try {
      if (hasContent) localStorage.setItem(draftKey, JSON.stringify({ items: nextItems, notes: nextNotes }));
      else localStorage.removeItem(draftKey);
    } catch {}
  }

  function clearDraft() {
    if (draftKey) { try { localStorage.removeItem(draftKey); } catch {} }
    setItems([makeItem()]);
    setNotes('');
    setWarnings([]);
    setInteractionChecked(false);
    setDraftRestored(false);
    setSaveError('');
    setShowItemErrors(false);
  }
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [notes, setNotes] = useState('');
  const [drugFilter, setDrugFilter] = useState('');
  const [existingRx, setExistingRx] = useState([]);
  const [currentMeds, setCurrentMeds] = useState([]);
  const [qrUrl, setQrUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showItemErrors, setShowItemErrors] = useState(false);
  // Hospital prescription template — drives the printed slip's branding/theme/
  // toggles, the same template the patient's digital prescription uses, so the
  // printed and digital versions always match.
  const [rxTemplate, setRxTemplate] = useState(null);
  useEffect(() => { api.getRxTemplate().then(setRxTemplate).catch(() => setRxTemplate({})); }, []);

  // Build the QR as a link to the digital prescription page (so scanning opens a
  // verified, human-readable prescription). We use the SAME origin the doctor is
  // browsing from, so opening the dashboard via a LAN IP makes the QR point at
  // that IP automatically — letting a phone on the same network open it.
  useEffect(() => {
    const payload = saved?.prescription?.qr_payload;
    if (!payload) { setQrUrl(''); setQrError(''); return; }
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const link = `${origin}/rx/verify?d=${encodeURIComponent(payload)}`;
    QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 240 })
      .then(url => { setQrUrl(url); setQrError(''); })
      .catch(() => {
        QRCode.toDataURL(link, { errorCorrectionLevel: 'L', margin: 2, width: 280 })
          .then(url => { setQrUrl(url); setQrError(''); })
          .catch(() => { setQrUrl(''); setQrError('Prescription too large to fit in one QR code.'); });
      });
  }, [saved]);

  // Open a clean, letterhead-style prescription in a new window and print it
  // (browser print → paper or Save as PDF). Branding/theme/toggles come from the
  // hospital template, so the printed slip matches the patient's digital Rx.
  function printPrescription() {
    if (!saved) return;
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const t = rxTemplate || {};
    const show = t.show || {};
    const accent = esc(t.accent || '#1c5d8c');
    const modern = t.theme === 'modern';

    const items = saved.items || [];
    const pname = esc(session?.patient_name || saved.prescription?.patient_name || 'Patient');
    // Optional patient details (per template toggles).
    const ptBits = [];
    if (show.patient_age && session?.patient_age) ptBits.push(`${esc(session.patient_age)}y`);
    if (show.patient_gender && session?.patient_gender) ptBits.push(esc({ M: 'Male', F: 'Female', O: 'Other' }[session.patient_gender] || session.patient_gender));
    if (show.patient_phone && session?.patient_phone) ptBits.push('Ph: ' + esc(formatPhoneDisplay(session.patient_phone)));

    const issued = saved.issued_at ? new Date(saved.issued_at) : new Date();
    const date = issued.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = issued.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const rxId = esc(saved.prescription?.id || '');
    const docName = esc(doctor?.name || 'Doctor');
    const docBits = [];
    if (show.department && doctor?.department) docBits.push(esc(doctor.department) + ' Dept.');
    if (show.doctor_registration && doctor?.registration_no) docBits.push('Reg. ' + esc(doctor.registration_no));
    const notes = saved.prescription?.notes ? esc(saved.prescription.notes) : '';
    const rows = items.map(it =>
      `<tr><td>${esc(it.drug_name)}</td><td>${esc(it.dose)}</td><td>${esc(it.frequency)}</td><td>${esc(it.duration)}</td><td>${esc(it.instructions)}</td></tr>`
    ).join('');

    // Hospital header lines.
    const hospName = esc(t.hospital_name || 'Hospital');
    const hospMeta = [t.tagline, t.address, [t.phone, t.email].filter(Boolean).join('  ·  '), t.registration_line]
      .filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('');
    const logo = (show.logo && t.logo_url) ? `<img class="logo" src="${esc(t.logo_url)}" alt="" />` : '';

    // Optional notices.
    const validUntil = show.valid_until
      ? (() => { const d = new Date(issued); d.setDate(d.getDate() + (Number(t.valid_days) || 0));
          if (isNaN(d.getTime())) return '';   // huge day count overflowed the date range
          return `<p class="meta">Valid until: <strong>${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</strong></p>`; })()
      : '';
    const genericNote = (show.generic_note && t.generic_note_text) ? `<p class="meta gen">${esc(t.generic_note_text)}</p>` : '';
    const footer = t.footer ? esc(t.footer) : '';

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Prescription ${rxId}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: ${modern ? 'Arial, Helvetica, sans-serif' : 'Georgia, "Times New Roman", serif'}; color: #1a1a1a; margin: 0; }
  .hdr { border-bottom: 2px solid ${accent}; padding-bottom: 10px; margin-bottom: 14px;
         display: flex; align-items: center; gap: 14px; text-align: ${modern ? 'left' : 'center'};
         justify-content: ${modern ? 'flex-start' : 'center'}; ${modern ? `border-left: 4px solid ${accent}; padding-left: 12px;` : ''} }
  .hdr .logo { height: 52px; width: 52px; object-fit: contain; }
  .hosp h1 { margin: 0; font-size: 22px; color: ${accent}; }
  .hosp p { margin: 1px 0; font-size: 11px; color: #555; }
  .topline { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; font-family: Arial, sans-serif; }
  .pt strong { font-size: 16px; } .pt .sub { color: #555; font-size: 12px; margin-left: 6px; }
  .when { text-align: right; font-size: 12px; color: #555; }
  .presc { font-size: 12px; color: #555; margin: 4px 0 12px; font-family: Arial, sans-serif; }
  .rx { font-size: 30px; color: ${accent}; font-weight: bold; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-family: Arial, sans-serif; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { color: ${accent}; }
  .notes { margin-top: 18px; font-size: 13px; border-top: 1px solid #e5e5e5; padding-top: 12px; font-family: Arial, sans-serif; }
  .notes .lbl { font-weight: bold; color: ${accent}; display: block; margin-bottom: 4px; }
  .meta { font-size: 11px; color: #555; margin: 8px 0 0; font-family: Arial, sans-serif; }
  .meta.gen { font-style: italic; }
  .foot { margin-top: 44px; display: flex; justify-content: space-between; align-items: flex-end; }
  .qr { text-align: center; font-size: 10px; color: #777; font-family: Arial, sans-serif; }
  .qr img { width: 110px; height: 110px; }
  .sign { text-align: center; font-size: 12px; font-family: Arial, sans-serif; }
  .sign .line { border-top: 1px solid #333; width: 200px; margin-bottom: 4px; }
  .disc { margin-top: 26px; font-size: 10px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 8px; font-family: Arial, sans-serif; }
</style></head>
<body onload="window.print()">
  <div class="hdr">${logo}<div class="hosp"><h1>${hospName}</h1>${hospMeta}</div></div>
  <div class="topline">
    <div class="pt"><strong>${pname}</strong>${ptBits.length ? `<span class="sub">${ptBits.join(' · ')}</span>` : ''}</div>
    <div class="when">Date: ${date}<br>Time: ${time}<br>Rx ID: ${rxId}</div>
  </div>
  <p class="presc">Prescribed by <strong>${docName}</strong>${docBits.length ? ' · ' + docBits.join(' · ') : ''}</p>
  <div class="rx">&#8478;</div>
  <table>
    <thead><tr><th>Medication</th><th>Dose</th><th>Frequency</th><th>Duration</th><th>Instructions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No medications</td></tr>'}</tbody>
  </table>
  ${notes ? `<div class="notes"><span class="lbl">Doctor's Advice &amp; Instructions</span>${notes}</div>` : ''}
  ${genericNote}${validUntil}
  <div class="foot">
    <div class="qr">${qrUrl ? `<img src="${qrUrl}"/><br>Scan to verify digital Rx` : ''}</div>
    <div class="sign"><div class="line"></div>${docName}<br>Signature</div>
  </div>
  ${footer ? `<div class="disc">${footer}</div>` : ''}
</body></html>`;

    const w = window.open('', '_blank', 'width=840,height=1060');
    if (!w) { toast('Please allow pop-ups to print the prescription.', 'error'); return; }
    w.document.write(html);
    w.document.close();
  }

  useEffect(() => {
    if (session?.patient_phone) {
      api.getAllergies(session.patient_phone).then(setAllergies).catch(() => {});
    }
    // Pull the patient's intake allergy answer (free text) so the Prescribe tab
    // alerts on it and feeds it to the interaction/allergy checker — even when the
    // doctor never manually added an allergy.
    setIntakeAllergens([]);
    if (session?.id) {
      api.getAnswers(session.id).then(rows => {
        const row = (Array.isArray(rows) ? rows : []).find(r => /allerg/i.test(r.question_id || ''));
        const raw = row?.answer_structured?.value || row?.answer_raw || '';
        setIntakeAllergens(parseAllergyText(raw));
      }).catch(() => {});
    }
    if (session?.id) {
      api.getPrescriptions(session.id).then(list => {
        setExistingRx(list);
        // If this visit was already prescribed (e.g. reopened from Consulted),
        // show the latest saved prescription + its QR instead of a blank form.
        // "Write another prescription" in that view clears this back to the form.
        if (Array.isArray(list) && list.length) {
          const rx = list[0]; // GET returns newest-first
          setSaved({ prescription: rx, items: rx.items || [], issued_at: rx.created_at });
        }
      }).catch(() => {});
      // Load current medications from session report (OCR-extracted + patient-reported)
      api.getReport(session.id).then(report => {
        const meds = [];
        const reportJson = report?.report_json;
        if (reportJson?.medications_from_documents) {
          reportJson.medications_from_documents.forEach(m => {
            // Prefer the formal/generic name (filled by OCR brand→generic
            // normalization); keep the original brand as a hint when it differs.
            const formal = m.generic || m.name || '';
            const brand = (m.generic && m.name && m.generic.toLowerCase() !== m.name.toLowerCase()) ? m.name : '';
            meds.push({ id: rxUid(), drug_name: formal, brand, dose: primaryDose(m.dose), frequency: m.frequency || '', source: 'document', duration: '', instructions: '' });
          });
        }
        // Patient-reported from questionnaire answer. Base questions are namespaced
        // per department (q_<dept>_base_medications), so match the id suffix rather
        // than a fixed 'q_medications' (which never matches → empty pre-fill).
        const _ans = reportJson?.answers || {};
        const _medKey = Object.keys(_ans).find(k => k.endsWith('_base_medications'));
        const patientMeds = _medKey ? _ans[_medKey] : _ans.q_medications;
        if (patientMeds && patientMeds.toLowerCase() !== 'none' && patientMeds.toLowerCase() !== 'nil') {
          // Comma-separated; split each entry into name + strength so the dose
          // column is populated (e.g. "Dolo 650" -> Dolo / 650).
          patientMeds.split(',').forEach(m => {
            const { name, dose } = splitNameDose(m);
            if (name && !meds.some(existing => existing.drug_name.toLowerCase() === name.toLowerCase())) {
              meds.push({ id: rxUid(), drug_name: name, dose, frequency: '', source: 'patient', duration: '', instructions: '' });
            }
          });
        }
        setCurrentMeds(meds);
      }).catch(() => {});
    }
    setSaved(null);
    setWarnings([]);
    setInteractionChecked(false);
    setSaveError('');
    setShowItemErrors(false);

    // Restore a saved draft for this patient (or reset to an empty form).
    let restored = false;
    try {
      const raw = session?.id ? localStorage.getItem(`rx_draft_${session.id}`) : null;
      if (raw) {
        const draft = JSON.parse(raw);
        // Ensure every restored row has a stable id (older drafts won't).
        setItems(draft.items?.length ? draft.items.map(it => ({ ...it, id: it.id || rxUid() })) : [makeItem()]);
        setNotes(draft.notes || '');
        restored = !!(draft.items?.some(i => i.drug_name?.trim()) || (draft.notes || '').trim());
      } else {
        setItems([makeItem()]);
        setNotes('');
      }
    } catch {
      setItems([makeItem()]);
      setNotes('');
    }
    setDraftRestored(restored);
  }, [session?.id]);

  // Clear a previous interaction/allergy result so a stale alert never lingers
  // after the drug set changes (the doctor must re-run "Check Interactions").
  function resetCheck() {
    setWarnings([]);
    setInteractionChecked(false);
    setUnknownDrugs([]);
    setAiChecked(false);
    setAiNote('');
  }

  function addItem() {
    const updated = [...items, makeItem()];
    setItems(updated);
    persistDraft(updated, notes);
  }

  function removeItem(idx) {
    const updated = items.filter((_, i) => i !== idx);
    setItems(updated);
    resetCheck();
    persistDraft(updated, notes);
  }

  function updateItem(idx, field, val) {
    const updated = [...items];
    updated[idx] = { ...updated[idx], [field]: val };
    setItems(updated);
    if (field === 'drug_name') resetCheck();
    persistDraft(updated, notes);
  }

  // Load a previously-saved prescription's drugs into the New Prescription form
  // (appended to whatever's already there) for quick re-prescribing. Skips any
  // drug already in the form so repeated clicks don't create duplicates.
  function reusePrescription(rx) {
    const existing = items.filter(i => i.drug_name);
    const existingNames = new Set(existing.map(i => i.drug_name.trim().toLowerCase()));
    const toAdd = (rx.items || [])
      .filter(it => it.drug_name && !existingNames.has(it.drug_name.trim().toLowerCase()))
      .map(it => makeItem({
        drug_name: it.drug_name, dose: it.dose || '', frequency: it.frequency || 'OD',
        duration: it.duration || '', instructions: it.instructions || '',
      }));
    if (!toAdd.length) return;
    const updated = [...existing, ...toAdd, makeItem()];
    setItems(updated);
    persistDraft(updated, notes);
    setInteractionChecked(false);
  }

  // Core checker. `useAi` true → also runs the LLM advisory for drugs not in the
  // formulary (the manual "Check Interactions" button). The auto-check runs it
  // false → instant curated drug-drug + allergy checks only (no LLM per keystroke).
  // Either way the merged allergyList is sent, so allergy contraindications fire.
  async function runCheck(useAi) {
    const drugs = items.map(i => i.drug_name).filter(Boolean);
    if (drugs.length === 0) {
      setWarnings([]); setInteractionChecked(false); setAiNote(''); setUnknownDrugs([]); setAiChecked(false);
      return null;
    }
    try {
      const result = await api.checkBulkInteractions({
        drugs, patient_allergies: allergyList, session_id: session?.id, ai: useAi,
      });
      setWarnings(result.warnings || []);
      setUnknownDrugs(result.unknown_drugs || []);
      setAiChecked(!!result.ai_checked);
      setAiNote(useAi
        ? (result.ai_error ? result.ai_error
          : (result.unknown_drugs?.length && !result.ai_checked) ? 'AI check for unrecognised drugs was unavailable.'
          : '')
        : '');
      setInteractionChecked(true);
      return result;
    } catch {
      setWarnings([]);
      setAiNote('');
      setInteractionChecked(false);
      return null;
    }
  }

  // Manual full check (includes the AI advisory). The check runs ONLY when the
  // doctor clicks "Check Interactions" (and again automatically at save time, so
  // an allergy/interaction still blocks even if they forget to click).
  const checkInteractions = () => runCheck(true);

  // Called by the embedded Consultation Scribe when SOAP is extracted: drop the
  // patient-facing advice into "Doctor's Advice & Instructions". Never clobbers
  // what the doctor already typed (append below, de-duped); stays editable.
  function applyAdvice(text) {
    const advice = (text || '').trim();
    if (!advice) return;
    const cur = (notes || '').trim();
    if (cur.includes(advice)) return;               // already added — don't duplicate
    const next = cur ? cur + '\n\n' + advice : advice;
    setNotes(next);
    persistDraft(items, next);
  }

  async function handleSave() {
    const validItems = items.filter(i => i.drug_name);
    // Advice-only consultations are legitimate (reassurance, lifestyle advice,
    // referral, "review if worse"). If no medicine was added, confirm before
    // saving an advice-only prescription rather than silently doing nothing.
    if (!validItems.length) {
      if (!(await confirm({
        title: 'No medicine added',
        message: 'You have not added any medication. Save this as an advice-only prescription (guidance only, no drugs)?',
        confirmLabel: 'Save advice-only',
      }))) return;
    }

    // Require dose AND duration for every prescribed drug before saving.
    const incomplete = validItems.filter(i => !String(i.dose || '').trim() || !String(i.duration || '').trim());
    if (incomplete.length > 0) {
      const names = incomplete.map(i => i.drug_name).join(', ');
      setSaveError(`Enter both dose and duration before prescribing: ${names}`);
      setShowItemErrors(true);
      return;
    }
    setSaveError('');
    setShowItemErrors(false);

    // Re-run a fresh curated check at save time so a drug-drug interaction OR an
    // allergy contraindication blocks the save even if the doctor never clicked
    // "Check Interactions". (AI advisories are never blocking, so curated is enough.)
    const fresh = await runCheck(false);
    const liveWarnings = fresh ? (fresh.warnings || []) : warnings;
    const blocks = liveWarnings.filter(w => w.severity === 'block');
    if (blocks.length > 0) {
      const allergyBlocks = blocks.filter(b => b.allergy);
      const summary = allergyBlocks.length
        ? `${allergyBlocks.length} allergy contraindication${allergyBlocks.length > 1 ? 's' : ''}`
        : `${blocks.length} blocked interaction${blocks.length > 1 ? 's' : ''}`;
      if (!(await confirm({
        title: summary,
        message: 'This prescription is flagged as BLOCKED above (see the red alerts). Prescribe anyway only if you have reviewed it and judged it clinically appropriate.',
        confirmLabel: 'Prescribe anyway',
        danger: true,
      }))) return;
    }

    setSaving(true);
    try {
      const result = await api.createPrescription({
        session_id: session.id,
        items: validItems.map(i => ({ ...i, warnings: warnings.filter(w => w.drug_a?.toLowerCase() === i.drug_name.toLowerCase() || w.drug_b?.toLowerCase() === i.drug_name.toLowerCase() || w.drug?.toLowerCase() === i.drug_name.toLowerCase()) })),
        notes,
      });
      setSaved(result);
      setExistingRx(prev => [{ ...result.prescription, items: result.items }, ...prev]);
      if (draftKey) { try { localStorage.removeItem(draftKey); } catch {} }
      setDraftRestored(false);
      // Save & Generate QR is the end-point: dispatch the visit (→ Consulted,
      // out of the queue) and release the lock. Non-fatal if it fails.
      try { await api.doctorDispatch(session.id); onDispatched?.(); } catch {}
    } catch (err) {
      setSaveError('Failed to save prescription: ' + (err.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  }

  // Which current meds are already in the New Prescription (case-insensitive),
  // used to dedupe "Continue all" and to disable it once everything is added.
  // Drug names that the checker flagged as clashing with a patient allergy — used
  // to put a red "⚠ allergy" badge right on the offending prescription row.
  const allergyHits = new Set(
    warnings.filter(w => w.allergy && w.drug).map(w => String(w.drug).trim().toLowerCase())
  );
  const rxDrugNames = new Set(items.filter(i => i.drug_name).map(i => i.drug_name.trim().toLowerCase()));
  const namedCurrentMeds = currentMeds.filter(m => m.drug_name);
  const allCurrentAdded = namedCurrentMeds.length > 0 && namedCurrentMeds.every(m => rxDrugNames.has(m.drug_name.trim().toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {dialog}
      {toastView}
      {/* The whole prescription form is hidden once saved — at that point the
          consultation is done and only the QR result below is relevant. */}
      {!saved && (<>
      {/* Allergy banner — always shown so the doctor knows the allergy status at
          a glance. Red when the patient has any (from intake or doctor-added);
          neutral green when explicitly none. */}
      {allergyList.length > 0 ? (
        <div style={{ background: '#FADBD8', border: '1px solid #E6B0AA', borderRadius: 8, padding: 10, fontSize: 'calc(13px * var(--fs))', color: '#943126' }}>
          <strong>⚠ Known allergies:</strong> {allergyList.join(', ')}
          <div style={{ fontSize: 'calc(11px * var(--fs))', color: '#B03A2E', marginTop: 2 }}>
            Drugs that clash with these are flagged below and blocked on save.
          </div>
        </div>
      ) : (
        <div style={{ background: '#EAFAF1', border: '1px solid #ABEBC6', borderRadius: 8, padding: 10, fontSize: 'calc(13px * var(--fs))', color: 'var(--green-on-tint)' }}>
          ✓ No known drug allergies reported.
        </div>
      )}

      {/* Current medications from session (OCR + patient-reported) */}
      {currentMeds.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, border: '1px solid #E0E0E0' }}>
          <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>Current Medications</h3>
          <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginBottom: 8 }}>
            From patient intake (OCR and questionnaire). Edit, delete, or carry forward to prescription.
          </p>
          {/* Column header (once) — keeps every data row uniform so Drug/Dose/Freq
              line up; the per-row labels used to make only row 0 taller. */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-end' }}>
            <div style={{ flex: 2, minWidth: 140 }}><label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Drug</label></div>
            <div style={{ flex: 1, minWidth: 60 }}><label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Dose</label></div>
            <div style={{ width: 70 }}><label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Freq</label></div>
            <span style={{ width: 52 }} aria-hidden="true" />
            <span style={{ width: 'calc(16px * var(--fs))' }} aria-hidden="true" />
          </div>
          {currentMeds.map((med, idx) => (
            <div key={med.id || idx} style={{ display: 'flex', gap: 6, marginBottom: med.brand ? 20 : 6, alignItems: 'center' }}>
              {/* position: relative so the "written as" caption can hang BELOW the
                  input without adding height to this column — otherwise the taller
                  Drug column pushed the centered Dose/Freq boxes down out of line. */}
              <div style={{ flex: 2, minWidth: 140, position: 'relative' }}>
                <input className="input" value={med.drug_name}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], drug_name: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 'calc(13px * var(--fs))' }} />
                {med.brand && (
                  <div style={{ position: 'absolute', top: '100%', left: 2, marginTop: 2, whiteSpace: 'nowrap', fontSize: 'calc(9px * var(--fs))', color: 'var(--text-light)' }}>written as: {med.brand}</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 60 }}>
                <input className="input" value={med.dose}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], dose: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 'calc(13px * var(--fs))' }} placeholder="dose" />
              </div>
              <div style={{ width: 70 }}>
                <select className="input" value={med.frequency}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], frequency: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 'calc(13px * var(--fs))' }}>
                  <option value="">-</option>
                  {FREQ_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <span style={{ width: 52, textAlign: 'center', flexShrink: 0, fontSize: 'calc(9px * var(--fs))', padding: '2px 4px', borderRadius: 4, background: med.source === 'document' ? '#EBF5FB' : '#FEF9E7', color: 'var(--text-light)' }}>
                {med.source === 'document' ? 'OCR' : 'Patient'}
              </span>
              <button type="button" onClick={() => setCurrentMeds(currentMeds.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(16px * var(--fs))', flexShrink: 0 }}>✕</button>
            </div>
          ))}
          <button type="button" disabled={allCurrentAdded} onClick={() => {
            // Carry current meds into the prescription, skipping any already added.
            const existing = items.filter(i => i.drug_name);
            const toAdd = namedCurrentMeds
              .filter(m => !rxDrugNames.has(m.drug_name.trim().toLowerCase()))
              .map(m => makeItem({ drug_name: m.drug_name, dose: m.dose, frequency: m.frequency || 'OD', duration: '', instructions: '' }));
            if (!toAdd.length) return;
            const updated = [...existing, ...toAdd, makeItem()];
            setItems(updated);
            persistDraft(updated, notes);
            setInteractionChecked(false);
          }} style={{
            background: allCurrentAdded ? '#BDC3C7' : 'var(--secondary)', color: '#fff', border: 'none',
            borderRadius: 6, padding: '6px 14px', cursor: allCurrentAdded ? 'default' : 'pointer',
            fontSize: 'calc(12px * var(--fs))', marginTop: 8,
          }}>
            {allCurrentAdded ? '✓ Added to prescription' : 'Continue all in prescription'}
          </button>
        </div>
      )}

      {/* Existing prescriptions from this session — click Reuse to load into the form */}
      {existingRx.length > 0 && (
        <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 10, fontSize: 'calc(12px * var(--fs))' }}>
          <strong>Previous Rx ({existingRx.length}):</strong>
          <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)', margin: '2px 0 6px' }}>
            Tap “Reuse” to load a past prescription's drugs into the new one.
          </p>
          {existingRx.map((rx, i) => {
            const rxNamed = (rx.items || []).filter(it => it.drug_name);
            const allAdded = rxNamed.length > 0 && rxNamed.every(it => rxDrugNames.has(it.drug_name.trim().toLowerCase()));
            return (
              <div key={i} style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>
                  {(rx.items || []).map(it => it.drug_name).join(', ')} — {new Date(rx.created_at).toLocaleDateString()}
                </span>
                <button type="button" disabled={allAdded} onClick={() => reusePrescription(rx)}
                  style={{
                    background: allAdded ? '#BDC3C7' : '#fff',
                    border: allAdded ? 'none' : '1px solid var(--secondary)',
                    color: allAdded ? '#fff' : 'var(--secondary)',
                    borderRadius: 6, padding: '3px 10px',
                    cursor: allAdded ? 'default' : 'pointer', fontSize: 'calc(11px * var(--fs))', whiteSpace: 'nowrap',
                  }}>
                  {allAdded ? '✓ Added' : '↺ Reuse'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* New Prescription items */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, border: '1px solid #E0E0E0' }}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>New Prescription</h3>

        {draftRestored && (
          <div style={{ background: '#FEF9E7', border: '1px solid #F4D03F', borderRadius: 8, padding: '8px 10px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'calc(12px * var(--fs))', color: '#7D6608' }}>📝 Restored an unsaved prescription draft for this patient.</span>
            <button type="button" onClick={clearDraft}
              style={{ background: '#fff', border: '1px solid #F4D03F', color: '#7D6608', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(11px * var(--fs))', whiteSpace: 'nowrap' }}>
              Clear
            </button>
          </div>
        )}

        {items.map((item, idx) => {
          const isAllergyHit = allergyHits.has((item.drug_name || '').trim().toLowerCase());
          return (
          <div key={item.id} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 150 }}>
                {idx === 0 && <label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Drug</label>}
                <DrugCombobox value={item.drug_name}
                  onChange={v => updateItem(idx, 'drug_name', v)}
                  options={drugList}
                  placeholder="Drug name" style={{ minHeight: 34, fontSize: 'calc(13px * var(--fs))' }} />
              </div>
              <div style={{ flex: 1, minWidth: 70 }}>
                {idx === 0 && <label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Dose</label>}
                <input className="input" value={item.dose}
                  onChange={e => updateItem(idx, 'dose', e.target.value)}
                  placeholder="e.g. 5mg"
                  style={{ minHeight: 34, fontSize: 'calc(13px * var(--fs))', ...(showItemErrors && String(item.drug_name || '').trim() && !String(item.dose || '').trim() ? { border: '1.5px solid var(--red)', background: '#FDEDEC' } : {}) }} />
              </div>
              <div style={{ width: 80 }}>
                {idx === 0 && <label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Freq</label>}
                <select className="input" value={item.frequency}
                  onChange={e => updateItem(idx, 'frequency', e.target.value)}
                  style={{ minHeight: 34, fontSize: 'calc(13px * var(--fs))' }}>
                  {FREQ_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 70 }}>
                {idx === 0 && <label style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Duration</label>}
                <input className="input" value={item.duration}
                  onChange={e => updateItem(idx, 'duration', e.target.value)}
                  placeholder="e.g. 7 days"
                  style={{ minHeight: 34, fontSize: 'calc(13px * var(--fs))', ...(showItemErrors && String(item.drug_name || '').trim() && !String(item.duration || '').trim() ? { border: '1.5px solid var(--red)', background: '#FDEDEC' } : {}) }} />
              </div>
              <button type="button" onClick={() => removeItem(idx)}
                style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))', minHeight: 34 }}>
                ✕
              </button>
            </div>
            {isAllergyHit && (
              <div style={{ fontSize: 'calc(11px * var(--fs))', color: '#C0392B', fontWeight: 700, marginTop: 3 }}>
                ⚠ allergy contraindication
              </div>
            )}
          </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={addItem}
            style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
            + Add Drug
          </button>
          <button type="button" onClick={checkInteractions}
            style={{ background: '#fff', border: '1px solid var(--secondary)', color: 'var(--secondary)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
            Check Interactions
          </button>
        </div>
      </div>

      {/* Warnings — bold summary banner the doctor can't miss, then each alert.
          Curated block/warn/allergy show in full; verbose AI advisories collapse. */}
      {warnings.length > 0 && (() => {
        const nBlock = warnings.filter(w => w.severity === 'block' && w.source !== 'ai').length;
        const nWarn = warnings.filter(w => w.severity === 'warn' && w.source !== 'ai').length;
        const nAi = warnings.filter(w => w.source === 'ai').length;
        const parts = [];
        if (nBlock) parts.push(`${nBlock} BLOCKED`);
        if (nWarn) parts.push(`${nWarn} warning${nWarn > 1 ? 's' : ''}`);
        if (nAi) parts.push(`${nAi} AI advisory${nAi > 1 ? '(s)' : ''}`);
        const tone = nBlock ? { bg: '#FADBD8', bd: '#C0392B', fg: '#922B21' }
          : nWarn ? { bg: '#FCF3CF', bd: '#D4AC0D', fg: '#7D6608' }
          : { bg: '#EAF3FB', bd: '#2E86AB', fg: '#1B4F72' };
        return (
          <div style={{ borderRadius: 8, overflow: 'hidden', border: `2px solid ${tone.bd}` }}>
            {/* Single dropdown header for the whole warnings list. */}
            <button type="button" onClick={() => setWarnOpen(o => !o)}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none',
                background: tone.bg, color: tone.fg, fontWeight: 800, fontSize: 'calc(14px * var(--fs))',
                padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 'calc(16px * var(--fs))' }}>⚠</span>
              <span>{parts.join('  ·  ')}</span>
              <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--fs))' }}>{warnOpen ? '▾ Hide' : '▸ View'}</span>
            </button>
            {warnOpen && (
              <>
                {warnings.map((w, i) => <WarningRow key={i} w={w} />)}
                {nAi > 0 && (
                  <div style={{ background: '#F4F8FB', padding: '7px 10px', fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>
                    ⓘ AI-assessed items are for a drug not in the formulary — advisory only, do not block, and have been
                    sent to the HIS admin for review. Verify against a clinical reference before relying on them.
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* No-interaction confirmation. Only fully reassuring once any unrecognised
          drugs have also had the AI advisory run; otherwise nudge to run it. */}
      {interactionChecked && warnings.length === 0 && (
        unknownDrugs.length > 0 && !aiChecked ? (
          <div style={{ background: '#FEF9E7', border: '1px solid #F4D03F', borderRadius: 8, padding: 10, fontSize: 'calc(13px * var(--fs))', color: '#7D6608' }}>
            No issues among known drugs. <strong>{unknownDrugs.join(', ')}</strong> {unknownDrugs.length > 1 ? 'are' : 'is'} not in the formulary —
            click <strong>Check Interactions</strong> for an AI allergy/interaction review.
          </div>
        ) : (
          <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 10, fontSize: 'calc(13px * var(--fs))', color: 'var(--green-on-tint)', fontWeight: 600 }}>
            ✓ No negative interactions found.
          </div>
        )
      )}

      {/* AI availability note */}
      {aiNote && (
        <div style={{ background: '#FEF9E7', borderRadius: 8, padding: 8, fontSize: 'calc(12px * var(--fs))', color: '#856404' }}>
          {aiNote}
        </div>
      )}

      {/* Consultation Scribe — record the visit; its patient-facing summary
          auto-fills the Doctor's Advice box just below. */}
      <ScribePanel session={session} embedded onAdvice={applyAdvice} />

      {/* Doctor's Advice & Instructions + Save */}
      <div>
        <label style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, color: 'var(--primary)' }}>Patient summary <span style={{ fontWeight: 400, color: 'var(--text-light)' }}>(printed on the prescription)</span></label>
        <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', margin: '2px 0 6px' }}>
          Auto-filled from the consultation scribe — plain-language guidance the patient sees on the printed &amp; digital Rx. Edit before saving.
        </p>
        <textarea className="input" rows={4} value={notes}
          onChange={e => { setNotes(e.target.value); persistDraft(items, e.target.value); }}
          placeholder="Record the consultation above to auto-fill this, or type the patient's instructions here. e.g. Drink plenty of fluids and rest. Get a blood test done. Come back in 5 days, or sooner if the fever worsens." />
      </div>

      {/* Advice-only heads-up — shown only when NO medication is entered but there
          is advice to save. This is the zero-drug case; the dose/duration warning
          only fires when a drug IS entered, so the two alerts never overlap. */}
      {!items.some(i => i.drug_name) && String(notes || '').trim() && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: '#FFF8E1', border: '1px solid #F0C36D', borderRadius: 8, padding: '10px 12px' }}>
          <span style={{ fontSize: 'calc(15px * var(--fs))', lineHeight: 1.2 }}>⚠️</span>
          <span style={{ fontSize: 'calc(12.5px * var(--fs))', color: '#8A6D1B', lineHeight: 1.5 }}>
            <strong>No medication added.</strong> This will be saved as an <strong>advice-only</strong> prescription (guidance only, no drugs). You&#39;ll be asked to confirm.
          </span>
        </div>
      )}

      {/* Save needs at least a drug OR some advice (advice-only is allowed —
          handleSave confirms the no-drug case). When nothing is entered the button
          is visibly greyed and a hint explains why, so it never looks like a dead
          click. */}
      {(() => {
        const nothingToSave = !items.some(i => i.drug_name) && !String(notes || '').trim();
        const off = saving || nothingToSave;
        return (
          <>
            <button className="btn btn-primary" onClick={handleSave} disabled={off}
              style={{ opacity: off ? 0.5 : 1, cursor: off ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Saving...' : 'Save & Generate QR'}
            </button>
            {nothingToSave && !saving && (
              <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', textAlign: 'center', marginTop: 2 }}>
                Add a medicine, or type advice in <strong>Patient summary</strong> above, to save.
              </p>
            )}
          </>
        );
      })()}
      {saveError && (
        <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))', textAlign: 'center', fontWeight: 600 }}>⚠ {saveError}</p>
      )}
      </>)}

      {/* Saved result — printed prescription (medications) FIRST, QR below. A
          doctor reviewing this cares about the meds; the QR is for the patient to
          open the verified digital Rx at the pharmacy. */}
      {saved && (
        <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <p style={{ fontWeight: 600, color: 'var(--green-on-tint)', marginBottom: 12 }}>✓ Prescription saved!</p>

          {/* Printed prescription card (medications + advice) */}
          <div style={{ background: '#fff', borderRadius: 10, padding: 14, textAlign: 'left', marginBottom: 12, border: '1px solid #cfe9d8' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', borderBottom: '1px solid #eef1f3', paddingBottom: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 700, color: 'var(--primary)' }}>
                {saved.prescription?.patient_name || session?.patient_name || 'Patient'}
              </span>
              <span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>
                {new Date(saved.issued_at || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
              </span>
            </div>
            {(saved.items || []).length === 0 ? (
              <p style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)', fontStyle: 'italic' }}>No medication prescribed — advice only.</p>
            ) : (
              (saved.items || []).map((it, i) => (
                <p key={i} style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text)', marginBottom: 4 }}>
                  • <strong>{it.drug_name}</strong>
                  {it.dose ? ` ${it.dose}` : ''}{it.frequency ? ` — ${it.frequency}` : ''}
                  {it.duration ? `, ${it.duration}` : ''}
                  {it.instructions ? ` (${it.instructions})` : ''}
                </p>
              ))
            )}
            {saved.prescription?.notes && (
              <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text)', marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e0e0e0' }}>
                <strong style={{ color: 'var(--primary)' }}>Advice:</strong> {saved.prescription.notes}
              </p>
            )}
          </div>

          {/* Scannable QR (secondary) */}
          {qrUrl && (
            <div style={{ background: '#fff', display: 'inline-block', padding: 10, borderRadius: 8, marginBottom: 6 }}>
              <img src={qrUrl} alt="Prescription QR code" style={{ display: 'block', width: 170, height: 170 }} />
            </div>
          )}
          {qrError && (<p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--red)', marginBottom: 8 }}>{qrError}</p>)}
          <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 12 }}>
            Scan to open the verified digital prescription.
          </p>

          {/* Print / Save PDF */}
          <button className="btn btn-primary" onClick={printPrescription}
            style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            🖨 Print / Save PDF
          </button>

          {/* Back to a blank form to add another prescription for this visit. */}
          <button className="btn btn-outline" onClick={() => { setSaved(null); setQrUrl(''); setQrError(''); }}
            style={{ marginBottom: 12 }}>
            ＋ Write another prescription
          </button>
        </div>
      )}
    </div>
  );
}

// Build the patient-facing advice from a SOAP note. Prefers the LLM's
// plain-language `patient_advice`; falls back to formatting the plan's
// patient-relevant fields (education / follow-up / tests / referrals). Never
// includes diagnoses or the drug schedule.
function buildPatientAdvice(soap) {
  if (!soap) return '';
  const direct = (soap.patient_advice || '').trim();
  if (direct) return direct;
  const plan = soap.plan || {};
  const clean = v => {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(x => x && !/^not discussed$/i.test(x)).join('; ');
    const s = String(v).trim();
    return /^not discussed$/i.test(s) ? '' : s;
  };
  const parts = [];
  const edu = clean(plan.patient_education); if (edu) parts.push(edu);
  const fu = clean(plan.follow_up); if (fu) parts.push('Follow-up: ' + fu);
  const inv = clean(plan.investigations_ordered); if (inv) parts.push('Tests to get: ' + inv);
  const ref = clean(plan.referrals); if (ref) parts.push('Referral: ' + ref);
  return parts.join('\n');
}

// Render a structured SOAP object as a readable, editable plain-text note. Also
// handles the edited free-text shape ({text}) we store back, and a raw string.
function soapToText(soap) {
  if (!soap) return '';
  if (typeof soap === 'string') return soap;
  if (typeof soap.text === 'string') return soap.text;
  const skip = v => v == null || /^not discussed$/i.test(String(v).trim());
  const fmtVal = v => Array.isArray(v)
    ? v.map(x => String(x).trim()).filter(Boolean).join(', ')
    : String(v).trim();
  const titleCaseLabel = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const out = [];
  for (const [key, title] of [['subjective', 'SUBJECTIVE'], ['objective', 'OBJECTIVE'], ['assessment', 'ASSESSMENT'], ['plan', 'PLAN']]) {
    const sec = soap[key];
    if (!sec || typeof sec !== 'object') continue;
    const rows = Object.entries(sec).filter(([_, v]) => !skip(v) && fmtVal(v));
    if (!rows.length) continue;
    out.push(title);
    for (const [k, v] of rows) out.push(`- ${titleCaseLabel(k)}: ${fmtVal(v)}`);
    out.push('');
  }
  return out.join('\n').trim();
}

function ScribePanel({ session, embedded = false, onAdvice }) {
  const [recording, setRecording] = useState(false);
  const [soapText, setSoapText] = useState('');   // the editable SOAP note (free text)
  const [processing, setProcessing] = useState('');
  const [open, setOpen] = useState(!embedded);     // collapsed by default when embedded
  const [advised, setAdvised] = useState(false);   // seeded the patient summary at least once
  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);
  const { toast, toastView } = useToast();

  useEffect(() => {
    // Load any existing (possibly edited) SOAP note for this patient.
    if (session?.id) {
      api.getSOAP(session.id).then(data => setSoapText(soapToText(data.soap))).catch(() => {});
    }
    return () => { if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop(); };
  }, [session?.id]);

  // Persist the edited SOAP note (called on blur; non-fatal).
  function persistSoap(text) {
    if (session?.id) api.saveSOAP(session.id, text).catch(() => {});
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      audioChunks.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.current.push(e.data); };
      recorder.start(1000);
      mediaRecorder.current = recorder;
      setRecording(true);
    } catch (err) {
      toast('Microphone access denied: ' + err.message, 'error');
    }
  }

  // Stop → transcribe → extract SOAP, all in one go (the doctor never sees the
  // transcript). The resulting note is editable below.
  async function stopRecording() {
    if (!mediaRecorder.current) return;
    return new Promise(resolve => {
      mediaRecorder.current.onstop = async () => {
        const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
        mediaRecorder.current.stream.getTracks().forEach(t => t.stop());
        mediaRecorder.current = null;
        setRecording(false);
        try {
          setProcessing('Transcribing…');
          const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
          const tr = await api.transcribeAudio(file, session?.id);
          const transcript = (tr.transcript || '').trim();
          if (!transcript) {
            toast('No speech detected — try again, or type the note below.', 'error');
          } else {
            setProcessing('Generating consultation notes…');
            const result = await api.extractSOAP({ transcript, session_id: session?.id });
            const text = soapToText(result.soap);
            // Fresh note → set; if the doctor already had text, append below.
            const next = soapText.trim() ? (soapText.trimEnd() + '\n\n' + text) : text;
            setSoapText(next);
            persistSoap(next);
            // Seed the patient-facing summary (caller sets/append-dedupes; editable).
            if (onAdvice) {
              const advice = buildPatientAdvice(result.soap);
              if (advice) { onAdvice(advice); setAdvised(true); }
            }
          }
        } catch (err) {
          toast('Could not generate notes: ' + err.message, 'error');
        }
        setProcessing('');
        resolve();
      };
      mediaRecorder.current.stop();
    });
  }

  // Scribe stays inside Prescribe (folded-in, not a separate tab), but the RECORD
  // action is always visible; the SOAP note is the collapsible dropdown. `open`
  // now controls whether the SOAP note is expanded (collapsed by default).
  const soapReady = !!(soapText && soapText.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12,
      ...(embedded ? { border: '1px solid #E0E0E0', borderRadius: 12, padding: 14, marginBottom: 4 } : {}) }}>
      {toastView}

      {/* Title + always-visible recording control */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: 600, color: 'var(--primary)' }}>🎙 Consultation Scribe</span>
        {!recording ? (
          <button className="btn btn-primary" onClick={startRecording} disabled={!!processing}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', padding: '0 20px', marginLeft: 'auto' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', display: 'inline-block' }} />
            Start Recording
          </button>
        ) : (
          <button className="btn" onClick={stopRecording}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', padding: '0 20px', marginLeft: 'auto', background: 'var(--red)', color: '#fff', border: 'none' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: '#fff', display: 'inline-block', animation: 'pulse 1s infinite' }} />
            Stop Recording
          </button>
        )}
      </div>
      {processing && <span style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--secondary)' }}>{processing}</span>}
      <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', margin: 0 }}>
        Record the consultation → editable SOAP note (below) + a plain-language summary added to <strong>Patient summary</strong>. Audio is transcribed then discarded.
      </p>

      {/* SOAP note — collapsible dropdown */}
      <div style={{ borderTop: '1px solid #EEF1F3', paddingTop: 10 }}>
        <button type="button" onClick={() => setOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: 0 }}>
          <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, color: 'var(--primary)' }}>SOAP Note</span>
          <span style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{soapReady ? '✓ note ready' : '(editable — your clinical record)'}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-light)' }}>{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div>
            <textarea className="input" value={soapText}
              onChange={e => setSoapText(e.target.value)}
              onBlur={() => persistSoap(soapText)}
              rows={10}
              placeholder="Record the consultation to auto-generate the SOAP note here, or type it directly…"
              style={{ fontSize: 'calc(13px * var(--fs))', lineHeight: 1.6, marginTop: 8 }} />
            {embedded && advised && (
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--green-on-tint)', marginTop: 4 }}>
                ✓ A plain-language summary was added to <strong>Patient summary</strong> below — review/edit before saving.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DoctorApp() {
  const [doctor, setDoctor] = useState(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('doctor_token');
    const savedDoc = sessionStorage.getItem('doctor_info');
    if (saved && savedDoc) {
      setToken(saved);
      setDoctor(JSON.parse(savedDoc));
    }
  }, []);

  function handleLogin(result) {
    setToken(result.token);
    sessionStorage.setItem('doctor_token', result.token);
    sessionStorage.setItem('doctor_info', JSON.stringify(result.doctor));
    setDoctor(result.doctor);
  }

  if (!doctor) return <PinLogin onLogin={handleLogin} />;
  return <DoctorDashboard doctor={doctor} />;
}
