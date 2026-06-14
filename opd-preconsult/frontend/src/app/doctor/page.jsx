'use client';
import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { api, setToken } from '../../lib/api';
import TriageBadge from '../../components/TriageBadge';
import ReactMarkdown from 'react-markdown';

const TRIAGE_COLORS = { RED: '#E74C3C', AMBER: '#F39C12', GREEN: '#27AE60' };
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
  const patients = [];
  for (const [phone, visits] of map) {
    visits.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
      triage: filledNow ? latest.triage_level : null,
    });
  }
  patients.sort((a, b) => {
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
  const [rightTab, setRightTab] = useState('report'); // report | prescribe | scribe
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
    setLoading(true);
    if (!s.assigned_doctor_id && tab === 'queue') {
      try { await api.doctorAssign(s.id); loadQueue(); } catch {}
    }
    try { setReport(await api.getReport(s.id)); } catch { setReport(null); }
    setLoading(false);
  }

  async function handleUnassign() {
    if (!selected) return;
    if (!confirm('Release this patient back to the unassigned pool?')) return;
    await api.doctorUnassign(selected.id);
    setSelected(null);
    setReport(null);
    loadQueue();
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
      alert('Delete failed: ' + (err.message || 'unknown error'));
    } finally {
      setDeleting(false);
    }
  }

  async function handleFeedback(val) {
    if (!selected) return;
    await api.submitFeedback(selected.id, val);
    alert('Feedback submitted');
  }

  function handleLogout() {
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
  const patients = groupByPatient(sessions).filter(p => p.filledNow || pinned[p.phone]);
  // Consulted: a flat list of INDIVIDUAL consulted visits (NOT grouped per
  // patient). Every form a patient filled and the doctor consulted is its own
  // entry — so a returning patient who fills the form again appears as a new,
  // separate row, with that visit's OWN triage colour (a past RED visit stays
  // red; a later YELLOW visit shows yellow, independently). Order is FIXED by
  // when each visit was first consulted (consulted_at, stamped once), newest
  // consult first, so re-opening a visit never reshuffles the list.
  const consultedList = [...consulted].sort((a, b) => {
    const ta = a.consulted_at || a.updated_at;
    const tb = b.consulted_at || b.updated_at;
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

  // "Waiting" = queue patients the doctor hasn't opened/consulted yet. Once a
  // patient's current visit is consulted (it has consulted_at / a doctor), they
  // still appear in the tree for reference but count as "seen", not "waiting".
  const isConsulted = p => !!(p.latest && (p.latest.consulted_at || p.latest.assigned_doctor_id));
  const waitingCount = patients.filter(p => !isConsulted(p)).length;
  const seenInQueueCount = patients.length - waitingCount;

  // "Consulted today" count.
  const todayStr = now.toDateString();
  const consultedTodayCount = consultedList.filter(s => {
    const t = s.consulted_at || s.updated_at;
    return t && new Date(t).toDateString() === todayStr;
  }).length;

  // Header date/time + time-of-day greeting.
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <div className="doctor-layout" style={{ display: 'flex', gap: 16, minHeight: '100vh' }}>
      {/* Left Panel */}
      <div style={{ width: 340, flexShrink: 0 }}>
        <style>{`@keyframes skpulse { 0%,100% { opacity:1 } 50% { opacity:.45 } }`}</style>
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

        {tab === 'queue' && (
          <button className="btn btn-outline" style={{ fontSize: 13, marginBottom: 8 }} onClick={loadQueue}>Refresh</button>
        )}

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
          {tab === 'queue' && ['RED', 'AMBER', 'GREEN'].some(l => triageCounts[l] > 0) && (
            <span style={{ display: 'inline-flex', gap: 9, fontSize: 12, flexShrink: 0 }}>
              {['RED', 'AMBER', 'GREEN'].filter(l => triageCounts[l] > 0).map(l => (
                <span key={l} title={l === 'RED' ? 'Emergency' : l === 'AMBER' ? 'Priority' : 'Routine'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: TRIAGE_COLORS[l], fontWeight: 700 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: TRIAGE_COLORS[l], display: 'inline-block' }} />
                  {triageCounts[l]}
                </span>
              ))}
            </span>
          )}
        </div>

        {tab === 'queue' && !queueLoaded && <SkeletonRows n={4} />}
        {tab === 'queue' && queueLoaded && filteredPatients.map(p => {
          const isOpen = !!expanded[p.phone]; // collapsed until clicked, so "NEW" shows first
          const headColor = p.triage ? TRIAGE_COLORS[p.triage] : null;
          return (
            <div key={p.phone} style={{ marginBottom: 8 }}>
              {/* Patient heading */}
              <div onClick={() => setExpanded(e => ({ ...e, [p.phone]: !isOpen }))}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: '#fff', borderLeft: `4px solid ${headColor || 'transparent'}`, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 700, fontSize: 14, color: headColor || 'var(--text)' }}>{p.name}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-light)' }}>{p.phone} · {p.visits.length} visit{p.visits.length > 1 ? 's' : ''}</p>
                </div>
                {/* Right indicator: a filled-now patient shows "NEW" until the
                    doctor opens them once (like an unread badge). After that it's
                    permanently a chevron — even when collapsed again — hinting the
                    previous consultations can be expanded. */}
                {(p.filledNow && !seenNew[p.latest.id]) ? (
                  <span style={{ fontSize: 9, background: headColor || '#888', color: '#fff', padding: '2px 6px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.3 }}>NEW</span>
                ) : (
                  <span style={{ fontSize: 14, color: 'var(--text-light)' }}>{isOpen ? '▾' : '▸'}</span>
                )}
              </div>
              {/* Visits (newest first) */}
              {isOpen && (
                <div style={{ marginLeft: 14, marginTop: 4, borderLeft: '1px solid #E0E0E0', paddingLeft: 10 }}>
                  {p.visits.map((v, vi) => {
                    const isFilledNow = vi === 0 && p.filledNow;
                    const isSel = selected?.id === v.id;
                    const meds = v.prescription_items || [];
                    return (
                      <div key={v.id} onClick={() => { markSeen(v.id); selectSession(v); }}
                        style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', marginBottom: 4,
                          background: isSel ? '#EAF2F8' : (isFilledNow ? '#FEF9E7' : 'transparent'),
                          border: isSel ? '2px solid var(--secondary)' : (isFilledNow ? `1px solid ${TRIAGE_COLORS[v.triage_level] || '#ccc'}` : '1px solid transparent') }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {v.triage_level && <TriageBadge level={v.triage_level} />}
                          <div style={{ flex: 1 }}>
                            <p style={{ fontSize: 12, fontWeight: 600 }}>
                              {isFilledNow ? '★ Filled now' : fmtVisitDate(v.created_at)}
                            </p>
                            {isFilledNow && <p style={{ fontSize: 10, color: 'var(--text-light)' }}>{fmtVisitDate(v.created_at)}</p>}
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
        {tab === 'queue' && queueLoaded && filteredPatients.length === 0 && (
          <p style={{ color: 'var(--text-light)', padding: 16, textAlign: 'center' }}>
            {q ? `No patients match “${search.trim()}”` : 'No patients yet'}
          </p>
        )}

        {tab === 'consulted' && !consultedLoaded && <SkeletonRows n={4} />}

        {/* CONSULTED tab → every consulted visit as its own individual entry,
            each with that visit's own triage colour, newest-consult first. */}
        {tab === 'consulted' && consultedLoaded && filteredConsulted.map(s => (
          <div key={s.id} className="queue-item" onClick={() => selectSession(s)}
            style={{ border: selected?.id === s.id ? '2px solid var(--secondary)' : 'none' }}>
            {s.triage_level && <TriageBadge level={s.triage_level} />}
            <div style={{ flex: 1 }}>
              <p style={{ fontWeight: 600, fontSize: 14 }}>{s.patient_name || 'Unregistered'}</p>
              <p style={{ fontSize: 11, color: 'var(--text-light)' }}>
                {s.patient_age ? `${s.patient_age}y` : ''} {s.patient_gender || ''}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-light)' }}>
                🕒 Consulted: {fmtVisitDate(s.consulted_at || s.updated_at)}
              </p>
              {s.doctor_feedback && (
                <span style={{ fontSize: 10, background: s.doctor_feedback === 'accurate' ? '#D5F5E3' : '#FADBD8',
                  color: s.doctor_feedback === 'accurate' ? '#1E8449' : '#C0392B', padding: '2px 6px', borderRadius: 4 }}>
                  {s.doctor_feedback === 'accurate' ? '✓ Accurate' : '✗ Inaccurate'}
                </span>
              )}
            </div>
          </div>
        ))}
        {tab === 'consulted' && consultedLoaded && filteredConsulted.length === 0 && (
          <p style={{ color: 'var(--text-light)', padding: 16, textAlign: 'center' }}>
            {q ? `No consulted entries match “${search.trim()}”` : 'No consulted patients yet'}
          </p>
        )}
      </div>

      {/* Right Panel */}
      <div style={{ flex: 1, background: 'var(--card-bg)', borderRadius: 16, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <TriageBadge level={selected.triage_level} />
              <h2 style={{ fontSize: 20 }}>{selected.patient_name}</h2>
              <span style={{ color: 'var(--text-light)', fontSize: 14 }}>
                {selected.patient_age ? `${selected.patient_age}y` : ''} {selected.patient_gender || ''} · {selected.department}
              </span>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center', position: 'relative' }}>
                {tab === 'queue' && selected.assigned_doctor_id && (
                  <>
                    <button onClick={handleUnassign}
                      style={{ background: 'none', border: '1px solid #E74C3C', color: '#E74C3C', borderRadius: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>
                      Release
                    </button>
                    {otherDoctors.length > 0 && (
                      <select onChange={e => { if (e.target.value) handleReassign(e.target.value); e.target.value = ''; }}
                        style={{ border: '1px solid #ccc', borderRadius: 8, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>
                        <option value="">Reassign to...</option>
                        {otherDoctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    )}
                  </>
                )}

                {/* Discrete kebab (⋯) menu — holds destructive actions out of the way */}
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
                onClick={() => setRightTab('prescribe')}>Prescribe</button>
              <button className={`btn ${rightTab === 'scribe' ? 'btn-primary' : 'btn-outline'}`}
                style={{ fontSize: 13, minHeight: 32, width: 'auto', padding: '0 16px' }}
                onClick={() => setRightTab('scribe')}>Scribe</button>
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
                    <div style={{ lineHeight: 1.8, fontSize: 15 }}>
                      <ReactMarkdown>{report.report_md}</ReactMarkdown>
                    </div>
                    {tab === 'queue' && (
                      <div style={{ display: 'flex', gap: 12, marginTop: 24, borderTop: '1px solid #E0E0E0', paddingTop: 16 }}>
                        <button className="btn btn-accent" style={{ flex: 1 }} onClick={() => handleFeedback('accurate')}>Report Accurate</button>
                        <button className="btn btn-outline" style={{ flex: 1, borderColor: 'var(--red)', color: 'var(--red)' }}
                          onClick={() => handleFeedback('inaccurate')}>Incorrect History</button>
                      </div>
                    )}
                  </>
                ) : (
                  !loading && <p style={{ color: 'var(--text-light)' }}>No report generated yet for this patient.</p>
                )}
              </>
            )}

            {rightTab === 'prescribe' && (
              <PrescriptionPanel session={selected} doctor={doctor} />
            )}

            {rightTab === 'scribe' && (
              <ScribePanel session={selected} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

const DRUG_LIST = [
  "warfarin","acenocoumarol","rivaroxaban","apixaban","heparin",
  "metoprolol","atenolol","propranolol","carvedilol","bisoprolol",
  "amlodipine","nifedipine","diltiazem","verapamil",
  "enalapril","ramipril","lisinopril","telmisartan","losartan","olmesartan",
  "furosemide","torsemide","spironolactone","hydrochlorothiazide",
  "aspirin","clopidogrel","ticagrelor","prasugrel",
  "atorvastatin","rosuvastatin","simvastatin",
  "metformin","glipizide","glimepiride","sitagliptin","vildagliptin",
  "empagliflozin","dapagliflozin","canagliflozin","insulin","pioglitazone",
  "digoxin","amiodarone","ivabradine","nitroglycerin","isosorbide",
  "pantoprazole","omeprazole","rabeprazole",
  "paracetamol","ibuprofen","diclofenac",
  "levothyroxine","carbimazole",
  "prednisolone","dexamethasone","methylprednisolone",
  "azithromycin","amoxicillin","ciprofloxacin","ceftriaxone",
  "montelukast","salbutamol","budesonide",
];

const FREQ_OPTIONS = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'Weekly'];

function PrescriptionPanel({ session, doctor }) {
  const [items, setItems] = useState([{ drug_name: '', dose: '', frequency: 'OD', duration: '', instructions: '' }]);
  const [allergies, setAllergies] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [interactionChecked, setInteractionChecked] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  const EMPTY_ITEM = { drug_name: '', dose: '', frequency: 'OD', duration: '', instructions: '' };
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
    setItems([{ ...EMPTY_ITEM }]);
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
    if (!w) { alert('Please allow pop-ups to print the prescription.'); return; }
    w.document.write(html);
    w.document.close();
  }

  useEffect(() => {
    if (session?.patient_phone) {
      api.getAllergies(session.patient_phone).then(setAllergies).catch(() => {});
    }
    if (session?.id) {
      api.getPrescriptions(session.id).then(setExistingRx).catch(() => {});
      // Load current medications from session report (OCR-extracted + patient-reported)
      api.getReport(session.id).then(report => {
        const meds = [];
        const reportJson = report?.report_json;
        if (reportJson?.medications_from_documents) {
          reportJson.medications_from_documents.forEach(m => {
            meds.push({ drug_name: m.name || '', dose: m.dose || '', frequency: m.frequency || '', source: 'document', duration: '', instructions: '' });
          });
        }
        // Patient-reported from questionnaire answer
        const patientMeds = reportJson?.answers?.q_medications;
        if (patientMeds && patientMeds.toLowerCase() !== 'none' && patientMeds.toLowerCase() !== 'nil') {
          // Try to parse comma-separated
          patientMeds.split(',').forEach(m => {
            const trimmed = m.trim();
            if (trimmed && !meds.some(existing => existing.drug_name.toLowerCase() === trimmed.toLowerCase())) {
              meds.push({ drug_name: trimmed, dose: '', frequency: '', source: 'patient', duration: '', instructions: '' });
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
        setItems(draft.items?.length ? draft.items : [{ ...EMPTY_ITEM }]);
        setNotes(draft.notes || '');
        restored = !!(draft.items?.some(i => i.drug_name?.trim()) || (draft.notes || '').trim());
      } else {
        setItems([{ ...EMPTY_ITEM }]);
        setNotes('');
      }
    } catch {
      setItems([{ ...EMPTY_ITEM }]);
      setNotes('');
    }
    setDraftRestored(restored);
  }, [session?.id]);

  function addItem() {
    const updated = [...items, { ...EMPTY_ITEM }];
    setItems(updated);
    persistDraft(updated, notes);
  }

  function removeItem(idx) {
    const updated = items.filter((_, i) => i !== idx);
    setItems(updated);
    setInteractionChecked(false);
    persistDraft(updated, notes);
  }

  function updateItem(idx, field, val) {
    const updated = [...items];
    updated[idx] = { ...updated[idx], [field]: val };
    setItems(updated);
    if (field === 'drug_name') setInteractionChecked(false);
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
      .map(it => ({
        drug_name: it.drug_name, dose: it.dose || '', frequency: it.frequency || 'OD',
        duration: it.duration || '', instructions: it.instructions || '',
      }));
    if (!toAdd.length) return;
    const updated = [...existing, ...toAdd, { ...EMPTY_ITEM }];
    setItems(updated);
    persistDraft(updated, notes);
    setInteractionChecked(false);
  }

  async function checkInteractions() {
    const drugs = items.map(i => i.drug_name).filter(Boolean);
    const allergenList = allergies.map(a => a.allergen);
    if (drugs.length === 0) return;

    try {
      const result = await api.checkBulkInteractions({ drugs, patient_allergies: allergenList });
      setWarnings(result.warnings || []);
      setInteractionChecked(true);
    } catch {
      setWarnings([]);
      setInteractionChecked(false);
    }
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

    // Check for blocks
    const blocks = warnings.filter(w => w.severity === 'block');
    if (blocks.length > 0) {
      if (!confirm(`There are ${blocks.length} BLOCKED interaction(s). Proceed anyway?`)) return;
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
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  // Which current meds are already in the New Prescription (case-insensitive),
  // used to dedupe "Continue all" and to disable it once everything is added.
  const rxDrugNames = new Set(items.filter(i => i.drug_name).map(i => i.drug_name.trim().toLowerCase()));
  const namedCurrentMeds = currentMeds.filter(m => m.drug_name);
  const allCurrentAdded = namedCurrentMeds.length > 0 && namedCurrentMeds.every(m => rxDrugNames.has(m.drug_name.trim().toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Allergies */}
      {allergies.length > 0 && (
        <div style={{ background: '#FADBD8', borderRadius: 8, padding: 10, fontSize: 13 }}>
          <strong>Known Allergies:</strong> {allergies.map(a => a.allergen).join(', ')}
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
            <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 140 }}>
                {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Drug</label>}
                <input className="input" value={med.drug_name}
                  onChange={e => { const u = [...currentMeds]; u[idx] = { ...u[idx], drug_name: e.target.value }; setCurrentMeds(u); }}
                  style={{ minHeight: 32, fontSize: 13 }} />
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
              .map(m => ({ drug_name: m.drug_name, dose: m.dose, frequency: m.frequency || 'OD', duration: '', instructions: '' }));
            if (!toAdd.length) return;
            const updated = [...existing, ...toAdd, { ...EMPTY_ITEM }];
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

        {items.map((item, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 2, minWidth: 150 }}>
              {idx === 0 && <label style={{ fontSize: 10, color: 'var(--text-light)' }}>Drug</label>}
              <input className="input" list="drug-list" value={item.drug_name}
                onChange={e => updateItem(idx, 'drug_name', e.target.value)}
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
        ))}

        <datalist id="drug-list">
          {DRUG_LIST.map(d => <option key={d} value={d.charAt(0).toUpperCase() + d.slice(1)} />)}
        </datalist>

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
          {warnings.map((w, i) => (
            <div key={i} style={{
              background: w.severity === 'block' ? '#FADBD8' : '#FFF3CD',
              padding: 10, fontSize: 13, borderBottom: '1px solid rgba(0,0,0,0.1)'
            }}>
              <strong style={{ color: w.severity === 'block' ? '#C0392B' : '#856404' }}>
                {w.severity === 'block' ? 'BLOCKED' : 'WARNING'}:
              </strong>{' '}
              {w.description}
              {w.drug_a && w.drug_b && <span style={{ color: 'var(--text-light)' }}> ({w.drug_a} + {w.drug_b})</span>}
              {w.drug && w.allergy && <span style={{ color: 'var(--text-light)' }}> ({w.drug} / allergy: {w.allergy})</span>}
            </div>
          ))}
        </div>
      )}

      {/* No-interaction confirmation */}
      {interactionChecked && warnings.length === 0 && (
        <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 10, fontSize: 13, color: '#1E8449', fontWeight: 600 }}>
          ✓ No negative interactions found.
        </div>
      )}

      {/* Doctor's Advice & Instructions + Save */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>Doctor's Advice &amp; Instructions</label>
        <p style={{ fontSize: 11, color: 'var(--text-light)', margin: '2px 0 6px' }}>
          Clinical guidance for the patient — printed on the prescription and shown in the digital Rx.
        </p>
        <textarea className="input" rows={4} value={notes}
          onChange={e => { setNotes(e.target.value); persistDraft(items, e.target.value); }}
          placeholder="e.g. Complete the full antibiotic course. Avoid driving while on this medication. Return immediately if chest pain or breathlessness recurs." />
      </div>

      <button className="btn btn-primary" onClick={handleSave} disabled={saving || !items.some(i => i.drug_name)}>
        {saving ? 'Saving...' : 'Save & Generate QR'}
      </button>
      {saveError && (
        <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', fontWeight: 600 }}>⚠ {saveError}</p>
      )}

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
            style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            🖨 Print / Save PDF
          </button>

          {/* Human-readable summary of what the QR contains */}
          <div style={{ background: '#fff', borderRadius: 8, padding: 12, textAlign: 'left', marginBottom: 8 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)', marginBottom: 6 }}>
              {saved.prescription?.patient_name || session?.patient_name || 'Patient'} ·{' '}
              {new Date().toISOString().slice(0, 10)}
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

function ScribePanel({ session }) {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [soap, setSoap] = useState(null);
  const [processing, setProcessing] = useState('');
  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);

  useEffect(() => {
    // Load existing SOAP if available
    if (session?.id) {
      api.getSOAP(session.id).then(data => {
        setTranscript(data.transcript || '');
        setSoap(data.soap || null);
      }).catch(() => {});
    }
    return () => { if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop(); };
  }, [session?.id]);

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
      alert('Microphone access denied: ' + err.message);
    }
  }

  async function stopRecording() {
    if (!mediaRecorder.current) return;

    return new Promise(resolve => {
      mediaRecorder.current.onstop = async () => {
        const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
        mediaRecorder.current.stream.getTracks().forEach(t => t.stop());
        mediaRecorder.current = null;
        setRecording(false);

        // Transcribe
        setProcessing('Transcribing audio...');
        try {
          const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
          const result = await api.transcribeAudio(file, session?.id);
          setTranscript(result.transcript || '');
          setProcessing('');
        } catch (err) {
          setProcessing('');
          alert('Transcription failed: ' + err.message);
        }
        resolve();
      };
      mediaRecorder.current.stop();
    });
  }

  async function extractSOAP() {
    if (!transcript) return;
    setProcessing('Extracting SOAP notes...');
    try {
      const result = await api.extractSOAP({ transcript, session_id: session?.id });
      setSoap(result.soap);
    } catch (err) {
      alert('SOAP extraction failed: ' + err.message);
    }
    setProcessing('');
  }

  function renderSOAPSection(title, data) {
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) return null;
    return (
      <div style={{ marginBottom: 12 }}>
        <h4 style={{ fontSize: 14, color: 'var(--primary)', marginBottom: 4, borderBottom: '1px solid #E0E0E0', paddingBottom: 4 }}>{title}</h4>
        {typeof data === 'string' ? (
          <p style={{ fontSize: 13 }}>{data}</p>
        ) : Array.isArray(data) ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {data.map((item, i) => <li key={i} style={{ fontSize: 13 }}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}
          </ul>
        ) : (
          Object.entries(data).filter(([_, v]) => v && v !== 'not discussed' && v !== 'Not discussed').map(([key, val]) => (
            <div key={key} style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-light)', textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}: </span>
              {Array.isArray(val) ? (
                <span style={{ fontSize: 13 }}>{val.join(', ')}</span>
              ) : typeof val === 'object' ? (
                <span style={{ fontSize: 13 }}>{JSON.stringify(val)}</span>
              ) : (
                <span style={{ fontSize: 13 }}>{val}</span>
              )}
            </div>
          ))
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12, fontSize: 12, color: 'var(--text-light)' }}>
        Record the consultation. Audio is transcribed and discarded (zero-retention). The transcript is processed into SOAP notes.
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

      {/* Transcript */}
      {transcript && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ fontSize: 15, color: 'var(--primary)' }}>Transcript</h3>
            <button className="btn btn-outline" onClick={extractSOAP} disabled={!!processing}
              style={{ fontSize: 12, minHeight: 28, width: 'auto', padding: '0 12px', marginLeft: 'auto' }}>
              Extract SOAP Notes
            </button>
          </div>
          <textarea className="input" value={transcript}
            onChange={e => setTranscript(e.target.value)}
            rows={8} style={{ fontSize: 13, lineHeight: 1.6 }} />
        </div>
      )}

      {/* SOAP Notes */}
      {soap && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, border: '1px solid #E0E0E0' }}>
          <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>SOAP Notes</h3>
          {renderSOAPSection('Subjective', soap.subjective)}
          {renderSOAPSection('Objective', soap.objective)}
          {renderSOAPSection('Assessment', soap.assessment)}
          {renderSOAPSection('Plan', soap.plan)}
          {soap._note && (
            <p style={{ fontSize: 11, color: 'var(--text-light)', fontStyle: 'italic', marginTop: 8 }}>{soap._note}</p>
          )}
        </div>
      )}
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
