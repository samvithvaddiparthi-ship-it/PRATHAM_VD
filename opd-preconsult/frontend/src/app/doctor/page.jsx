'use client';
import { useState, useEffect, useRef, useMemo } from 'react';
import QRCode from 'qrcode';
import { api, setToken } from '../../lib/api';
import TriageBadge from '../../components/TriageBadge';
import ReactMarkdown from 'react-markdown';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import VitalsForm, { hasVitals } from '../../components/VitalsForm';

const TRIAGE_COLORS = { RED: '#D9544D', AMBER: '#E0A82E', GREEN: '#3FA869' };
const TRIAGE_SEVERITY = { RED: 0, AMBER: 1, GREEN: 2 };

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
function groupByPatient(list) {
  const map = new Map();
  for (const s of list) {
    const key = s.patient_phone || s.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const RELEASE_RECENT = v => !!v.released_at && (Date.now() - new Date(v.released_at).getTime() < 24 * 3600 * 1000);
  // A visit's "queue recency": a just-released visit ranks by its release time, so
  // releasing an OLD visit makes it the patient's representative entry (it floats
  // to the top of the queue), otherwise by when it was filled.
  const recencyOf = v => new Date((RELEASE_RECENT(v) && v.released_at) || v.created_at).getTime();
  const patients = [];
  for (const [phone, visits] of map) {
    visits.sort((a, b) => recencyOf(b) - recencyOf(a));
    const latest = visits[0];
    const filledNow = !!latest.is_recent;
    patients.push({
      phone,
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
      triage: filledNow ? latest.triage_level : null,
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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <form onSubmit={handleSubmit} style={{
        background: '#fff', borderRadius: 16, padding: 32, width: 360,
        boxShadow: '0 4px 24px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: 16
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>👨‍⚕️</div>
          <h2 style={{ color: 'var(--primary)', fontSize: 20 }}>Doctor Login</h2>
          <p style={{ color: 'var(--text-light)', fontSize: 13, marginTop: 4 }}>Enter your phone number and PIN</p>
        </div>
        <div>
          <label style={{ fontSize: 13, color: 'var(--text-light)' }}>Phone Number</label>
          <input className="input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="9876500001" required autoFocus />
        </div>
        <div>
          <label style={{ fontSize: 13, color: 'var(--text-light)' }}>PIN (4-6 digits)</label>
          <input className="input" type="password" inputMode="numeric" maxLength={6} value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" required
            style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }} />
        </div>
        {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading || pin.length < 4}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-light)', textAlign: 'center' }}>Demo: Phone 9876500001, PIN 1234</p>
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
  const [loading, setLoading] = useState(false);
  const [doctors, setDoctors] = useState([]);
  const [rightTab, setRightTab] = useState('report'); // report | prescribe (Scribe is embedded in Prescribe)
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
  const [confirmDelete, setConfirmDelete] = useState(false); // delete confirmation modal
  const [deleteAck, setDeleteAck] = useState(false);     // "I understand" checkbox
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

  useEffect(() => {
    loadQueue();
    api.listDoctors(doctor.department).then(setDoctors).catch(() => {});
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
    const recent = groupByPatient(sessions).filter(p => p.filledNow).map(p => p.phone);
    if (!recent.length) return;
    setPinned(prev => {
      let changed = false;
      const next = { ...prev };
      for (const ph of recent) if (!next[ph]) { next[ph] = true; changed = true; }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Keep activeLock in sync with the server's truth: whatever patient is locked
  // to me (assigned, not yet dispatched) IS my active consultation. This both
  // restores the lock after a browser reload and clears it once I finish/abandon
  // — so I can never get stuck, and can never hold two at once.
  useEffect(() => {
    const mine = groupByPatient(sessions).find(p => p.lockedById === doctor.id && !p.dispatched);
    if (mine && activeLock !== mine.phone) setActiveLock(mine.phone);
    else if (!mine && activeLock) setActiveLock(null);
  }, [sessions]);

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
    if (t === 'queue') loadQueue();
  }

  async function selectSession(s) {
    setSelected(s);
    setReport(null);
    setRightTab('report');
    setPrescribeMounted(false);   // fresh Prescribe panel for the newly-opened patient
    setLoading(true);
    // No auto-assign here — locking a queue patient happens explicitly via
    // openPatient() (with the confirm dialog). selectSession just loads a visit.
    try { setReport(await api.getReport(s.id)); } catch { setReport(null); }
    setLoading(false);
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
      await api.generateReport(selected.id);
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
    const lockedByMe = (p.lockedById && p.lockedById === doctor.id) || activeLock === p.phone;
    const lockedByOther = p.lockedById && p.lockedById !== doctor.id && activeLock !== p.phone;

    // Already mine → just toggle the tree open/closed, no confirm.
    if (lockedByMe) {
      setExpanded(e => ({ ...e, [p.phone]: !e[p.phone] }));
      return;
    }
    // I'm mid-consultation with someone else → block the switch.
    if (activeLock && activeLock !== p.phone) {
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
      message: `${p.name} · ${p.phone}\nOnce you open them, other doctors won't be able to view this patient until you finish (Save & Generate QR).`,
      confirmLabel: 'Open & lock',
    }))) return;

    const res = await api.doctorOpen(p.latest.id).catch(() => ({ ok: false, error: true }));
    if (res.ok) {
      setActiveLock(p.phone);
      setExpanded(e => ({ ...e, [p.phone]: true }));
      markSeen(p.latest.id);
      selectSession(p.latest);
      loadQueue();
    } else if (res.locked) {
      toast(`Being consulted by ${res.locked_by || 'another doctor'}`, 'error');
      loadQueue();
    } else {
      toast('Could not open patient — please try again.', 'error');
    }
  }

  // Called by PrescriptionPanel after a successful Save & Generate QR: the visit
  // is dispatched (now in Consulted, gone from the queue) and the lock is freed.
  function handleDispatched() {
    setActiveLock(null);
    loadQueue();
    loadConsulted();
    // After Save & Generate QR the visit belongs to Consulted, so jump the left
    // list there. To revert to "stay on Queue", delete just this one line.
    setTab('consulted');
  }

  // Release a CONSULTED visit back to the active queue. Clears the doctor link +
  // consulted stamp on the server and pops it to the top of the queue as a NEW
  // entry. We also un-"see" the visit locally so its NEW badge shows again.
  async function handleRelease() {
    if (!selected) return;
    if (!(await confirm({
      title: 'Release back to queue?',
      message: 'This removes the visit from your Consulted list and sends it back to the top of the active queue as a new entry.',
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

  async function handleReassign(targetId) {
    if (!selected || !targetId) return;
    await api.doctorReassign(selected.id, targetId);
    setSelected(null);
    setReport(null);
    loadQueue();
  }

  // Permanently delete the selected patient entry (guarded by the checkbox
  // confirmation modal). Removes the session and all its associated data.
  async function handleDelete() {
    if (!selected || !deleteAck) return;
    setDeleting(true);
    try {
      await api.doctorDeleteSession(selected.id);
      setConfirmDelete(false);
      setDeleteAck(false);
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

  // Refresh the active tab. Spins for the real fetch time but holds the spin a
  // minimum ~0.7s so a near-instant local refresh still visibly registers.
  async function refreshActive() {
    if (refreshing) return;
    setRefreshing(true);
    const started = Date.now();
    try {
      await (tab === 'queue' ? loadQueue() : loadConsulted());
    } finally {
      const remaining = 500 - (Date.now() - started);
      setTimeout(() => setRefreshing(false), Math.max(0, remaining));
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

  const otherDoctors = doctors.filter(d => d.id !== doctor.id);
  const currentList = tab === 'queue' ? sessions : consulted;
  // Queue tree: show patients with a "filled now" visit (completed in the last
  // 24h) — i.e. patients who are actually here now — plus any patient already
  // pinned this session (they appeared with a recent fill, so they stay visible
  // even after that visit is deleted). A patient with ONLY old visits and no
  // recent fill (never pinned) does not show up.
  // Queue excludes DISPATCHED patients (finished via Save & Generate QR — they
  // move to Consulted). Locked-but-not-finished patients stay (shown in-progress).
  const patients = groupByPatient(sessions).filter(p => (p.filledNow || pinned[p.phone]) && !p.dispatched);
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
  const searchSource = tab === 'queue'
    ? patients.map(p => ({ name: p.name, phone: p.phone }))
    : consultedList.map(s => ({ name: s.patient_name || '', phone: s.patient_phone || '' }));
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

  // "Waiting" = queue patients the doctor hasn't opened/consulted yet. Once a
  // patient's current visit is consulted (it has consulted_at / a doctor), they
  // still appear in the tree for reference but count as "seen", not "waiting".
  const isConsulted = p => !!(p.latest && (p.latest.consulted_at || p.latest.assigned_doctor_id));
  const waitingCount = patients.filter(p => !isConsulted(p)).length;
  const seenInQueueCount = patients.length - waitingCount;

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
    <div className="doctor-layout" style={{ display: 'flex', gap: 16, height: '100vh', overflow: 'hidden', boxSizing: 'border-box' }}>
      {dialog}
      {toastView}
      {/* Left Panel — fixed-height column: the header/tabs/search stay put while
          only the patient list below scrolls in its own scrollbar. */}
      <div style={{ width: 340, flexShrink: 0, position: 'sticky', top: 16, height: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column' }}>
        <style>{`@keyframes skpulse { 0%,100% { opacity:1 } 50% { opacity:.45 } } @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 11, color: 'var(--text-light)', margin: 0 }}>{greeting},</p>
            <h2 style={{ fontSize: 16, color: 'var(--primary)', margin: '1px 0' }}>{doctor.name}</h2>
            <p style={{ fontSize: 12, color: 'var(--text-light)', margin: 0 }}>{doctor.department} Department</p>
            <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 5 }}>🗓️ {dateStr} · {timeStr}</p>
          </div>
          <button onClick={handleLogout} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>Logout</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button className={`btn ${tab === 'queue' ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: 1, fontSize: 13, minHeight: 36 }} onClick={() => switchTab('queue')}>
            Queue ({patients.length})
          </button>
          <button className={`btn ${tab === 'consulted' ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: 1, fontSize: 13, minHeight: 36 }} onClick={() => switchTab('consulted')}>
            Consulted
          </button>
        </div>

        {/* Search box (both tabs) — filters by name or phone, with inline ghost prediction */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <div aria-hidden style={{ position: 'absolute', inset: 0, padding: '8px 10px', border: '1px solid transparent', fontSize: 13, fontFamily: 'inherit', whiteSpace: 'pre', overflow: 'hidden', pointerEvents: 'none', color: '#b0b8c1', boxSizing: 'border-box' }}>
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
            style={{ position: 'relative', background: 'transparent', width: '100%', padding: '8px 10px', border: '1px solid #ccc', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
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
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
            {tab === 'queue'
              ? <>{waitingCount} waiting{seenInQueueCount > 0 && <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> · {seenInQueueCount} seen</span>}</>
              : <>{filteredConsulted.length} consulted{consultedTodayCount > 0 && <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> · {consultedTodayCount} today</span>}</>}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {(() => {
              const counts = tab === 'queue' ? triageCounts : consultedTriageCounts;
              return ['RED', 'AMBER', 'GREEN'].some(l => counts[l] > 0) && (
                <span style={{ display: 'inline-flex', gap: 9, fontSize: 12 }}>
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
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 10px', borderRadius: 13, border: '1px solid #d5dce4', background: '#fff', color: 'var(--secondary)', cursor: refreshing ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, lineHeight: 1, opacity: refreshing ? 0.7 : 1 }}>
              <span style={{ display: 'inline-block', fontSize: 14, animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}>↻</span>
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </span>
        </div>

        {/* Scrollable list region — flex:1 so it fills the remaining column
            height, with its own vertical scrollbar (the rest of the panel and
            the right report pane stay fixed). */}
        <div className="scrolly" style={{ flex: 1, minHeight: 0, marginRight: -6, paddingRight: 6 }}>
        {tab === 'queue' && (!queueLoaded || refreshing) && <SkeletonRows n={Math.max(3, Math.min(filteredPatients.length || 4, 6))} />}
        {tab === 'queue' && queueLoaded && !refreshing && filteredPatients.map(p => {
          const lockedByMe = (p.lockedById && p.lockedById === doctor.id) || activeLock === p.phone;
          const lockedByOther = p.lockedById && p.lockedById !== doctor.id && activeLock !== p.phone;
          // Only the patient I currently hold shows its visit tree — others can't
          // be expanded/peeked (opening = locking, which requires the confirm).
          const isOpen = lockedByMe && !!expanded[p.phone];
          const headColor = p.triage ? TRIAGE_COLORS[p.triage] : null;
          return (
            <div key={p.phone} style={{ marginBottom: 8 }}>
              {/* Patient heading */}
              <div onClick={() => openPatient(p)}
                /* Header tinted by the patient's current triage; greyed out when
                   another doctor holds the lock. */
                style={{ display: 'flex', alignItems: 'stretch', gap: 8, cursor: lockedByOther ? 'not-allowed' : 'pointer', padding: '8px 10px', borderRadius: 8, background: lockedByOther ? '#F2F3F5' : (headColor ? `${headColor}14` : '#fff'), boxShadow: '0 1px 3px rgba(0,0,0,0.06)', opacity: lockedByOther ? 0.75 : 1, outline: lockedByMe ? '2px solid var(--secondary)' : 'none', outlineOffset: -2 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', overflowWrap: 'anywhere' }}>{p.name}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-light)' }}>{p.phone} · {p.visits.length} visit{p.visits.length > 1 ? 's' : ''}</p>
                  {lockedByOther && (
                    <p style={{ fontSize: 10.5, color: '#C0392B', fontWeight: 600, marginTop: 2 }}>🔒 Being consulted by {p.lockedByName || 'another doctor'}</p>
                  )}
                  {lockedByMe && (
                    <p style={{ fontSize: 10.5, color: 'var(--secondary)', fontWeight: 600, marginTop: 2 }}>● You're consulting</p>
                  )}
                </div>
                <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6 }}>
                  {p.triage ? <TriageBadge level={p.triage} compact /> : <span />}
                  {lockedByOther ? (
                    <span style={{ fontSize: 14 }}>🔒</span>
                  ) : (p.filledNow && !seenNew[p.latest.id]) ? (
                    <span style={{ fontSize: 9, background: headColor || '#888', color: '#fff', padding: '2px 6px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.3 }}>NEW</span>
                  ) : (
                    <span style={{ fontSize: 14, color: 'var(--text-light)' }}>{isOpen ? '▾' : '▸'}</span>
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
                    const meds = v.prescription_items || [];
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
                            <p style={{ fontSize: 12, fontWeight: 600 }}>
                              {isReleased ? '↩ Returned to queue' : isFilledNow ? '★ Filled now' : fmtVisitDate(v.created_at)}
                            </p>
                            {(isFilledNow || isReleased) && <p style={{ fontSize: 10, color: 'var(--text-light)' }}>{fmtVisitDate(v.created_at)}</p>}
                          </div>
                        </div>
                        {/* Prescriptions for this particular visit */}
                        {meds.length > 0 ? (
                          <div style={{ marginTop: 4, marginLeft: 2 }}>
                            {meds.map((it, ii) => (
                              <p key={ii} style={{ fontSize: 10, color: 'var(--text-light)' }}>
                                💊 {it.drug_name}{it.dose ? ` ${it.dose}` : ''}{it.frequency ? ` · ${it.frequency}` : ''}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <p style={{ fontSize: 10, color: '#bbb', marginTop: 2, marginLeft: 2 }}>No prescription</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {tab === 'queue' && queueLoaded && !refreshing && filteredPatients.length === 0 && (
          <p style={{ color: 'var(--text-light)', padding: 16, textAlign: 'center' }}>
            {q ? `No patients match “${search.trim()}”` : 'No patients yet'}
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
                <p style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', minWidth: 0, overflowWrap: 'anywhere' }}>{s.patient_name || 'Unregistered'}</p>
                {s.triage_level && <div style={{ flexShrink: 0 }}><TriageBadge level={s.triage_level} compact /></div>}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-light)' }}>
                {s.patient_age ? `${s.patient_age}y` : ''} {s.patient_gender || ''}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-light)' }}>
                🕒 Consulted: {fmtVisitDate(s.dispatched_at || s.consulted_at || s.updated_at)}
              </p>
              {s.doctor_feedback && (
                <span style={{ fontSize: 10, background: s.doctor_feedback === 'accurate' ? '#D5F5E3' : '#FADBD8',
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
      <div className="scrolly" style={{ flex: 1, minWidth: 0, height: '100%', background: switchBlocked ? '#FDF1EF' : 'var(--card-bg)', borderRadius: 16, padding: 24, border: switchBlocked ? '1.5px solid #E6A79F' : '1.5px solid transparent', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', transition: 'background 0.15s, border-color 0.15s' }}>
        {/* Blocked-switch notice — you must finish the current patient first. */}
        {switchBlocked && (
          <div onClick={() => setSwitchBlocked(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%', boxShadow: '0 8px 30px rgba(0,0,0,0.25)', textAlign: 'center' }}>
              <div style={{ fontSize: 34, marginBottom: 8 }}>✋</div>
              <h3 style={{ color: '#C0392B', margin: '0 0 8px', fontSize: 18 }}>Finish this patient first</h3>
              <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)', margin: '0 0 18px' }}>
                You're currently consulting a patient. Complete their prescription and click
                <strong> Save &amp; Generate QR</strong> before opening another patient.
              </p>
              <button className="btn btn-primary" style={{ minWidth: 120 }} onClick={() => setSwitchBlocked(false)}>OK</button>
            </div>
          </div>
        )}
        {!selected && (
          <div style={{ textAlign: 'center', marginTop: 90, color: 'var(--text-light)' }}>
            <div style={{ fontSize: 56, marginBottom: 14, opacity: 0.45 }}>{tab === 'queue' ? '🩺' : '📋'}</div>
            <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', margin: '0 0 6px' }}>No patient selected</p>
            <p style={{ fontSize: 13, margin: 0 }}>
              {tab === 'queue'
                ? 'Pick a patient from the queue to view their pre-consult report.'
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
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                <TriageBadge level={selected.triage_level} />
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center', position: 'relative' }}>
                {/* Queue: reassign to another doctor (Release lives on the
                    Consulted side now — releasing returns a consulted visit to
                    the active queue). */}
                {tab === 'queue' && selected.assigned_doctor_id && otherDoctors.length > 0 && (
                  <select onChange={e => { if (e.target.value) handleReassign(e.target.value); e.target.value = ''; }}
                    style={{ border: '1px solid #ccc', borderRadius: 8, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>
                    <option value="">Reassign to...</option>
                    {otherDoctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                )}

                {/* Consulted: release this visit back to the active queue. */}
                {tab === 'consulted' && (
                  <button onClick={handleRelease}
                    title="Send this visit back to the active queue"
                    style={{ background: 'none', border: '1px solid #E74C3C', color: '#E74C3C', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>
                    ↩ Release to queue
                  </button>
                )}

                {/* Discrete kebab (⋯) menu — holds the destructive Delete action.
                    Only on the Queue tab: consulted visits are a permanent record
                    and can't be deleted, so the menu would be empty there. */}
                {tab === 'queue' && (
                  <>
                    <button onClick={() => setMenuOpen(o => !o)} title="More options"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '2px 8px', color: 'var(--text-light)', borderRadius: 6 }}>
                      ⋯
                    </button>
                    {menuOpen && (
                      <>
                        {/* click-away overlay */}
                        <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#fff', border: '1px solid #E0E0E0', borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.14)', zIndex: 10, minWidth: 190, overflow: 'hidden' }}>
                          <button onClick={() => { setMenuOpen(false); setDeleteAck(false); setConfirmDelete(true); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: '#E74C3C' }}>
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
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 1 }}>Patient</div>
              <h2 style={{ fontSize: 22, margin: 0, lineHeight: 1.2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{selected.patient_name}</h2>
              <p style={{ margin: '3px 0 0', color: 'var(--text-light)', fontSize: 13 }}>
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
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: (audioOpen && voiceClips.length) ? '#E8F8F5' : '#fff', border: '1px solid var(--accent)', color: '#138D75', borderRadius: 20, padding: '5px 13px', cursor: voiceClips.length ? 'pointer' : 'default', fontSize: 12.5, fontWeight: 600, opacity: voiceClips.length ? 1 : 0.6 }}>
                    🔊 Patient audio ({voiceClips.length})
                    {voiceClips.length > 0 && <span style={{ fontSize: 10, color: 'var(--text-light)' }}>{audioOpen ? '▲' : '▼'}</span>}
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
                            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                              {label}
                              {clip.duration_ms ? <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> · {(clip.duration_ms / 1000).toFixed(1)}s</span> : null}
                            </p>
                            <audio controls preload="none" src={api.answerAudioUrl(clip.id)} style={{ width: '100%', height: 36 }} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
            </div>

            {/* Delete confirmation modal — requires an explicit acknowledgement */}
            {confirmDelete && (
              <div onClick={() => { setConfirmDelete(false); setDeleteAck(false); }}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
                <div onClick={e => e.stopPropagation()}
                  style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
                  <h3 style={{ color: '#E74C3C', marginBottom: 12, fontSize: 18 }}>Remove patient entry?</h3>
                  <p style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 16, color: 'var(--text)' }}>
                    This removes <strong>{selected.patient_name}</strong> from the active dashboard (Queue) and from
                    the patient's previous-visit history. If this visit was consulted, it <strong>stays in your
                    Consulted history</strong> for the record — so you keep what they were seen for.
                  </p>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 18, cursor: 'pointer' }}>
                    <input type="checkbox" checked={deleteAck} onChange={e => setDeleteAck(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>I understand this removes the patient from the active dashboard.</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="btn btn-outline" style={{ fontSize: 13, padding: '8px 16px' }}
                      onClick={() => { setConfirmDelete(false); setDeleteAck(false); }} disabled={deleting}>
                      Cancel
                    </button>
                    <button onClick={handleDelete} disabled={!deleteAck || deleting}
                      style={{ background: deleteAck ? '#E74C3C' : '#ccc', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: deleteAck && !deleting ? 'pointer' : 'not-allowed' }}>
                      {deleting ? 'Removing…' : 'Remove from Dashboard'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Report / Prescribe tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              <button className={`btn ${rightTab === 'report' ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontSize: 13, minHeight: 32, width: 'auto', padding: '0 16px' }}
                onClick={() => setRightTab('report')}>Report</button>
              <button className={`btn ${rightTab === 'prescribe' ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontSize: 13, minHeight: 32, width: 'auto', padding: '0 16px' }}
                onClick={() => { setRightTab('prescribe'); setPrescribeMounted(true); }}>Prescribe</button>
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
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#B9770E', background: '#FEF9E7', border: '1px solid #F7DC6F', borderRadius: 6, padding: '3px 9px' }}>✎ Edited by doctor</span>
                        <button onClick={() => setShowOriginal(true)} style={{ background: 'none', border: 'none', color: 'var(--secondary)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>View original (AI)</button>
                      </div>
                    )}
                    {report.doctor_correction && showOriginal && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-light)' }}>Original AI report</span>
                        <button onClick={() => setShowOriginal(false)} style={{ background: 'none', border: 'none', color: 'var(--secondary)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>Back to edited</button>
                      </div>
                    )}
                    <div style={{ lineHeight: 1.8, fontSize: 15 }}>
                      <ReactMarkdown>{(report.doctor_correction && !showOriginal) ? report.doctor_correction : report.report_md}</ReactMarkdown>
                    </div>

                    {/* Vitals not recorded → let the doctor/nurse add them (re-triages + regenerates). */}
                    {!hasVitals(vitals) && (
                      <div style={{ marginTop: 16, background: 'var(--bg)', borderRadius: 12, overflow: 'hidden' }}>
                        <button type="button" onClick={() => { setVitalsErr(''); setVitalsOpen(o => !o); }} aria-expanded={vitalsOpen}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', padding: 14, cursor: 'pointer' }}>
                          <span style={{ fontSize: 20, lineHeight: 1 }}>🩺</span>
                          <span style={{ flex: 1, textAlign: 'left' }}>
                            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--primary)' }}>Vitals not recorded — add them</span>
                            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>Patient skipped vitals · entering them updates triage &amp; the report</span>
                          </span>
                          <span style={{ color: 'var(--text-light)', fontSize: 12, transition: 'transform .15s', transform: vitalsOpen ? 'rotate(180deg)' : 'none' }}>▼</span>
                        </button>
                        {vitalsOpen && (
                          <div style={{ padding: '12px 14px 14px', borderTop: '1px solid #E0E0E0' }}>
                            <VitalsForm lang="en" loading={vitalsSaving} error={vitalsErr}
                              submitLabel="Save vitals" loadingLabel="Saving…" onSubmit={saveVitals} />
                          </div>
                        )}
                      </div>
                    )}

                    {tab === 'queue' && (
                      <div style={{ marginTop: 24, borderTop: '1px solid #E0E0E0', paddingTop: 16 }}>
                        {editing ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>Edit the report — your changes replace what's shown; the original AI version is kept for the record.</label>
                            <textarea className="input" value={editText}
                              onChange={e => setEditText(e.target.value)}
                              placeholder="Edit the report text…"
                              style={{ minHeight: 280, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button className="btn btn-outline" style={{ width: 'auto', minHeight: 'auto', padding: '8px 16px', fontSize: 13 }}
                                onClick={() => setEditing(false)} disabled={savingEdit}>Cancel</button>
                              <button className="btn btn-primary" style={{ width: 'auto', minHeight: 'auto', padding: '8px 16px', fontSize: 13 }}
                                onClick={saveReportEdit} disabled={savingEdit || !editText.trim()}>
                                {savingEdit ? 'Saving…' : 'Save report'}
                              </button>
                            </div>
                          </div>
                        ) : feedbackGiven?.id === selected?.id ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                              background: feedbackGiven.val === 'accurate' ? '#D5F5E3' : feedbackGiven.val === 'error' ? '#FADBD8' : '#FCF3CF',
                              color: feedbackGiven.val === 'accurate' ? '#1E8449' : feedbackGiven.val === 'error' ? '#C0392B' : '#B9770E',
                            }}>
                              {feedbackGiven.val === 'accurate' ? '✓ Marked as accurate — thank you'
                                : feedbackGiven.val === 'error' ? '⚠ Couldn’t save — please try again'
                                : '✓ Flagged as incorrect history — thank you'}
                            </span>
                            <button onClick={() => setFeedbackGiven(null)}
                              style={{ background: 'none', border: 'none', color: 'var(--text-light)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                              {feedbackGiven.val === 'error' ? 'Retry' : 'Change'}
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 12 }}>
                            <button className="btn btn-accent" style={{ flex: 1 }} onClick={() => handleFeedback('accurate')}>Report Accurate</button>
                            <button className="btn btn-outline" style={{ flex: 1, borderColor: 'var(--red)', color: 'var(--red)' }}
                              onClick={() => { setEditText(report?.doctor_correction || report?.report_md || ''); setShowOriginal(false); setEditing(true); }}>Incorrect History — Edit</button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  !loading && <p style={{ color: 'var(--text-light)' }}>No report generated yet for this patient.</p>
                )}
              </>
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

// Searchable drug dropdown: filters DRUG_LIST as you type, supports keyboard
// (↑/↓/Enter/Esc) and click selection, closes on click-away. Free text is still
// allowed (whatever is typed is the value) so doctors aren't limited to the list.
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
                padding: '7px 10px', fontSize: 13, cursor: 'pointer',
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
          padding: '7px 10px', fontSize: 12, color: 'var(--text-light)', marginTop: 2,
        }}>
          No match — "{value}" will be used as typed.
        </div>
      )}
    </div>
  );
}

function PrescriptionPanel({ session, doctor, onDispatched }) {
  const [items, setItems] = useState(() => [makeItem()]);
  const [allergies, setAllergies] = useState([]);          // doctor-added (patient_allergies table)
  const [intakeAllergens, setIntakeAllergens] = useState([]); // parsed from the patient's intake answer
  const [warnings, setWarnings] = useState([]);
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
  // (browser print → paper or Save as PDF). The same QR is embedded on the slip.
  function printPrescription() {
    if (!saved) return;
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const items = saved.items || [];
    const pname = esc(session?.patient_name || saved.prescription?.patient_name || 'Patient');
    const age = session?.patient_age ? `${session.patient_age}y ` : '';
    const gender = esc(session?.patient_gender || '');
    const phone = esc(session?.patient_phone || '');
    const issued = saved.issued_at ? new Date(saved.issued_at) : new Date();
    const date = issued.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = issued.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const rxId = esc(saved.prescription?.id || '');
    const docName = esc(doctor?.name || 'Doctor');
    const dept = esc(doctor?.department || '');
    const notes = saved.prescription?.notes ? esc(saved.prescription.notes) : '';
    const rows = items.map(it =>
      `<tr><td>${esc(it.drug_name)}</td><td>${esc(it.dose)}</td><td>${esc(it.frequency)}</td><td>${esc(it.duration)}</td><td>${esc(it.instructions)}</td></tr>`
    ).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Prescription ${rxId}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; }
  .hdr { border-bottom: 2px solid #1c5d8c; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: flex-start; }
  .doc h1 { margin: 0; font-size: 20px; color: #1c5d8c; }
  .doc p { margin: 2px 0; font-size: 12px; color: #555; }
  .hosp { text-align: right; font-size: 12px; color: #555; }
  .pt { display: flex; justify-content: space-between; margin: 16px 0; font-size: 13px; }
  .rx { font-size: 34px; color: #1c5d8c; font-weight: bold; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { color: #1c5d8c; }
  .notes { margin-top: 20px; font-size: 13px; border-top: 1px solid #e5e5e5; padding-top: 12px; }
  .notes .lbl { font-weight: bold; color: #1c5d8c; display: block; margin-bottom: 4px; }
  .foot { margin-top: 48px; display: flex; justify-content: space-between; align-items: flex-end; }
  .qr { text-align: center; font-size: 10px; color: #777; }
  .qr img { width: 110px; height: 110px; }
  .sign { text-align: center; font-size: 12px; }
  .sign .line { border-top: 1px solid #333; width: 200px; margin-bottom: 4px; }
  .disc { margin-top: 28px; font-size: 10px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 8px; }
</style></head>
<body onload="window.print()">
  <div class="hdr">
    <div class="doc"><h1>${docName}</h1><p>${dept} Department</p><p>Demo City Hospital</p></div>
    <div class="hosp">Date: ${date}<br>Time: ${time}<br>Rx ID: ${rxId}</div>
  </div>
  <div class="pt"><div><strong>${pname}</strong> &nbsp; ${age}${gender}</div><div>${phone ? 'Ph: ' + phone : ''}</div></div>
  <div class="rx">&#8478;</div>
  <table>
    <thead><tr><th>Medication</th><th>Dose</th><th>Frequency</th><th>Duration</th><th>Instructions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No medications</td></tr>'}</tbody>
  </table>
  ${notes ? `<div class="notes"><span class="lbl">Doctor's Advice &amp; Instructions</span>${notes}</div>` : ''}
  <div class="foot">
    <div class="qr">${qrUrl ? `<img src="${qrUrl}"/><br>Scan to verify digital Rx` : ''}</div>
    <div class="sign"><div class="line"></div>${docName}<br>Signature</div>
  </div>
  <div class="disc">Digitally generated via OPD Pre-Consultation system. Scan the QR code to verify authenticity.</div>
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
        // Patient-reported from questionnaire answer
        const patientMeds = reportJson?.answers?.q_medications;
        if (patientMeds && patientMeds.toLowerCase() !== 'none' && patientMeds.toLowerCase() !== 'nil') {
          // Try to parse comma-separated
          patientMeds.split(',').forEach(m => {
            const trimmed = m.trim();
            if (trimmed && !meds.some(existing => existing.drug_name.toLowerCase() === trimmed.toLowerCase())) {
              meds.push({ id: rxUid(), drug_name: trimmed, dose: '', frequency: '', source: 'patient', duration: '', instructions: '' });
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
    if (!validItems.length) return;

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
        <div style={{ background: '#FADBD8', border: '1px solid #E6B0AA', borderRadius: 8, padding: 10, fontSize: 13, color: '#943126' }}>
          <strong>⚠ Known allergies:</strong> {allergyList.join(', ')}
          <div style={{ fontSize: 11, color: '#B03A2E', marginTop: 2 }}>
            Drugs that clash with these are flagged below and blocked on save.
          </div>
        </div>
      ) : (
        <div style={{ background: '#EAFAF1', border: '1px solid #ABEBC6', borderRadius: 8, padding: 10, fontSize: 13, color: '#1E8449' }}>
          ✓ No known drug allergies reported.
        </div>
      )}

      {/* Current medications from session (OCR + patient-reported) */}
      {currentMeds.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, border: '1px solid #E0E0E0' }}>
          <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>Current Medications</h3>
          <p style={{ fontSize: 11, color: 'var(--text-light)', marginBottom: 8 }}>
            From patient intake (OCR and questionnaire). Edit, delete, or carry forward to prescription.
          </p>
          {currentMeds.map((med, idx) => (
            <div key={med.id || idx} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 140 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Drug</label>}
                <input className="input" value={med.drug_name}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], drug_name: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 13 }} />
                {med.brand && (
                  <div style={{ fontSize: 9, color: 'var(--text-light)', marginTop: 2 }}>written as: {med.brand}</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 60 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Dose</label>}
                <input className="input" value={med.dose}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], dose: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 13 }} placeholder="dose" />
              </div>
              <div style={{ width: 70 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Freq</label>}
                <select className="input" value={med.frequency}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], frequency: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 13 }}>
                  <option value="">-</option>
                  {FREQ_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: med.source === 'document' ? '#EBF5FB' : '#FEF9E7', color: 'var(--text-light)' }}>
                {med.source === 'document' ? 'OCR' : 'Patient'}
              </span>
              <button type="button" onClick={() => setCurrentMeds(currentMeds.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>✕</button>
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
            fontSize: 12, marginTop: 8,
          }}>
            {allCurrentAdded ? '✓ Added to prescription' : 'Continue all in prescription'}
          </button>
        </div>
      )}

      {/* Existing prescriptions from this session — click Reuse to load into the form */}
      {existingRx.length > 0 && (
        <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 10, fontSize: 12 }}>
          <strong>Previous Rx ({existingRx.length}):</strong>
          <p style={{ fontSize: 10, color: 'var(--text-light)', margin: '2px 0 6px' }}>
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
                    cursor: allAdded ? 'default' : 'pointer', fontSize: 11, whiteSpace: 'nowrap',
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
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>New Prescription</h3>

        {draftRestored && (
          <div style={{ background: '#FEF9E7', border: '1px solid #F4D03F', borderRadius: 8, padding: '8px 10px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#7D6608' }}>📝 Restored an unsaved prescription draft for this patient.</span>
            <button type="button" onClick={clearDraft}
              style={{ background: '#fff', border: '1px solid #F4D03F', color: '#7D6608', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>
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
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Drug</label>}
                <DrugCombobox value={item.drug_name}
                  onChange={v => updateItem(idx, 'drug_name', v)}
                  options={drugList}
                  placeholder="Drug name" style={{ minHeight: 34, fontSize: 13 }} />
              </div>
              <div style={{ flex: 1, minWidth: 70 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Dose</label>}
                <input className="input" value={item.dose}
                  onChange={e => updateItem(idx, 'dose', e.target.value)}
                  placeholder="e.g. 5mg"
                  style={{ minHeight: 34, fontSize: 13, ...(showItemErrors && String(item.drug_name || '').trim() && !String(item.dose || '').trim() ? { border: '1.5px solid var(--red)', background: '#FDEDEC' } : {}) }} />
              </div>
              <div style={{ width: 80 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Freq</label>}
                <select className="input" value={item.frequency}
                  onChange={e => updateItem(idx, 'frequency', e.target.value)}
                  style={{ minHeight: 34, fontSize: 13 }}>
                  {FREQ_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 70 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Duration</label>}
                <input className="input" value={item.duration}
                  onChange={e => updateItem(idx, 'duration', e.target.value)}
                  placeholder="e.g. 7 days"
                  style={{ minHeight: 34, fontSize: 13, ...(showItemErrors && String(item.drug_name || '').trim() && !String(item.duration || '').trim() ? { border: '1.5px solid var(--red)', background: '#FDEDEC' } : {}) }} />
              </div>
              <button type="button" onClick={() => removeItem(idx)}
                style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 18, minHeight: 34 }}>
                ✕
              </button>
            </div>
            {isAllergyHit && (
              <div style={{ fontSize: 11, color: '#C0392B', fontWeight: 700, marginTop: 3 }}>
                ⚠ allergy contraindication
              </div>
            )}
          </div>
          );
        })}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={addItem}
            style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}>
            + Add Drug
          </button>
          <button type="button" onClick={checkInteractions}
            style={{ background: '#fff', border: '1px solid var(--secondary)', color: 'var(--secondary)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}>
            Check Interactions
          </button>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{ borderRadius: 8, overflow: 'hidden' }}>
          {warnings.map((w, i) => {
            const ai = w.source === 'ai';
            const bg = ai ? '#EAF3FB' : (w.severity === 'block' ? '#FADBD8' : '#FFF3CD');
            const fg = ai ? '#1B4F72' : (w.severity === 'block' ? '#C0392B' : '#856404');
            const label = ai ? 'AI-ASSESSED · UNVERIFIED' : (w.severity === 'block' ? 'BLOCKED' : 'WARNING');
            return (
              <div key={i} style={{
                background: bg, padding: 10, fontSize: 13,
                borderBottom: '1px solid rgba(0,0,0,0.1)',
                borderLeft: ai ? '3px solid #2E86AB' : 'none',
              }}>
                <strong style={{ color: fg }}>
                  {label}{ai && w.severity === 'block' ? ' (severe)' : ''}:
                </strong>{' '}
                {w.description}
                {w.drug_a && w.drug_b && <span style={{ color: 'var(--text-light)' }}> ({w.drug_a} + {w.drug_b})</span>}
                {w.drug && w.allergy && <span style={{ color: 'var(--text-light)' }}> ({w.drug} / allergy: {w.allergy})</span>}
                {ai && typeof w.confidence === 'number' && (
                  <span style={{ color: 'var(--text-light)' }}> · confidence {Math.round(w.confidence * 100)}%</span>
                )}
              </div>
            );
          })}
          {warnings.some(w => w.source === 'ai') && (
            <div style={{ background: '#F4F8FB', padding: '7px 10px', fontSize: 11, color: 'var(--text-light)' }}>
              ⓘ AI-assessed items are for a drug not in the formulary — advisory only, do not block, and have been
              sent to the HIS admin for review. Verify against a clinical reference before relying on them.
            </div>
          )}
        </div>
      )}

      {/* No-interaction confirmation. Only fully reassuring once any unrecognised
          drugs have also had the AI advisory run; otherwise nudge to run it. */}
      {interactionChecked && warnings.length === 0 && (
        unknownDrugs.length > 0 && !aiChecked ? (
          <div style={{ background: '#FEF9E7', border: '1px solid #F4D03F', borderRadius: 8, padding: 10, fontSize: 13, color: '#7D6608' }}>
            No issues among known drugs. <strong>{unknownDrugs.join(', ')}</strong> {unknownDrugs.length > 1 ? 'are' : 'is'} not in the formulary —
            click <strong>Check Interactions</strong> for an AI allergy/interaction review.
          </div>
        ) : (
          <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 10, fontSize: 13, color: '#1E8449', fontWeight: 600 }}>
            ✓ No negative interactions found.
          </div>
        )
      )}

      {/* AI availability note */}
      {aiNote && (
        <div style={{ background: '#FEF9E7', borderRadius: 8, padding: 8, fontSize: 12, color: '#856404' }}>
          {aiNote}
        </div>
      )}

      {/* Consultation Scribe — record the visit; its patient-facing summary
          auto-fills the Doctor's Advice box just below. */}
      <ScribePanel session={session} embedded onAdvice={applyAdvice} />

      {/* Doctor's Advice & Instructions + Save */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>Patient summary <span style={{ fontWeight: 400, color: 'var(--text-light)' }}>(printed on the prescription)</span></label>
        <p style={{ fontSize: 11, color: 'var(--text-light)', margin: '2px 0 6px' }}>
          Auto-filled from the consultation scribe — plain-language guidance the patient sees on the printed &amp; digital Rx. Edit before saving.
        </p>
        <textarea className="input" rows={4} value={notes}
          onChange={e => { setNotes(e.target.value); persistDraft(items, e.target.value); }}
          placeholder="Record the consultation above to auto-fill this, or type the patient's instructions here. e.g. Drink plenty of fluids and rest. Get a blood test done. Come back in 5 days, or sooner if the fever worsens." />
      </div>

      <button className="btn btn-primary" onClick={handleSave} disabled={saving || !items.some(i => i.drug_name)}>
        {saving ? 'Saving...' : 'Save & Generate QR'}
      </button>
      {saveError && (
        <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', fontWeight: 600 }}>⚠ {saveError}</p>
      )}
      </>)}

      {/* QR Result */}
      {saved && (
        <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 16, textAlign: 'center' }}>
          <p style={{ fontWeight: 600, color: '#1E8449', marginBottom: 12 }}>✓ Prescription saved!</p>

          {/* Actual scannable QR code */}
          {qrUrl && (
            <div style={{ background: '#fff', display: 'inline-block', padding: 12, borderRadius: 8, marginBottom: 8 }}>
              <img src={qrUrl} alt="Prescription QR code" style={{ display: 'block', width: 220, height: 220 }} />
            </div>
          )}
          {qrError && (
            <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{qrError}</p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12 }}>
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

          {/* Human-readable summary of what the QR contains */}
          <div style={{ background: '#fff', borderRadius: 8, padding: 12, textAlign: 'left', marginBottom: 8 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)', marginBottom: 6 }}>
              {saved.prescription?.patient_name || session?.patient_name || 'Patient'} ·{' '}
              {new Date(saved.issued_at || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
            </p>
            {(saved.items || []).map((it, i) => (
              <p key={i} style={{ fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>
                • <strong>{it.drug_name}</strong>
                {it.dose ? ` ${it.dose}` : ''}{it.frequency ? ` — ${it.frequency}` : ''}
                {it.duration ? `, ${it.duration}` : ''}
                {it.instructions ? ` (${it.instructions})` : ''}
              </p>
            ))}
            {saved.prescription?.notes && (
              <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 6, fontStyle: 'italic' }}>
                Note: {saved.prescription.notes}
              </p>
            )}
          </div>

          {/* Raw payload tucked away for debugging / manual encoding */}
          <details style={{ textAlign: 'left' }}>
            <summary style={{ fontSize: 11, color: 'var(--text-light)', cursor: 'pointer' }}>
              Show raw signed payload
            </summary>
            <textarea className="input" readOnly value={saved.prescription?.qr_payload || ''}
              style={{ fontSize: 10, height: 60, fontFamily: 'monospace', marginTop: 6 }}
              onClick={e => e.target.select()} />
          </details>
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

  // Collapsible header used when embedded inside the Prescribe tab.
  if (embedded && !open) {
    return (
      <div style={{ border: '1px solid #E0E0E0', borderRadius: 12, padding: '10px 14px', marginBottom: 4 }}>
        <button type="button" onClick={() => setOpen(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: 0 }}>
          <span style={{ fontSize: 14 }}>🎙</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--primary)' }}>Consultation Scribe</span>
          <span style={{ fontSize: 11, color: 'var(--text-light)' }}>
            {advised || soapText ? '✓ note ready · summary below' : 'record → SOAP note + patient summary'}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-light)' }}>▸</span>
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16,
      ...(embedded ? { border: '1px solid #E0E0E0', borderRadius: 12, padding: 14, marginBottom: 4 } : {}) }}>
      {toastView}
      {embedded && (
        <button type="button" onClick={() => setOpen(false)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: 0 }}>
          <span style={{ fontSize: 14 }}>🎙</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--primary)' }}>Consultation Scribe</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-light)' }}>▾</span>
        </button>
      )}
      <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--text-light)' }}>
        Record the consultation — it becomes an editable SOAP note below, and a plain-language summary
        is added to <strong>Patient summary</strong> for the prescription. Audio is transcribed then
        discarded (zero-retention).
      </div>

      {/* Recording controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {!recording ? (
          <button className="btn btn-primary" onClick={startRecording} disabled={!!processing}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', padding: '0 20px' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', display: 'inline-block' }} />
            Start Recording
          </button>
        ) : (
          <button className="btn" onClick={stopRecording}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', padding: '0 20px', background: 'var(--red)', color: '#fff', border: 'none' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: '#fff', display: 'inline-block', animation: 'pulse 1s infinite' }} />
            Stop Recording
          </button>
        )}
        {processing && <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{processing}</span>}
      </div>

      {/* Editable SOAP note (doctor's clinical record — not shown to the patient) */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>SOAP Note <span style={{ fontWeight: 400, color: 'var(--text-light)' }}>(editable — your clinical record)</span></label>
        <textarea className="input" value={soapText}
          onChange={e => setSoapText(e.target.value)}
          onBlur={() => persistSoap(soapText)}
          rows={10}
          placeholder="Record the consultation to auto-generate the SOAP note here, or type it directly…"
          style={{ fontSize: 13, lineHeight: 1.6, marginTop: 4 }} />
        {embedded && advised && (
          <p style={{ fontSize: 11, color: '#1E8449', marginTop: 4 }}>
            ✓ A plain-language summary was added to <strong>Patient summary</strong> below — review/edit before saving.
          </p>
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
