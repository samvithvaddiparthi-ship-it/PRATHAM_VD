'use client';
import { useState, useEffect, useRef, useId } from 'react';
import { api, setToken } from '../../lib/api';
import { formatPhoneDisplay } from '../../lib/phone';
import PasswordInput from '../../components/PasswordInput';
import TriageBadge from '../../components/TriageBadge';
import RxDocument from '../../components/RxDocument';
import QRCode from 'qrcode';
import ReactMarkdown from 'react-markdown';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useDialogA11y } from '../../components/ui/useDialogA11y';
import Modal from '../../components/ui/Modal';

// Registration date+time for a session, e.g. "19 Jun, 2:45 PM".
function fmtDateTime(ts) {
  if (!ts) return '';
  try {
    // Keep the time and am/pm together (non-breaking space) so "12:15 am" never
    // splits across two lines in a narrow cell.
    return new Date(ts).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }).replace(/(\d)\s*([AaPp][Mm])\b/, '$1 $2');
  } catch { return ''; }
}

// Display status for the HIS State column. Keyed by the backend-derived
// `display_state` (the single source of truth — see /all-sessions). Uses the
// dashboard-wide lifecycle vocabulary: Registered → (Interview/Vitals) → Ready →
// Started → Completed. A visit released from Completed back to the queue has
// dispatched_at/consulted_at cleared, so the backend derives READY again.
const STATE_META = {
  REGISTERED: { label: 'Registered', bg: '#F1F3F5', fg: 'var(--text)' },
  INTERVIEW:  { label: 'In Interview', bg: '#D6EAF8', fg: '#1B4F72' },
  VITALS:     { label: 'Vitals', bg: '#FDEBD0', fg: '#9C640C' },
  READY:      { label: 'Ready', bg: '#FCF3CF', fg: '#7D6608' },
  STARTED:    { label: 'Started', bg: '#D6EAF8', fg: '#1B4F72' },
  COMPLETED:  { label: 'Completed', bg: '#D5F5E3', fg: '#1E8449' },
};
function stateMeta(displayState) {
  return STATE_META[displayState] || { label: displayState || '—', bg: '#F1F3F5', fg: 'var(--text)' };
}

// Consultation duration = doctor lock (consulted_at) → Save & Generate QR
// (dispatched_at). Returns a compact "1h 5m" / "12m 30s" / "45s", or null when
// the consultation hasn't both started and finished.
function consultDuration(s) {
  if (!s.consulted_at || !s.dispatched_at) return null;
  const ms = new Date(s.dispatched_at) - new Date(s.consulted_at);
  if (!(ms > 0)) return null;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Admin login gate — the HIS dashboard mounts only after a valid admin passcode
// issues an admin-role token. Keeps the dashboard (and the admin-only endpoints
// it calls) behind authentication.
export default function HISPage() {
  const [authed, setAuthed] = useState(false);
  const [ready, setReady] = useState(false);
  // Restore a prior admin session on refresh. The token lives in sessionStorage
  // (tab-scoped), mirroring the doctor page — without this, every reload dropped
  // the in-memory token and forced a fresh passcode login.
  //
  // The restored token is VERIFIED before the dashboard is shown. A token that has
  // simply expired (they last 24h) would otherwise leave every tab 401ing on its
  // own — the patient list rendering "0 patients" and analytics "Failed to load",
  // which reads as data loss rather than an expired login. Failing back to the
  // passcode screen is both truthful and actionable.
  useEffect(() => {
    let cancelled = false;
    const saved = sessionStorage.getItem('admin_token');
    if (!saved) { setReady(true); return; }
    setToken(saved);
    api.getAdminSettings()
      .then(() => { if (!cancelled) { setAuthed(true); setReady(true); } })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 401 || err.status === 403) {
          try { sessionStorage.removeItem('admin_token'); } catch {}
          setToken(null);
          setAuthed(false);           // straight back to the passcode form
        } else {
          setAuthed(true);            // transient/network issue — keep the session
        }
        setReady(true);
      });
    return () => { cancelled = true; };
  }, []);
  if (!ready) return null;   // avoid a flash of the login form before restore runs
  if (!authed) return <AdminLogin onSuccess={() => setAuthed(true)} />;
  return <HISDashboard />;
}

function AdminLogin({ onSuccess }) {
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.adminLogin(passcode, name.trim());
      setToken(token);
      try { sessionStorage.setItem('admin_token', token); } catch {}
      onSuccess();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', width: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)',
    }}>
      <form onSubmit={submit} style={{
        width: '100%', maxWidth: 400, background: 'var(--card-bg)', borderRadius: 16,
        padding: 36, boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <h2 style={{ textAlign: 'center', margin: 0 }}>HIS Admin</h2>
        <p style={{ color: 'var(--text-light)', fontSize: 'calc(14px * var(--fs))', textAlign: 'center', margin: 0 }}>
          Enter your name and the admin passcode to continue.
        </p>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          maxLength={80}
        />
        <PasswordInput
          className="input"
          value={passcode}
          onChange={e => setPasscode(e.target.value)}
          placeholder="Admin passcode"
        />
        {error && <div style={{ color: 'var(--red)', fontSize: 'calc(14px * var(--fs))', textAlign: 'center' }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading || !passcode || name.trim().length < 2}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function HISDashboard() {
  const [tab, setTab] = useState('sessions');
  // When a ticket points at a department, jump to Questionnaires pre-selected there.
  const [questionsDept, setQuestionsDept] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [depts, setDepts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [docs, setDocs] = useState([]);                    // patient-uploaded documents
  const [rxList, setRxList] = useState([]);                // doctor-generated prescriptions
  const [rxTemplate, setRxTemplate] = useState(null);      // hospital prescription template
  const [detailTab, setDetailTab] = useState('report');    // right panel: report | prescription | documents
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ department: '', doctor_id: '', triage: '', state: '' });
  const [showFilters, setShowFilters] = useState(false);   // filter popover open?
  const [search, setSearch] = useState('');                // name / phone search
  const [exactMatch, setExactMatch] = useState(false);     // Enter commits an EXACT name/phone match (not substring)
  const [refreshing, setRefreshing] = useState(false);     // brief spin on the header refresh
  const [refreshKey, setRefreshKey] = useState(0);         // bumped to remount the active tab
  const { toast, toastView } = useToast();
  // Monotonic request id — only the most recently issued all-sessions response
  // is allowed to update state, so a slow/older request (or an overlapping poll)
  // can never paint stale rows over a freshly-filtered list.
  const loadSeq = useRef(0);

  // Static lists only need to load once.
  useEffect(() => {
    loadDoctors();
    loadDepts();
    api.getRxTemplate().then(setRxTemplate).catch(() => setRxTemplate({}));
  }, []);

  async function loadDoctors() {
    try { setDoctors(await api.listDoctors()); } catch {}
  }

  async function loadDepts() {
    try { setDepts(await api.getDepartments()); } catch {}
  }

  // Load the patient list AND set up the 15s auto-refresh inside the SAME effect
  // that depends on `filters`. This recreates the interval whenever the filters
  // change, so the polling closure always reads the CURRENT filters. Previously
  // the interval was created once on mount and kept a stale `loadData` closure
  // bound to the initial (empty) filters — so every 15s it silently reverted the
  // filtered view back to "all/unassigned". (The "glitch" you saw.)
  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [filters]);

  async function loadData() {
    const seq = ++loadSeq.current;
    try {
      const params = {};
      if (filters.department) params.department = filters.department;
      if (filters.doctor_id) params.doctor_id = filters.doctor_id;
      if (filters.triage) params.triage = filters.triage;
      if (filters.state) params.state = filters.state;
      const rows = await api.allSessions(params);
      // Drop the result if a newer request has been issued since.
      if (seq === loadSeq.current) setSessions(rows);
    } catch {}
  }

  // Global refresh — reloads the active view's data. Spins only for the actual
  // fetch (no artificial delay). Reloads the parent-owned lists (Patients + the
  // shared dept/doctor lists) and remounts the active sub-tab so it re-fetches.
  async function refreshActive() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([loadData(), loadDepts(), loadDoctors()]);
      setRefreshKey(k => k + 1);
    } finally {
      setRefreshing(false);
    }
  }

  async function selectSession(s) {
    setSelected(s);
    setReport(null);
    setDocs([]);
    setRxList([]);
    setDetailTab('report');
    setLoading(true);
    try { setReport(await api.getReport(s.id)); } catch { setReport(null); }
    setLoading(false);
    // Uploaded documents + doctor prescriptions load alongside (non-blocking).
    api.getDocuments(s.id).then(d => setDocs(Array.isArray(d) ? d : [])).catch(() => setDocs([]));
    api.getPrescriptions(s.id).then(r => setRxList(Array.isArray(r) ? r : [])).catch(() => setRxList([]));
  }

  async function handleReassign(sessionId, targetDoctorId) {
    if (!targetDoctorId) return;
    try {
      await api.doctorReassign(sessionId, targetDoctorId);
      loadData();
      if (selected?.id === sessionId) {
        const updated = sessions.find(s => s.id === sessionId);
        if (updated) setSelected({ ...updated, assigned_doctor_id: targetDoctorId });
      }
    } catch (err) {
      toast('Reassign failed: ' + err.message, 'error');
    }
  }

  async function handleUnassign(sessionId) {
    // Unassign = reassign with a null target (backend clears the doctor). Must go
    // through the authed API client — the reassign route is clinician-only, so a
    // bare fetch() without the admin token 401s.
    try {
      await api.doctorReassign(sessionId, null);
      loadData();
    } catch (err) {
      toast('Unassign failed: ' + err.message, 'error');
    }
  }

  // Client-side name/phone search over the (already filtered) sessions. Substring
  // by default; pressing Enter narrows to an EXACT name/phone match (so "d" shows
  // only the patient literally named "d", not everyone whose name contains a d).
  const q = search.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter(s => {
        const name = (s.patient_name || '').toLowerCase();
        const phone = (s.patient_phone || '').toLowerCase();
        return exactMatch ? (name === q || phone === q) : (name.includes(q) || phone.includes(q));
      })
    : sessions;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: 16, minHeight: '100vh' }}>
      {toastView}
      <style>{`@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }`}</style>
      {/* Header — title on the left; Refresh + Settings (gear) grouped top-right. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 'calc(20px * var(--fs))', color: 'var(--primary)' }}>🏥 HIS Dashboard</h1>
        <span style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>Hospital Information System</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Global refresh — reloads whichever tab is active; spins briefly on click. */}
          <button onClick={refreshActive} disabled={refreshing}
            title="Refresh" aria-label="Refresh"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 36, padding: '0 14px', borderRadius: 18, border: '1px solid #d5dce4', background: '#fff', color: 'var(--secondary)', cursor: refreshing ? 'default' : 'pointer', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, lineHeight: 1, opacity: refreshing ? 0.7 : 1 }}>
            <span style={{ display: 'inline-block', fontSize: 'calc(15px * var(--fs))', animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
          {/* Settings — a gear (not a main tab). Highlighted ring when its panel is open. */}
          <button onClick={() => setTab(tab === 'settings' ? 'sessions' : 'settings')}
            title="Settings" aria-label="Settings" aria-pressed={tab === 'settings'}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 18, cursor: 'pointer', fontSize: 'calc(17px * var(--fs))', lineHeight: 1,
              border: tab === 'settings' ? '2px solid var(--primary)' : '1px solid #d5dce4',
              background: tab === 'settings' ? '#eef3f8' : '#fff' }}>
            ⚙️
          </button>
        </div>
      </div>
      {/* Tab bar — equal-width segments spanning the full row edge to edge. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          ['sessions', 'Patients'], ['analytics', 'Analytics'], ['departments', 'Departments'],
          ['doctors', 'Doctors'], ['questions', 'Questionnaires'], ['protocols', 'Protocols'],
          ['tickets', 'Tickets'], ['formulary', 'Drug Formulary'], ['rxtemplate', 'Rx Template'],
        ].map(([id, label]) => (
          <button key={id}
            className={`btn ${tab === id ? 'btn-primary' : 'btn-outline'}`}
            style={{ flex: '1 1 0', minWidth: 0, fontSize: 'calc(13px * var(--fs))', minHeight: 38, padding: '0 8px', whiteSpace: 'nowrap' }}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'settings' ? (
        <SettingsManager key={refreshKey} />
      ) : tab === 'rxtemplate' ? (
        <RxTemplateManager key={refreshKey} />
      ) : tab === 'formulary' ? (
        <FormularyManager key={refreshKey} />
      ) : tab === 'doctors' ? (
        <DoctorInfo doctors={doctors} depts={depts} onChange={loadDoctors} />
      ) : tab === 'questions' ? (
        <QuestionsManager key={refreshKey} depts={depts} initialDept={questionsDept} />
      ) : tab === 'tickets' ? (
        <TicketsManager onOpenQuestionnaire={(d) => { setQuestionsDept(d || null); setTab('questions'); }} />
      ) : tab === 'departments' ? (
        <DepartmentsManager depts={depts} onChange={loadDepts} />
      ) : tab === 'protocols' ? (
        <ProtocolsManager key={refreshKey} depts={depts} />
      ) : tab === 'analytics' ? (
        <AnalyticsDashboard key={refreshKey} />
      ) : (<>

      {/* Filters — a single "Filter" button opens a popover holding every filter
          (Department, Doctor, Triage, State) with a Clear button at the bottom.
          The Doctor list is scoped to the chosen Department so they can't
          contradict; changing department drops an out-of-dept doctor. */}
      {(() => {
        const fieldLabel = { fontSize: 'calc(11px * var(--fs))', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 6, display: 'block' };
        const selectStyle = { width: '100%', height: 40 };
        const activeCount = [filters.department, filters.doctor_id, filters.triage, filters.state].filter(Boolean).length;
        const doctorOptions = doctors.filter(d => !filters.department || d.department === filters.department);

        const onDeptChange = (code) => setFilters(f => {
          const next = { ...f, department: code };
          if (code && f.doctor_id) {
            const doc = doctors.find(d => d.id === f.doctor_id);
            if (doc && doc.department !== code) next.doctor_id = '';
          }
          return next;
        });

        const XIcon = ({ size = 14 }) => (
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" style={{ display: 'block' }}>
            <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        );

        // ── Ghost prediction: the best name that STARTS WITH the query; its
        // tail is shown as greyed inline text and accepted with Tab / →. ──
        const sq = search.trim().toLowerCase();
        const names = [...new Set(sessions.map(s => s.patient_name).filter(Boolean))];
        const ghost = sq ? (names.find(n => n.toLowerCase().startsWith(sq)) || '') : '';
        const ghostTail = ghost && ghost.toLowerCase() !== sq ? ghost.slice(search.length) : '';
        // Suggestion list (name or phone match), de-duped by name, max 6.
        const seen = new Set();
        const suggestions = sq ? sessions.filter(s => {
          const hit = (s.patient_name || '').toLowerCase().includes(sq) || (s.patient_phone || '').toLowerCase().includes(sq);
          if (!hit) return false;
          const key = (s.patient_name || '') + '|' + (s.patient_phone || '');
          if (seen.has(key)) return false; seen.add(key); return true;
        }).slice(0, 6) : [];

        const acceptGhost = () => { if (ghostTail) setSearch(ghost); };

        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            {/* Patient search with inline ghost-text prediction + suggestions */}
            <div style={{ position: 'relative', width: 300 }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-light)', pointerEvents: 'none', display: 'flex' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              {/* ghost overlay — mirrors typed text (transparent) then grey tail.
                  It must share the input's box model exactly (border-box + a
                  transparent 1px border + matching line-height) or the grey tail
                  sits a pixel off the typed text. */}
              {ghostTail && (
                <div aria-hidden style={{ position: 'absolute', inset: 0, boxSizing: 'border-box',
                  border: '1px solid transparent', paddingLeft: 36, paddingRight: 12,
                  fontSize: 'calc(14px * var(--fs))', lineHeight: '38px', whiteSpace: 'pre', pointerEvents: 'none', overflow: 'hidden' }}>
                  <span style={{ color: 'transparent' }}>{search}</span>
                  <span style={{ color: 'var(--text-light)' }}>{ghostTail}</span>
                </div>
              )}
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); setExactMatch(false); }}
                onKeyDown={e => {
                  if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostTail) { e.preventDefault(); acceptGhost(); }
                  if (e.key === 'Enter') { e.preventDefault(); setExactMatch(true); }   // commit an exact match
                  if (e.key === 'Escape') { setSearch(''); setExactMatch(false); }
                }}
                placeholder="Search patient name or phone…"
                style={{ width: '100%', height: 40, boxSizing: 'border-box', paddingLeft: 36, paddingRight: search ? 32 : 12,
                  border: '1px solid #CBD5E0', borderRadius: 10, fontSize: 'calc(14px * var(--fs))', lineHeight: '38px', background: 'transparent',
                  outline: 'none', position: 'relative' }}
              />
              {search && (
                <button onClick={() => { setSearch(''); setExactMatch(false); }} title="Clear search"
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)', display: 'flex', padding: 4 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                  </svg>
                </button>
              )}
              {suggestions.length > 0 && (
                <div style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 41, background: '#fff',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', border: '1px solid #E2E8F0', overflow: 'hidden' }}>
                  {suggestions.map(s => (
                    <button key={s.id} onClick={() => { setSearch(s.patient_name || s.patient_phone || ''); selectSession(s); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                        gap: 8, padding: '9px 12px', background: 'none', border: 'none', borderBottom: '1px solid #F2F2F2',
                        cursor: 'pointer', textAlign: 'left', fontSize: 'calc(13px * var(--fs))' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F5F9FC'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                      <span style={{ fontWeight: 600 }}>{s.patient_name || 'Unregistered'}</span>
                      <span style={{ color: 'var(--text-light)', fontSize: 'calc(12px * var(--fs))' }}>{formatPhoneDisplay(s.patient_phone) || ''} · {s.department}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowFilters(s => !s)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 16px',
                  background: activeCount ? 'var(--secondary)' : '#fff', color: activeCount ? '#fff' : 'var(--primary)',
                  border: `1px solid ${activeCount ? 'var(--secondary)' : '#CBD5E0'}`, borderRadius: 10,
                  fontSize: 'calc(14px * var(--fs))', fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                Filter
                {activeCount > 0 && (
                  <span style={{ background: activeCount ? 'rgba(255,255,255,0.25)' : 'var(--secondary)',
                    color: '#fff', borderRadius: 10, minWidth: 20, height: 20, padding: '0 6px',
                    fontSize: 'calc(12px * var(--fs))', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {activeCount}
                  </span>
                )}
              </button>

              {showFilters && (
                <>
                  {/* click-away backdrop */}
                  <div onClick={() => setShowFilters(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{
                    position: 'absolute', top: 48, left: 0, zIndex: 41, width: 300,
                    background: '#fff', borderRadius: 14, padding: 16,
                    boxShadow: '0 8px 28px rgba(0,0,0,0.16)', border: '1px solid #E2E8F0',
                    display: 'flex', flexDirection: 'column', gap: 14,
                  }}>
                    <div>
                      <label style={fieldLabel}>Department</label>
                      <select className="input" style={selectStyle} value={filters.department}
                        onChange={e => onDeptChange(e.target.value)}>
                        <option value="">All Departments</option>
                        {depts.map(d => <option key={d.code} value={d.code}>{d.name} ({d.code})</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={fieldLabel}>Doctor</label>
                      <select className="input" style={selectStyle} value={filters.doctor_id}
                        onChange={e => setFilters(f => ({ ...f, doctor_id: e.target.value }))}>
                        <option value="">{filters.department ? 'All Doctors in dept.' : 'All Doctors'}</option>
                        {doctorOptions.map(d => <option key={d.id} value={d.id}>{d.name} ({d.department})</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={fieldLabel}>Triage</label>
                      <select className="input" style={selectStyle} value={filters.triage}
                        onChange={e => setFilters(f => ({ ...f, triage: e.target.value }))}>
                        <option value="">All Triage</option>
                        <option value="RED">Severe</option>
                        <option value="AMBER">Moderate</option>
                        <option value="GREEN">Mild</option>
                      </select>
                    </div>
                    <div>
                      <label style={fieldLabel}>State</label>
                      <select className="input" style={selectStyle} value={filters.state}
                        onChange={e => setFilters(f => ({ ...f, state: e.target.value }))}>
                        <option value="">All States</option>
                        <option value="REGISTERED">Registered</option>
                        <option value="INTERVIEW">In Interview</option>
                        <option value="VITALS">Vitals</option>
                        <option value="READY">Ready</option>
                        <option value="STARTED">Started</option>
                        <option value="COMPLETED">Completed</option>
                      </select>
                    </div>

                    {/* Clear filters — bottom of the popover */}
                    <button
                      onClick={() => setFilters({ department: '', doctor_id: '', triage: '', state: '' })}
                      disabled={activeCount === 0}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        height: 40, marginTop: 2, width: '100%', borderRadius: 10,
                        background: activeCount ? '#FDEDEC' : '#F1F3F5', color: activeCount ? '#C0392B' : '#A0A0A0',
                        border: `1px solid ${activeCount ? '#F1B0A8' : '#E2E2E2'}`,
                        fontSize: 'calc(13px * var(--fs))', fontWeight: 600, cursor: activeCount ? 'pointer' : 'default', transition: 'background 0.12s',
                      }}>
                      <XIcon /> Clear filters
                    </button>
                  </div>
                </>
              )}
            </div>

            <span style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: 600, color: 'var(--text)' }}>
              {visibleSessions.length}
              <span style={{ color: 'var(--text-light)', fontWeight: 400 }}> patient{visibleSessions.length !== 1 ? 's' : ''}</span>
            </span>
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* Patient Table — its own vertical scroll so only the rows move; the
            page header, tabs and search stay put. The column header sticks to the
            top of this scroll area. */}
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 190px)', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
            <thead>
              <tr style={{ background: 'var(--primary)', color: '#fff', fontSize: 'calc(13px * var(--fs))' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Patient</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Dept</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Triage</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>State</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Consult Time</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Doctor</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Assign / Reassign</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map(s => (
                <tr key={s.id} onClick={() => selectSession(s)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid #F0F0F0',
                    background: selected?.id === s.id ? '#EBF5FB' : 'transparent' }}>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(13px * var(--fs))' }}>
                    <strong>{s.patient_name || 'Unregistered'}</strong>
                    <br /><span style={{ color: 'var(--text-light)', fontSize: 'calc(11px * var(--fs))' }}>
                      {s.patient_age ? `${s.patient_age}y` : ''} {s.patient_gender || ''} · {s.token_label || '—'}
                    </span>
                    {s.patient_phone && (
                      <><br /><span style={{ color: 'var(--text-light)', fontSize: 'calc(11px * var(--fs))', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
                        </svg>
                        {formatPhoneDisplay(s.patient_phone)}
                      </span></>
                    )}
                    {s.created_at && (
                      <><br /><span style={{ color: 'var(--text-light)', fontSize: 'calc(11px * var(--fs))', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                        {fmtDateTime(s.created_at)}
                      </span></>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(13px * var(--fs))' }}>{s.department}</td>
                  <td style={{ padding: '10px 12px' }}><TriageBadge level={s.triage_level} compact /></td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(13px * var(--fs))' }}>
                    {(() => { const m = stateMeta(s.display_state); return (
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 'calc(11px * var(--fs))', background: m.bg, color: m.fg }}>{m.label}</span>
                    ); })()}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(13px * var(--fs))' }}>
                    {(() => {
                      const dur = consultDuration(s);
                      if (dur) return <span style={{ fontWeight: 600, color: 'var(--secondary)' }}>⏱ {dur}</span>;
                      if (s.consulted_at && !s.dispatched_at) return <span style={{ color: 'var(--amber)', fontSize: 'calc(11px * var(--fs))' }}>In progress</span>;
                      return <span style={{ color: 'var(--text-light)', fontSize: 'calc(11px * var(--fs))' }}>—</span>;
                    })()}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(13px * var(--fs))' }}>
                    {s.doctor_name || <span style={{ color: 'var(--amber)', fontSize: 'calc(11px * var(--fs))' }}>Unassigned</span>}
                    {/* Doctor the patient asked for at registration — a hint for the
                        admin when balancing the queue, NOT an auto-assignment. */}
                    {s.preferred_doctor_name && (
                      <div title="Preferred doctor — chosen by the patient at registration"
                        style={{ marginTop: 3, fontSize: 'calc(10.5px * var(--fs))', color: 'var(--text-light)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ color: 'var(--amber)' }} aria-hidden>★</span>
                        Prefers {s.preferred_doctor_name}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                    {/* A finished consultation is locked — reassigning would reopen a
                        closed visit. Backend enforces this too (409). */}
                    {s.display_state === 'COMPLETED' ? (
                      <span title="Consultation completed — assignment is locked"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        Locked
                      </span>
                    ) : (
                      <select
                        value={s.assigned_doctor_id || ''}
                        onChange={e => {
                          const val = e.target.value;
                          if (val) handleReassign(s.id, val);
                          else handleUnassign(s.id);
                        }}
                        style={{ border: '1px solid #ccc', borderRadius: 6, padding: '4px 6px', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer', maxWidth: 160 }}>
                        <option value="">Unassigned</option>
                        {doctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleSessions.length === 0 && (
            <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 32 }}>
              {q ? `No patients match “${search}”` : 'No sessions match filters'}
            </p>
          )}
        </div>

        {/* Report Sidebar (when selected) */}
        {selected && (
          <div style={{ width: 480, flexShrink: 0, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', maxHeight: 'calc(100vh - 120px)', overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <TriageBadge level={selected.triage_level} />
              <h3 style={{ fontSize: 'calc(16px * var(--fs))' }}>{selected.patient_name}</h3>
              <button onClick={() => { setSelected(null); setReport(null); }}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
            </div>
            <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 12 }}>
              {selected.patient_age ? `${selected.patient_age}y` : ''} {selected.patient_gender || ''} · {selected.department} · Doctor: {selected.doctor_name || 'Unassigned'}
            </p>

            {/* Switchable headings, ordered by importance: the generated report,
                the doctor's prescription, then the patient's own uploads. */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, borderBottom: '1px solid #E2E8F0' }}>
              {[['report', 'Report'], ['prescription', `Prescription${rxList.length ? ` (${rxList.length})` : ''}`], ['documents', `Uploaded${docs.length ? ` (${docs.length})` : ''}`]].map(([key, lbl]) => (
                <button key={key} onClick={() => setDetailTab(key)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', fontSize: 'calc(13px * var(--fs))', fontWeight: 600,
                    color: detailTab === key ? 'var(--primary)' : 'var(--text-light)',
                    borderBottom: detailTab === key ? '2px solid var(--primary)' : '2px solid transparent', marginBottom: -1 }}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* ── Report ── */}
            {detailTab === 'report' && (
              loading ? <p style={{ color: 'var(--text-light)' }}>Loading report...</p>
              : report ? (
                <div style={{ lineHeight: 1.7, fontSize: 'calc(14px * var(--fs))' }}>
                  <ReactMarkdown>{report.report_md}</ReactMarkdown>
                </div>
              ) : <p style={{ color: 'var(--text-light)' }}>No report generated yet.</p>
            )}

            {/* ── Doctor-generated prescription (Save & Generate QR) ── */}
            {detailTab === 'prescription' && (
              rxList.length === 0 ? (
                <p style={{ color: 'var(--text-light)' }}>Prescription not yet generated — the doctor hasn't completed this consultation.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {rxList.map(p => (
                    <div key={p.id} style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: 14 }}>
                      <RxDocument
                        rx={{
                          patient: selected.patient_name,
                          patient_age: selected.patient_age,
                          patient_gender: selected.patient_gender,
                          patient_phone: selected.patient_phone,
                          doctor: p.doctor_name,
                          department: selected.department,
                          items: (p.items || []).map(it => ({ drug: it.drug_name, dose: it.dose, freq: it.frequency, duration: it.duration, instructions: it.instructions })),
                          notes: p.notes,
                          rx_id: p.id,
                          issued_at: p.created_at,
                        }}
                        template={rxTemplate || {}}
                      />
                    </div>
                  ))}
                </div>
              )
            )}

            {/* ── Patient-uploaded documents — the EXACT files the patient uploaded ── */}
            {detailTab === 'documents' && (
              docs.length === 0 ? (
                <p style={{ color: 'var(--text-light)' }}>No documents uploaded by this patient.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {docs.map(d => (
                    <div key={d.id} style={{ border: '1px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                        <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, textTransform: 'capitalize' }}>{String(d.doc_type || 'document').replace(/_/g, ' ')}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{d.created_at ? fmtDateTime(d.created_at) : ''}</span>
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
              )
            )}
          </div>
        )}
      </div>
      </>)}
    </div>
  );
}


// Format a millisecond duration as "1h 5m" / "12m" / "45s" / "—".
function fmtMs(ms) {
  if (!(ms > 0)) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

// Doctors tab — unified hub: per-doctor workload stats + management (add new,
// view full details, deactivate). Reads the full (unfiltered) session list once
// and derives per-doctor metrics client-side; clicking a doctor opens a detail
// drawer, and "+ Add Doctor" opens a modal. `onChange` refreshes the doctor list.
function DoctorInfo({ doctors = [], depts = [], onChange = () => {} }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');   // doctor name / department search
  const [selected, setSelected] = useState(null);   // doctor detail drawer
  const [showAdd, setShowAdd] = useState(false);     // add-doctor modal
  const [showEdit, setShowEdit] = useState(false);   // edit-doctor modal
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await api.allSessions({});
        if (alive) setSessions(rows || []);
      } catch { /* ignore */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  async function handleDeactivate(doctor) {
    if (!(await confirm({
      title: `Deactivate ${doctor.name}?`,
      message: "They won't be able to log in, but all historical data is kept.",
      confirmLabel: 'Deactivate', danger: true,
    }))) return;
    try {
      await api.deactivateDoctor(doctor.id);
      setSelected(null);
      onChange();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  }

  async function handleReactivate(doctor) {
    if (!(await confirm({
      title: `Reactivate ${doctor.name}?`,
      message: 'They will be able to log in and take patients again.',
      confirmLabel: 'Reactivate',
    }))) return;
    try {
      await api.reactivateDoctor(doctor.id);
      setSelected(null);
      onChange();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  }

  // Build per-doctor stats keyed by doctor id.
  const stats = {};
  doctors.forEach(d => {
    stats[d.id] = { total: 0, completed: 0, active: 0, severe: 0, durMs: [], lastAt: null };
  });
  sessions.forEach(s => {
    const id = s.assigned_doctor_id;
    if (!id || !stats[id]) return;            // skip unassigned / unknown
    const st = stats[id];
    st.total++;
    if (s.dispatched_at) st.completed++; else st.active++;
    if (s.triage_level === 'RED') st.severe++;
    if (s.consulted_at && s.dispatched_at) {
      const ms = new Date(s.dispatched_at) - new Date(s.consulted_at);
      if (ms > 0) st.durMs.push(ms);
    }
    if (s.dispatched_at && (!st.lastAt || new Date(s.dispatched_at) > new Date(st.lastAt))) {
      st.lastAt = s.dispatched_at;
    }
  });

  const totals = doctors.reduce((acc, d) => {
    const st = stats[d.id];
    acc.total += st.total; acc.completed += st.completed; acc.active += st.active; acc.severe += st.severe;
    return acc;
  }, { total: 0, completed: 0, active: 0, severe: 0 });

  const th = { padding: '11px 14px', textAlign: 'left', fontSize: 'calc(12px * var(--fs))', fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 };
  const td = { padding: '11px 14px', fontSize: 'calc(13px * var(--fs))', whiteSpace: 'nowrap' };
  const numChip = (n, color) => (
    <span style={{ fontWeight: 700, color: n ? color : 'var(--text-light)' }}>{n}</span>
  );

  if (loading) return <p style={{ color: 'var(--text-light)', padding: 24 }}>Loading doctor stats…</p>;

  // ── Search + ghost prediction over doctor name / department ──
  const dq = search.trim().toLowerCase();
  const filteredDoctors = dq
    ? doctors.filter(d => (d.name || '').toLowerCase().includes(dq) || (d.department || '').toLowerCase().includes(dq))
    : doctors;
  const docNames = [...new Set(doctors.map(d => d.name).filter(Boolean))];
  const ghost = dq ? (docNames.find(n => n.toLowerCase().startsWith(dq)) || '') : '';
  const ghostTail = ghost && ghost.toLowerCase() !== dq ? ghost.slice(search.length) : '';

  const avgMsFor = (d) => { const st = stats[d.id]; return st && st.durMs.length ? st.durMs.reduce((a, b) => a + b, 0) / st.durMs.length : 0; };

  return (
    <div>
      {dialog}
      {toastView}
      {/* Search + Add Doctor */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', width: 300 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-light)', pointerEvents: 'none', display: 'flex' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          {ghostTail && (
            <div aria-hidden style={{ position: 'absolute', inset: 0, boxSizing: 'border-box',
              border: '1px solid transparent', paddingLeft: 36, paddingRight: 12,
              fontSize: 'calc(14px * var(--fs))', lineHeight: '38px', whiteSpace: 'pre', pointerEvents: 'none', overflow: 'hidden' }}>
              <span style={{ color: 'transparent' }}>{search}</span>
              <span style={{ color: 'var(--text-light)' }}>{ghostTail}</span>
            </div>
          )}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostTail) { e.preventDefault(); setSearch(ghost); }
              if (e.key === 'Escape') setSearch('');
            }}
            placeholder="Search doctor name or department…"
            style={{ width: '100%', height: 40, boxSizing: 'border-box', paddingLeft: 36, paddingRight: search ? 32 : 12,
              border: '1px solid #CBD5E0', borderRadius: 10, fontSize: 'calc(14px * var(--fs))', lineHeight: '38px', background: 'transparent', outline: 'none' }}
          />
          {search && (
            <button onClick={() => setSearch('')} title="Clear search"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)', display: 'flex', padding: 4 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
              </svg>
            </button>
          )}
        </div>
        {/* Count of registered doctors — mirrors the patient count on the Patients
            tab. Replaces the old 4-card summary strip (per mentor feedback: the
            aggregate cards weren't useful here). */}
        <span style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: 600, color: 'var(--text)' }}>
          {doctors.length}
          <span style={{ color: 'var(--text-light)', fontWeight: 400 }}> doctor{doctors.length !== 1 ? 's' : ''} registered</span>
        </span>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}
          style={{ marginLeft: 'auto', height: 40, width: 'auto', padding: '0 18px', fontSize: 'calc(14px * var(--fs))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          + Add Doctor
        </button>
      </div>

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 230px)', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ background: 'var(--primary)', color: '#fff' }}>
              <th style={th}>Doctor</th>
              <th style={th}>Department</th>
              <th style={{ ...th, textAlign: 'center' }}>Total</th>
              <th style={{ ...th, textAlign: 'center' }}>Completed</th>
              <th style={{ ...th, textAlign: 'center' }}>Active</th>
              <th style={{ ...th, textAlign: 'center' }}>Avg. Consult</th>
              <th style={th}>Last Consult</th>
              <th style={{ ...th, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredDoctors.length === 0 && (
              <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: 'var(--text-light)', padding: 28 }}>
                {dq ? `No doctors match “${search}”` : 'No doctors found'}
              </td></tr>
            )}
            {filteredDoctors.map(d => {
              const st = stats[d.id];
              return (
                <tr key={d.id} onClick={() => setSelected(d)}
                  style={{ borderBottom: '1px solid #F0F0F0', cursor: 'pointer', opacity: d.is_active ? 1 : 0.55,
                    background: selected?.id === d.id ? '#EBF5FB' : 'transparent' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{d.name}</td>
                  <td style={td}><span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>{d.department || '—'}</span></td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.total, 'var(--text)')}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.completed, 'var(--green)')}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.active, 'var(--secondary)')}</td>
                  <td style={{ ...td, textAlign: 'center', fontWeight: 600 }}>{fmtMs(avgMsFor(d))}</td>
                  <td style={td}><span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>{st.lastAt ? fmtDateTime(st.lastAt) : '—'}</span></td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 'calc(11px * var(--fs))',
                      background: d.is_active ? '#D5F5E3' : '#F8F9FA', color: d.is_active ? '#1E8449' : 'var(--text-light)' }}>
                      {d.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Doctor detail drawer */}
      {selected && (() => {
        const st = stats[selected.id] || { total: 0, completed: 0, active: 0, severe: 0, durMs: [], lastAt: null };
        const cell = (label, val, color, small) => (
          <div style={{ background: '#F8FAFC', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: `calc(${small ? 14 : 18}px * var(--fs))`, fontWeight: 700, color: color || 'var(--text)' }}>{val}</div>
            <div style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 2 }}>{label}</div>
          </div>
        );
        return (
          <Modal
            onClose={() => setSelected(null)}
            labelledBy="patient-drawer-title"
            scrimStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 50 }}
            panelStyle={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 380, background: '#fff', zIndex: 51,
              boxShadow: '-6px 0 24px rgba(0,0,0,0.15)', padding: 22, overflowY: 'auto' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <h3 id="patient-drawer-title" style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)' }}>{selected.name}</h3>
                  <span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>{selected.department}</span>
                </div>
                <button type="button" onClick={() => setSelected(null)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
                </button>
              </div>

              {/* Identity */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                {[['Phone', formatPhoneDisplay(selected.phone) || '—'], ['Department', selected.department || '—'], ['Reg. no.', selected.registration_no || '—']].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(13px * var(--fs))' }}>
                    <span style={{ color: 'var(--text-light)' }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(13px * var(--fs))', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-light)' }}>Status</span>
                  <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 'calc(11px * var(--fs))', background: selected.is_active ? '#D5F5E3' : '#F8F9FA', color: selected.is_active ? '#1E8449' : 'var(--text-light)' }}>
                    {selected.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              {/* Stats */}
              <p style={{ fontSize: 'calc(11px * var(--fs))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 8 }}>Workload (all-time)</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {cell('Total', st.total)}
                {cell('Completed', st.completed, 'var(--green)')}
                {cell('Active', st.active, 'var(--secondary)')}
                {cell('Avg. Consult', fmtMs(avgMsFor(selected)))}
                {cell('Last Consult', st.lastAt ? fmtDateTime(st.lastAt) : '—', null, true)}
              </div>

              <button onClick={() => setShowEdit(true)}
                style={{ marginTop: 18, width: '100%', height: 42, borderRadius: 10, background: '#fff', color: 'var(--primary)', border: '1px solid #CBD5E0', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, cursor: 'pointer' }}>
                Edit details
              </button>

              {selected.is_active ? (
                <button onClick={() => handleDeactivate(selected)}
                  style={{ marginTop: 10, width: '100%', height: 42, borderRadius: 10, background: '#FDEDEC', color: '#C0392B', border: '1px solid #F1B0A8', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, cursor: 'pointer' }}>
                  Deactivate doctor
                </button>
              ) : (
                <button onClick={() => handleReactivate(selected)}
                  style={{ marginTop: 10, width: '100%', height: 42, borderRadius: 10, background: '#D5F5E3', color: 'var(--green-on-tint)', border: '1px solid #A9DFBF', fontSize: 'calc(13px * var(--fs))', fontWeight: 600, cursor: 'pointer' }}>
                  Reactivate doctor
                </button>
              )}
            </div>
          </Modal>
        );
      })()}

      {/* Add-doctor modal */}
      {showAdd && (
        <AddDoctorModal depts={depts} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); onChange(); }} />
      )}

      {/* Edit-doctor modal */}
      {showEdit && selected && (
        <EditDoctorModal doctor={selected} depts={depts}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); setSelected(null); onChange(); }} />
      )}
      <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 10 }}>
        All-time stats. “Avg. Consult” is the mean time from a doctor locking a patient to clicking Save &amp; Generate QR.
      </p>
    </div>
  );
}

// Add-doctor modal — opened from the Doctors hub. Clean centered card overlay.
function AddDoctorModal({ depts = [], onClose, onAdded }) {
  const [form, setForm] = useState({ name: '', department: depts.find(d => d.is_active)?.code || 'CARD', phone: '', pin: '', registration_no: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPin, setShowPin] = useState(false);
  const titleId = useId();
  const panelRef = useDialogA11y(onClose);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (form.pin.length < 4 || form.pin.length > 6) { setError('PIN must be 4-6 digits'); return; }
    setSaving(true);
    try {
      await api.createDoctor(form);
      onAdded();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
        width: 400, maxWidth: '92vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h3 id={titleId} style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Add New Doctor</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dr. Ravi Kumar" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Department *</label>
            <select className="input" value={form.department}
              onChange={e => setForm({ ...form, department: e.target.value })}>
              {depts.filter(d => d.is_active).map(d => (
                <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Phone *</label>
            <input className="input" type="tel" inputMode="numeric" maxLength={10} required value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
              placeholder="9876500099" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Registration / license no. (optional)</label>
            <input className="input" value={form.registration_no}
              onChange={e => setForm({ ...form, registration_no: e.target.value })} placeholder="e.g. KMC-12345" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>PIN (4-6 digits) *</label>
            <div style={{ position: 'relative' }}>
              <input className="input" type={showPin ? 'text' : 'password'} inputMode="numeric" maxLength={6} required value={form.pin}
                onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
                placeholder="••••" style={{ letterSpacing: showPin ? 2 : 4, paddingRight: 58 }} />
              <button type="button" onClick={() => setShowPin(s => !s)}
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'} aria-pressed={showPin}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', fontWeight: 600, padding: 4 }}>
                {showPin ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={saving} style={{ flex: 1 }}>
              {saving ? 'Adding...' : 'Add Doctor'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// Edit-doctor modal — opened from the doctor detail drawer. Pre-fills the current
// details; the PIN field is optional (blank = keep the existing PIN, never shown).
function EditDoctorModal({ doctor, depts = [], onClose, onSaved }) {
  const titleId = useId();
  const panelRef = useDialogA11y(onClose);
  const [form, setForm] = useState({
    name: doctor.name || '', department: doctor.department || 'CARD', phone: doctor.phone || '', pin: '',
    registration_no: doctor.registration_no || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (form.pin && (form.pin.length < 4 || form.pin.length > 6)) { setError('PIN must be 4-6 digits'); return; }
    setSaving(true);
    try {
      const payload = { name: form.name, department: form.department, phone: form.phone, registration_no: form.registration_no };
      if (form.pin) payload.pin = form.pin;   // omit to keep current PIN
      await api.updateDoctor(doctor.id, payload);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  // Make sure the doctor's current department is selectable even if it's inactive.
  const deptOptions = depts.filter(d => d.is_active || d.code === doctor.department);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
        width: 400, maxWidth: '92vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h3 id={titleId} style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Edit Doctor</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dr. Ravi Kumar" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Department *</label>
            <select className="input" value={form.department}
              onChange={e => setForm({ ...form, department: e.target.value })}>
              {deptOptions.map(d => (
                <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Phone *</label>
            <input className="input" type="tel" inputMode="numeric" maxLength={10} required value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
              placeholder="9876500099" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Registration / license no.</label>
            <input className="input" value={form.registration_no}
              onChange={e => setForm({ ...form, registration_no: e.target.value })} placeholder="e.g. KMC-12345" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Reset PIN (4-6 digits)</label>
            <input className="input" type="password" inputMode="numeric" maxLength={6} value={form.pin}
              onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
              placeholder="Leave blank to keep current" style={{ letterSpacing: form.pin ? 4 : 0 }} />
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={saving} style={{ flex: 1 }}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}


const EMPTY_Q = {
  id: '', department: 'CARD', text_en: '', text_hi: '', text_te: '',
  q_type: 'BOOLEAN', options_json: null, required: true,
  triage_flag: '', triage_answer: '', answer_triage: {}, next_default: '', next_rules: [],
  sort_order: 0, is_base: false,
};

// Friendly answer-type labels — a clinician picks "Yes / No", not "BOOLEAN".
const Q_TYPE_LABELS = {
  BOOLEAN: 'Yes / No', SINGLE_SELECT: 'Pick one', MULTI_SELECT: 'Pick several',
  FREE_TEXT: 'Free text', NUMERIC: 'Number',
};
const Q_TYPE_ORDER = ['BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT', 'FREE_TEXT', 'NUMERIC'];
const qIsSelect = t => t === 'SINGLE_SELECT' || t === 'MULTI_SELECT';
// Questions whose answers are discrete single choices can branch + flag per answer.
const qHasBranch = t => t === 'BOOLEAN' || t === 'SINGLE_SELECT';

function qSlugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'q';
}
function qShort(s, n = 52) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
// The answer options a question exposes (Yes/No is implicit for BOOLEAN).
function qAnswerOptions(q) {
  if (q.q_type === 'BOOLEAN') return [{ value: 'yes', label_en: 'Yes' }, { value: 'no', label_en: 'No' }];
  if (qIsSelect(q.q_type)) return q.options_json || [];
  return [];
}
// Per-answer urgency map { answerValue: 'RED'|'AMBER' }. Prefers the new
// answer_triage column; falls back to the legacy single triage_flag/answer pair.
function qUrgencyMap(q) {
  const m = q.answer_triage;
  if (m && typeof m === 'object' && !Array.isArray(m)) return m;
  if (q.triage_flag && q.triage_answer) return { [q.triage_answer]: q.triage_flag };
  return {};
}
function qTopUrgency(q) {
  const vals = Object.values(qUrgencyMap(q));
  return vals.includes('RED') ? 'RED' : vals.includes('AMBER') ? 'AMBER' : '';
}
// Client-side mirror of the engine's resolveNext (routes/questionnaire.js) — used
// only by the read-only "Preview flow" simulator.
function qResolveNext(node, answerVal) {
  for (const r of (node.next_rules || [])) {
    if (String(r.if_answer) === String(answerVal)) return (r.go_to == null || r.go_to === '') ? null : r.go_to;
  }
  return node.next_default || null;
}
function qEscalate(a, b) {
  if (a === 'RED' || b === 'RED') return 'RED';
  if (a === 'AMBER' || b === 'AMBER') return 'AMBER';
  return '';
}

// Live "flow health" over the department DAG — makes the branching visible so a
// nurse can spot dead-ends, unreachable questions, loops or missing targets.
function qComputeHealth(questions) {
  const dag = questions.filter(q => !q.is_base && q.q_type !== 'TERMINAL');
  const ids = new Set(questions.map(q => q.id));
  const issues = {};
  const add = (id, level, msg) => { (issues[id] = issues[id] || []).push({ level, msg }); };
  const nextsOf = q => [q.next_default, ...(q.next_rules || []).map(r => r.go_to)].filter(v => v != null && v !== '');

  for (const q of dag) {
    for (const t of nextsOf(q)) if (!ids.has(t)) add(q.id, 'error', 'goes to a question that no longer exists');
    if (qIsSelect(q.q_type) && (q.options_json || []).length < 2) add(q.id, 'warn', 'has fewer than 2 answers');
    if ((q.options_json || []).some(o => !o.label_en)) add(q.id, 'warn', 'has an answer with no English label');
    for (const ans of Object.keys(qUrgencyMap(q))) {
      if (!qAnswerOptions(q).some(o => o.value === ans)) { add(q.id, 'warn', 'urgency is set on a missing answer'); break; }
    }
  }
  if (dag.length) {
    const byId = Object.fromEntries(dag.map(q => [q.id, q]));
    const entry = [...dag].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
    const seen = new Set();
    const stack = [entry.id];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur) || !byId[cur]) continue;
      seen.add(cur);
      nextsOf(byId[cur]).forEach(n => stack.push(n));
    }
    dag.forEach(q => { if (!seen.has(q.id)) add(q.id, 'warn', 'is never reached from the start'); });
    const color = {};
    let cyclic = false;
    (function dfs(id) {
      if (!byId[id]) return;
      color[id] = 1;
      for (const n of nextsOf(byId[id])) {
        if (color[n] === 1) cyclic = true;
        else if (!color[n]) dfs(n);
      }
      color[id] = 2;
    })(entry.id);
    if (cyclic) add(entry.id, 'warn', 'the flow can loop back on itself');
    if (![...seen].some(id => nextsOf(byId[id]).length === 0)) add(entry.id, 'warn', 'no path reaches the end (vitals)');
  }
  return issues;
}

// ---- shared style tokens (prefixed to avoid clashes elsewhere in this file) ----
const qLbl = { fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', display: 'block', marginBottom: 3 };
const qPanel = { background: '#F8F9FA', borderRadius: 8, padding: 12 };
const qErr = { color: 'var(--red)', fontSize: 'calc(13px * var(--fs))' };
const qOk = { color: 'var(--green)', fontSize: 'calc(13px * var(--fs))' };
const qMiniBtn = { background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 'calc(11px * var(--fs))', cursor: 'pointer' };
const qSectionLabel = { fontSize: 'calc(10px * var(--fs))', fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-light)', textTransform: 'uppercase', margin: '4px 2px 6px' };
const qBadge = (bg, color) => ({ fontSize: 'calc(10px * var(--fs))', background: bg, color, padding: '2px 6px', borderRadius: 4, fontWeight: 600, whiteSpace: 'nowrap' });
const qChip = active => ({ padding: '5px 12px', borderRadius: 16, border: active ? '1.5px solid var(--secondary)' : '1px solid #D0D0D0', background: active ? '#EBF5FB' : '#fff', color: active ? 'var(--secondary)' : 'var(--text)', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', fontWeight: active ? 600 : 400 });
const qArrowBtn = disabled => ({ background: '#fff', border: '1px solid #D0D0D0', borderRadius: 4, width: 22, height: 22, lineHeight: '18px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1, fontSize: 'calc(12px * var(--fs))' });

// Module-level components (stable identity → inputs never lose focus on re-render).
function QEditorHeader({ title, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>{title}</h3>
      <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
    </div>
  );
}
function QTextFields({ editing, setEditing }) {
  return (
    <>
      <div>
        <label style={qLbl}>Question (English) *</label>
        <input className="input" required value={editing.text_en} placeholder="e.g. Do you have chest pain?"
          onChange={e => setEditing(prev => ({ ...prev, text_en: e.target.value }))} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={qLbl}>Hindi</label>
          <input className="input" value={editing.text_hi || ''} onChange={e => setEditing(prev => ({ ...prev, text_hi: e.target.value }))} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={qLbl}>Telugu</label>
          <input className="input" value={editing.text_te || ''} onChange={e => setEditing(prev => ({ ...prev, text_te: e.target.value }))} />
        </div>
      </div>
    </>
  );
}
// A "go to" picker that lists other questions by their TEXT, never their id.
// mode 'default' → next_default (blank = end); mode 'branch' → a per-answer rule.
function QTargetPicker({ mode, value, targets, onChange }) {
  return (
    <select className="input" style={{ minHeight: 34, fontSize: 'calc(12px * var(--fs))', width: '100%' }}
      value={value} onChange={e => onChange(e.target.value)}>
      {mode === 'branch' && <option value="__DEFAULT__">— continue to default —</option>}
      {mode === 'default' && <option value="">▶ End intake (go to vitals)</option>}
      {targets.map(t => <option key={t.id} value={t.id}>{qShort(t.text_en || t.id)}</option>)}
      {mode === 'branch' && <option value="__END__">▶ End intake here</option>}
    </select>
  );
}
function QRow({ q, selected, issues, onClick, reorder }) {
  const branchCount = (q.next_rules || []).length;
  const topUrg = qTopUrgency(q);
  return (
    <div onClick={onClick} style={{
      background: selected ? '#EBF5FB' : (q.is_base ? '#FAF8FD' : '#fff'),
      border: selected ? '2px solid var(--secondary)' : '1px solid #E0E0E0',
      borderLeft: q.is_base ? '3px solid #9B7FC4' : (selected ? '2px solid var(--secondary)' : '1px solid #E0E0E0'),
      borderRadius: 10, padding: 10, marginBottom: 6, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, flex: 1, lineHeight: 1.3 }}>{q.text_en || q.id}</span>
        {reorder && <span style={{ display: 'flex', gap: 2 }} onClick={e => e.stopPropagation()}>{reorder}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
        <span style={qBadge('#F0F0F0', 'var(--text)')}>{Q_TYPE_LABELS[q.q_type] || q.q_type}</span>
        {q.is_base && <span style={qBadge('#7C5BA6', '#fff')}>BASE</span>}
        {topUrg && <span style={qBadge(topUrg === 'RED' ? 'var(--red)' : 'var(--amber)', topUrg === 'RED' ? '#fff' : 'var(--amber-on)')}>{topUrg === 'RED' ? '🔴' : '🟡'} {topUrg}</span>}
        {branchCount > 0 && <span style={qBadge('#E8F0FE', 'var(--secondary)')}>{branchCount} branch{branchCount === 1 ? '' : 'es'}</span>}
      </div>
      {issues.map((iss, k) => (
        <p key={k} style={{ fontSize: 'calc(10px * var(--fs))', marginTop: 3, color: iss.level === 'error' ? 'var(--red)' : 'var(--amber-on)' }}>
          {iss.level === 'error' ? '⛔' : '⚠'} {iss.msg}
        </p>
      ))}
    </div>
  );
}

// ---- read-only Flow Map: a top-down flow diagram of the department branching ----
// Dependency-free (pure SVG + positioned divs). Uses the SAME edge model as the
// engine: per-answer next_rules override next_default; a null/blank target = end
// (→ Vitals). The flow reads top→bottom: the main path runs straight down a spine
// and answer-branches fork off into side lanes, so a rejoining detour reads as a
// fork+merge rather than an inline step. Rows = longest-path depth from the entry
// (cycle-guarded by an iteration cap); lanes pack branches to the right and reuse.
const QFM = { NW: 188, NH: 72, GX: 30, GY: 30, PAD: 18 };

// True when the engine can NEVER fall through to next_default: a Yes/No or
// single-select question where every answer already has its own branch rule.
// Drawing that default edge would imply a path the patient can't actually take.
function qAllAnswersBranched(q) {
  if (!qHasBranch(q.q_type)) return false;
  const opts = qAnswerOptions(q);
  if (!opts.length) return false;
  const covered = new Set((q.next_rules || []).map(r => String(r.if_answer)));
  return opts.every(o => covered.has(String(o.value)));
}
function qFlowEdges(q) {
  const list = [];
  for (const r of (q.next_rules || [])) {
    const opt = qAnswerOptions(q).find(o => String(o.value) === String(r.if_answer));
    const to = (r.go_to == null || r.go_to === '') ? null : r.go_to;
    list.push({ to, kind: 'branch', label: opt?.label_en || String(r.if_answer), urg: qUrgencyMap(q)[r.if_answer] || '' });
  }
  if (!qAllAnswersBranched(q)) {
    const dflt = (q.next_default == null || q.next_default === '') ? null : q.next_default;
    list.push({ to: dflt, kind: 'default', label: '', urg: '' });
  }
  return list;
}
function qFlowLayout(questions) {
  const { NW, NH, GX, GY, PAD } = QFM;
  const nodes = questions.filter(q => !q.is_base && q.q_type !== 'TERMINAL');
  if (!nodes.length) return null;
  const byId = Object.fromEntries(nodes.map(q => [q.id, q]));
  const entry = [...nodes].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];

  // row = longest-path depth from the entry question (vertical position).
  const row = {}; nodes.forEach(q => row[q.id] = 0);
  for (let it = 0; it <= nodes.length; it++) {
    let changed = false;
    for (const q of nodes) for (const e of qFlowEdges(q)) {
      if (e.to && byId[e.to] && row[e.to] < row[q.id] + 1) { row[e.to] = row[q.id] + 1; changed = true; }
    }
    if (!changed) break;
  }
  const reached = new Set(); const rstack = [entry.id];
  while (rstack.length) {
    const c = rstack.pop();
    if (reached.has(c) || !byId[c]) continue;
    reached.add(c);
    qFlowEdges(byId[c]).forEach(e => e.to && rstack.push(e.to));
  }

  // lane = horizontal column. The main path stays in lane 0; each branch that
  // spawns a detour gets the shallowest free lane to the right (reused once its
  // rows are clear). The "main" successor is the branch reaching deepest.
  const primarySucc = q => {
    const outs = qFlowEdges(q).filter(e => e.to && byId[e.to]);
    if (!outs.length) return null;
    return outs.slice().sort((a, b) => {
      if (row[b.to] !== row[a.to]) return row[b.to] - row[a.to];
      if ((a.kind === 'default') !== (b.kind === 'default')) return a.kind === 'default' ? -1 : 1;
      return (byId[a.to].sort_order || 0) - (byId[b.to].sort_order || 0);
    })[0].to;
  };
  const laneOf = {};
  const laneMaxRow = { 0: Infinity }; // lane 0 = spine, never reused for a detour
  const claimLane = minRow => {
    let best = null;
    for (const l of Object.keys(laneMaxRow)) {
      const li = Number(l);
      if (li >= 1 && laneMaxRow[li] < minRow && (best === null || li < best)) best = li;
    }
    if (best !== null) return best;
    return Math.max(0, ...Object.keys(laneMaxRow).map(Number)) + 1;
  };
  const assignChain = (startId, lane) => {
    const detours = [];
    let id = startId, maxR = -1;
    while (id && byId[id] && laneOf[id] === undefined) {
      laneOf[id] = lane; maxR = Math.max(maxR, row[id]);
      const prim = primarySucc(byId[id]);
      for (const e of qFlowEdges(byId[id])) {
        if (e.to && byId[e.to] && e.to !== prim && laneOf[e.to] === undefined) detours.push(e.to);
      }
      id = prim;
    }
    if (lane >= 1) laneMaxRow[lane] = Math.max(laneMaxRow[lane] ?? -1, maxR);
    for (const d of detours) if (laneOf[d] === undefined) assignChain(d, claimLane(row[d]));
  };
  assignChain(entry.id, 0);
  nodes.forEach(q => { if (laneOf[q.id] === undefined) assignChain(q.id, claimLane(row[q.id])); });

  const maxLane = Math.max(0, ...Object.values(laneOf));
  const maxRow = Math.max(...nodes.map(q => row[q.id]));
  const pos = {};
  nodes.forEach(q => { pos[q.id] = { x: PAD + laneOf[q.id] * (NW + GX), y: PAD + row[q.id] * (NH + GY) }; });
  const endPos = { x: PAD, y: PAD + (maxRow + 1) * (NH + GY) }; // under the spine

  const edges = [];
  nodes.forEach(q => {
    const s = pos[q.id];
    qFlowEdges(q).forEach(e => {
      if (e.to && !pos[e.to]) return; // dangling target — flow-health flags it separately
      const t = e.to ? pos[e.to] : endPos;
      edges.push({
        from: q.id, ...e,
        sx: s.x + NW / 2, sy: s.y + NH,   // bottom-centre of source
        tx: t.x + NW / 2, ty: t.y,        // top-centre of target
      });
    });
  });
  const width = PAD * 2 + (maxLane + 1) * NW + maxLane * GX;
  const height = endPos.y + NH + PAD;
  return { nodes: nodes.map(q => ({ q, ...pos[q.id], reached: reached.has(q.id) })), edges, endPos, width, height };
}
// A small "node graph" glyph (one node forking to two) — a real affordance for the
// flow map, in place of the poorly-rendering 🗺 emoji. Inherits the button's colour.
function QGraphIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M8 6 L15.5 11.2 M8 18 L15.5 12.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="6" cy="6" r="2.7" fill="currentColor" />
      <circle cx="18" cy="12" r="2.7" fill="currentColor" />
      <circle cx="6" cy="18" r="2.7" fill="currentColor" />
    </svg>
  );
}
function QFlowMap({ questions, deptName, health, onPick, onClose }) {
  const layout = qFlowLayout(questions);
  const { NW, NH } = QFM;
  const edgeColor = e => e.kind === 'default' ? '#AAB2C0'
    : e.urg === 'RED' ? 'var(--red)' : e.urg === 'AMBER' ? 'var(--amber-text)' : 'var(--secondary)';
  // Vertical S-curve: leave the source downward, arrive at the target from above.
  const path = e => {
    const dy = Math.max(18, Math.abs(e.ty - e.sy) / 2);
    return `M ${e.sx} ${e.sy} C ${e.sx} ${e.sy + dy} ${e.tx} ${e.ty - dy} ${e.tx} ${e.ty}`;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Flow map — {deptName}</h3>
        <span style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span><svg width="26" height="8" style={{ verticalAlign: 'middle' }}><line x1="0" y1="4" x2="26" y2="4" stroke="#AAB2C0" strokeWidth="2" strokeDasharray="5 4" /></svg> default</span>
          <span><svg width="26" height="8" style={{ verticalAlign: 'middle' }}><line x1="0" y1="4" x2="26" y2="4" stroke="var(--secondary)" strokeWidth="2" /></svg> answer branch</span>
          <span style={{ color: 'var(--red)' }}>● red</span>
          <span style={{ color: 'var(--amber-text)' }}><span style={{ color: 'var(--amber)' }}>●</span> amber urgency</span>
        </span>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
      </div>
      {!layout ? (
        <p style={{ color: 'var(--text-light)', fontSize: 'calc(13px * var(--fs))', padding: 8 }}>No department questions to map yet.</p>
      ) : (
        <div style={{ maxHeight: 'calc(100vh - 300px)', overflow: 'auto', border: '1px solid #ECECEC', borderRadius: 10, background: 'linear-gradient(#FCFCFD, #F7F8FB)' }}>
          <div style={{ position: 'relative', width: layout.width, height: layout.height, margin: '0 auto' }}>
            <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <defs>
                <marker id="qfm-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                </marker>
              </defs>
              {layout.edges.map((e, i) => (
                <path key={i} d={path(e)} fill="none" stroke={edgeColor(e)}
                  strokeWidth={e.kind === 'default' ? 1.5 : 2.25}
                  strokeDasharray={e.kind === 'default' ? '5 4' : undefined}
                  markerEnd="url(#qfm-arrow)" />
              ))}
            </svg>
            {layout.edges.filter(e => e.kind === 'branch' && e.label).map((e, i) => (
              <div key={i} style={{
                position: 'absolute', left: (e.sx + e.tx) / 2, top: (e.sy + e.ty) / 2,
                transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 1,
                fontSize: 'calc(10px * var(--fs))', fontWeight: 700, color: edgeColor(e),
                background: 'rgba(255,255,255,0.95)', border: `1px solid ${edgeColor(e)}33`, borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              }}>{qShort(e.label, 16)}</div>
            ))}
            {layout.nodes.map(({ q, x, y, reached }) => {
              const urg = qTopUrgency(q);
              const branchCount = (q.next_rules || []).length;
              const bad = (health[q.id] || []).some(iss => iss.level === 'error');
              const accent = urg === 'RED' ? 'var(--red)' : urg === 'AMBER' ? 'var(--amber)' : 'var(--secondary)';
              return (
                <div key={q.id} onClick={() => onPick(q)} title={q.text_en} style={{
                  position: 'absolute', left: x, top: y, width: NW, height: NH, cursor: 'pointer', zIndex: 2,
                  background: '#fff', borderRadius: 9, padding: '8px 10px', overflow: 'hidden',
                  border: bad ? '1.5px solid var(--red)' : reached ? '1px solid #DCE0E7' : '1.5px dashed #C7A94F',
                  borderLeft: `4px solid ${bad ? 'var(--red)' : reached ? accent : '#C7A94F'}`,
                  opacity: reached ? 1 : 0.62, boxShadow: '0 1px 4px rgba(20,40,80,0.07)',
                  display: 'flex', flexDirection: 'column', gap: 5,
                }}>
                  <span style={{
                    fontSize: 'calc(11.5px * var(--fs))', fontWeight: 600, lineHeight: 1.25, color: 'var(--text)',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>{q.text_en || q.id}</span>
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={qBadge('#F0F0F0', 'var(--text)')}>{Q_TYPE_LABELS[q.q_type] || q.q_type}</span>
                    {urg && <span style={qBadge(urg === 'RED' ? 'var(--red)' : 'var(--amber)', urg === 'RED' ? '#fff' : 'var(--amber-on)')}>{urg === 'RED' ? '🔴' : '🟡'}</span>}
                    {branchCount > 0 && <span style={qBadge('#E8F0FE', 'var(--secondary)')}>{branchCount} branch{branchCount === 1 ? '' : 'es'}</span>}
                    {!reached && <span style={qBadge('#FBF0D8', '#8A6D1F')}>unreached</span>}
                  </span>
                </div>
              );
            })}
            <div style={{
              position: 'absolute', left: layout.endPos.x, top: layout.endPos.y, width: NW, height: NH,
              background: '#EAF7EF', border: '1px solid #BFE6CD', borderLeft: '4px solid var(--green)', borderRadius: 9, padding: '8px 10px',
              display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, zIndex: 2,
            }}>
              <span style={{ fontSize: 'calc(11.5px * var(--fs))', fontWeight: 700, color: 'var(--green)' }}>✓ End → Vitals</span>
              <span style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>patient continues to vitals</span>
            </div>
          </div>
        </div>
      )}
      <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Click any question to edit it. Base intake questions run first (in order) and are not shown here — this maps the department’s branching only.</p>
    </div>
  );
}

function QuestionsManager({ depts = [], initialDept = null }) {
  // initialDept lets a ticket deep-link jump straight to the right department.
  const [dept, setDept] = useState(initialDept || 'CARD');
  const [questions, setQuestions] = useState([]);
  const [editing, setEditing] = useState(null); // null = nothing selected
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preview, setPreview] = useState(null); // null = off; else { currentId, path, triage }
  const [showMap, setShowMap] = useState(false); // read-only flow-map view
  const [showBulk, setShowBulk] = useState(false); // "add several" paste-a-list view
  const [bulkText, setBulkText] = useState('');
  const [bulkType, setBulkType] = useState('FREE_TEXT');
  const [hasDraft, setHasDraft] = useState(false); // department has unpublished edits
  const [publishing, setPublishing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  useEffect(() => { loadQuestions(); }, [dept]);
  useEffect(() => {
    const active = depts.filter(d => d.is_active);
    if (active.length && !active.some(d => d.code === dept)) setDept(active[0].code);
  }, [depts]);

  async function loadQuestions() {
    // TERMINAL nodes are vestigial DAG sinks (the real "done" is the patient page).
    try {
      const resp = await api.getQuestions(dept);
      // Endpoint returns { questions, has_draft }; tolerate a bare array too.
      const list = Array.isArray(resp) ? resp : (resp.questions || []);
      setQuestions(list.filter(q => q.q_type !== 'TERMINAL'));
      setHasDraft(Array.isArray(resp) ? false : !!resp.has_draft);
    } catch { setQuestions([]); setHasDraft(false); }
  }

  async function handlePublish() {
    if (!(await confirm({
      title: `Publish ${depts.find(d => d.code === dept)?.name || dept} questionnaire?`,
      message: 'Your changes go live for the next patient in this department. This replaces the currently published questions.',
      confirmLabel: 'Publish',
    }))) return;
    setPublishing(true);
    try { await api.publishQuestions(dept); await loadQuestions(); toast('Published — changes are now live.', 'success'); }
    catch (err) { toast('Publish failed: ' + err.message, 'error'); }
    finally { setPublishing(false); }
  }
  async function handleDiscard() {
    if (!(await confirm({
      title: 'Discard unpublished changes?',
      message: 'Your draft edits for this department are thrown away and the editor reverts to what patients currently see. This cannot be undone.',
      confirmLabel: 'Discard', danger: true,
    }))) return;
    setPublishing(true);
    try { await api.discardDraft(dept); setEditing(null); setPreview(null); setShowMap(false); setShowBulk(false); await loadQuestions(); toast('Draft discarded.', 'success'); }
    catch (err) { toast('Discard failed: ' + err.message, 'error'); }
    finally { setPublishing(false); }
  }

  const isNew = editing && !questions.find(q => q.id === editing.id);
  const health = qComputeHealth(questions);
  const totalIssues = Object.values(health).reduce((n, arr) => n + arr.length, 0);
  const baseQs = questions.filter(q => q.is_base);
  const dagQs = questions.filter(q => !q.is_base);
  const targetQuestions = dagQs.filter(q => q.q_type !== 'TERMINAL' && q.id !== editing?.id);

  function startNew() {
    const maxSort = questions.reduce((m, q) => Math.max(m, q.sort_order || 0), 0);
    setEditing({ ...EMPTY_Q, department: dept, sort_order: maxSort + 1 });
    setPreview(null); setShowMap(false); setShowBulk(false); setShowAdvanced(false); setError(''); setSuccess('');
  }
  function startEdit(q) {
    setPreview(null); setShowMap(false); setShowBulk(false);
    setEditing({ ...EMPTY_Q, ...q, triage_flag: q.triage_flag || '', triage_answer: q.triage_answer || '',
      answer_triage: { ...qUrgencyMap(q) },
      next_default: q.next_default || '', next_rules: q.next_rules || [], options_json: q.options_json || null });
    setShowAdvanced(false); setError(''); setSuccess('');
  }
  // The department question that currently ends the flow with no routing set — the
  // natural place to append the next question so a plain list auto-chains in order.
  // Returns null if the last question already branches or points somewhere (we never
  // clobber deliberate routing).
  function openChainEnd() {
    const top = [...dagQs].filter(q => q.q_type !== 'TERMINAL')
      .sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0))[0];
    if (!top) return null;
    const isOpen = !top.next_default && !(top.next_rules && top.next_rules.length);
    return isOpen ? top : null;
  }

  // per-answer branch (writes editing.next_rules) and urgency (writes triage_*)
  function branchValueFor(ans) {
    const rule = (editing.next_rules || []).find(r => r.if_answer === ans);
    if (!rule) return '__DEFAULT__';
    return (rule.go_to == null || rule.go_to === '') ? '__END__' : rule.go_to;
  }
  function setBranchFor(ans, picked) {
    setEditing(prev => {
      const rules = (prev.next_rules || []).filter(r => r.if_answer !== ans);
      if (picked === '__END__') rules.push({ if_answer: ans, go_to: null });
      else if (picked !== '__DEFAULT__') rules.push({ if_answer: ans, go_to: picked });
      return { ...prev, next_rules: rules };
    });
  }
  function urgencyFor(ans) { return (editing.answer_triage || {})[ans] || ''; }
  function setUrgencyFor(ans, flag) {
    setEditing(prev => {
      const map = { ...(prev.answer_triage || {}) };
      if (flag) map[ans] = flag; else delete map[ans];
      return { ...prev, answer_triage: map };
    });
  }

  // answer-label editing (SELECT types)
  function addOption() {
    setEditing(prev => ({ ...prev, options_json: [...(prev.options_json || []), { value: '', label_en: '', label_hi: '', label_te: '' }] }));
  }
  function removeOption(idx) {
    setEditing(prev => {
      const opt = (prev.options_json || [])[idx];
      const map = { ...(prev.answer_triage || {}) };
      if (opt) delete map[opt.value];
      return {
        ...prev,
        options_json: (prev.options_json || []).filter((_, i) => i !== idx),
        next_rules: (prev.next_rules || []).filter(r => r.if_answer !== opt?.value),
        answer_triage: map,
      };
    });
  }
  function updateOption(idx, field, val) {
    setEditing(prev => {
      const opts = [...(prev.options_json || [])];
      const o = { ...opts[idx], [field]: val };
      if (field === 'label_en' && !opts[idx].value) o.value = qSlugify(val); // auto machine-value while blank
      opts[idx] = o;
      return { ...prev, options_json: opts };
    });
  }

  async function moveBase(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= baseQs.length) return;
    const a = baseQs[idx], b = baseQs[j];
    try {
      await api.reorderQuestions([{ id: a.id, sort_order: b.sort_order }, { id: b.id, sort_order: a.sort_order }]);
      loadQuestions();
    } catch (err) { toast('Reorder failed: ' + err.message, 'error'); }
  }

  // ---- read-only "Preview flow" simulator (walks the department DAG) ----
  function startPreview() {
    const entry = [...dagQs].filter(q => q.q_type !== 'TERMINAL')
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
    setEditing(null); setShowMap(false); setShowBulk(false);
    setPreview({ currentId: entry ? entry.id : null, path: [], triage: '' });
  }
  // "Add several" — paste one question per line; create them all pre-chained in
  // order, and continue the existing flow into the first of the batch. Engine and
  // API are untouched; this just scripts the same create/link calls a human would.
  function startBulk() {
    setEditing(null); setPreview(null); setShowMap(false);
    setBulkText(''); setBulkType('FREE_TEXT'); setError(''); setSuccess(''); setShowBulk(true);
  }
  async function handleBulkCreate() {
    const lines = bulkText.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) { setError('Type at least one question, one per line.'); return; }
    setError(''); setSuccess(''); setSaving(true);
    try {
      const maxSort = questions.reduce((m, q) => Math.max(m, q.sort_order || 0), 0);
      const prevEnd = openChainEnd();
      // Create bottom-up so each question already knows the id of the one after it.
      let nextId = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const created = await api.createQuestion({
          department: dept, text_en: lines[i], text_hi: null, text_te: null,
          q_type: bulkType, options_json: null, required: true,
          triage_flag: null, triage_answer: null, answer_triage: null,
          next_default: nextId, next_rules: null,
          sort_order: maxSort + 1 + i, is_base: false,
        });
        nextId = created.id;
      }
      if (prevEnd && nextId) await api.updateQuestion(prevEnd.id, { next_default: nextId });
      setShowBulk(false);
      await loadQuestions();
      toast(`Added ${lines.length} question${lines.length === 1 ? '' : 's'}${prevEnd ? `, continuing after “${qShort(prevEnd.text_en, 24)}”` : ''}.`, 'success');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  function previewAnswer(node, opt) {
    const flag = qUrgencyMap(node)[opt.value] || '';
    const nextId = qResolveNext(node, opt.value);
    setPreview(prev => ({
      currentId: nextId,
      path: [...prev.path, { q: node.text_en, a: opt.label_en, flag }],
      triage: qEscalate(prev.triage, flag),
    }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!editing.text_en) { setError('Question text (English) is required'); return; }
    setSaving(true);
    try {
      const sel = qIsSelect(editing.q_type);
      const canTriage = editing.q_type === 'BOOLEAN' || editing.q_type === 'SINGLE_SELECT';
      const triageMap = canTriage
        ? Object.fromEntries(Object.entries(editing.answer_triage || {}).filter(([, f]) => f))
        : {};
      const payload = {
        id: editing.id || undefined,
        department: editing.department || dept,
        text_en: editing.text_en, text_hi: editing.text_hi || null, text_te: editing.text_te || null,
        q_type: editing.q_type,
        options_json: sel && editing.options_json?.length ? editing.options_json : null,
        required: editing.required !== false,
        triage_flag: null, triage_answer: null,
        answer_triage: Object.keys(triageMap).length ? triageMap : null,
        next_default: editing.next_default || null,
        next_rules: editing.next_rules?.length ? editing.next_rules : null,
        sort_order: editing.sort_order || 0, is_base: editing.is_base === true,
      };
      if (isNew) {
        const created = await api.createQuestion(payload);
        // Auto-chain: if this is a plain department question appended at the end,
        // continue the flow into it from whatever currently ends the flow — so
        // building a list needs no manual "continue to" wiring. Deliberate routing
        // (a branch or an explicit default on the last question) is never touched.
        let linkedAfter = '';
        if (created && !payload.is_base) {
          const maxSort = dagQs.reduce((m, q) => Math.max(m, q.sort_order || 0), 0);
          const prevEnd = openChainEnd();
          if (prevEnd && prevEnd.id !== created.id && (payload.sort_order || 0) >= maxSort) {
            try { await api.updateQuestion(prevEnd.id, { next_default: created.id }); linkedAfter = prevEnd.text_en; } catch { /* leave unlinked; flow-check flags it */ }
          }
        }
        setSuccess(linkedAfter ? `Question added — continues after “${qShort(linkedAfter, 24)}”` : 'Question added');
        await loadQuestions();
        if (created) setEditing({ ...EMPTY_Q, ...created, next_rules: created.next_rules || [] });
      } else {
        await api.updateQuestion(editing.id, payload);
        setSuccess('Saved');
        loadQuestions();
      }
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function handleDelete(id) {
    if (!(await confirm({
      title: 'Delete this question?',
      message: 'Any branches pointing to it will need re-pointing. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    try { await api.deleteQuestion(id); if (editing?.id === id) setEditing(null); loadQuestions(); }
    catch (err) { toast('Failed: ' + err.message, 'error'); }
  }

  function renderBaseEditor() {
    return (
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <QEditorHeader title="Shared intake question" onClose={() => setEditing(null)} />
        <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', background: '#FAF8FD', border: '1px solid #E7DFF3', borderRadius: 8, padding: '8px 10px' }}>
          This is one of the fixed intake questions asked in every department. You can reword it and its translations; order is set with ↑ ↓ in the list. These run one after another — no branching or urgency here.
        </div>
        <QTextFields editing={editing} setEditing={setEditing} />
        {error && <p style={qErr}>{error}</p>}
        {success && <p style={qOk}>{success}</p>}
        <div><button className="btn btn-primary" type="submit" disabled={saving} style={{ width: 'auto', padding: '0 20px' }}>{saving ? 'Saving…' : 'Save wording'}</button></div>
      </form>
    );
  }

  function renderDagEditor() {
    const sel = qIsSelect(editing.q_type);
    const showAnswers = sel || editing.q_type === 'BOOLEAN';
    const showBranch = qHasBranch(editing.q_type);
    const answers = qAnswerOptions(editing);
    return (
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <QEditorHeader title={isNew ? 'New question' : 'Edit question'} onClose={() => setEditing(null)} />
        <QTextFields editing={editing} setEditing={setEditing} />

        <div>
          <label style={qLbl}>How does the patient answer?</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Q_TYPE_ORDER.map(t => (
              <button type="button" key={t} onClick={() => setEditing(prev => ({ ...prev, q_type: t }))} style={qChip(editing.q_type === t)}>{Q_TYPE_LABELS[t]}</button>
            ))}
          </div>
        </div>

        {showAnswers && (
          <div style={qPanel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <label style={{ fontSize: 'calc(12px * var(--fs))', fontWeight: 700 }}>When the patient answers…</label>
              {sel && <button type="button" onClick={addOption} style={qMiniBtn}>+ Add answer</button>}
            </div>
            {answers.length === 0 && <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Add at least one answer.</p>}
            {answers.map((opt, i) => (
              <div key={i} style={{ borderTop: i ? '1px solid #ECECEC' : 'none', paddingTop: i ? 8 : 0, marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {sel ? (
                    <>
                      <input className="input" style={{ flex: '1 1 130px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={opt.label_en} placeholder="Answer (English)" onChange={e => updateOption(i, 'label_en', e.target.value)} />
                      <input className="input" style={{ flex: '1 1 80px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={opt.label_hi || ''} placeholder="Hindi" onChange={e => updateOption(i, 'label_hi', e.target.value)} />
                      <input className="input" style={{ flex: '1 1 80px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={opt.label_te || ''} placeholder="Telugu" onChange={e => updateOption(i, 'label_te', e.target.value)} />
                      <button type="button" onClick={() => removeOption(i)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(16px * var(--fs))' }}>✕</button>
                    </>
                  ) : (
                    <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--fs))', minWidth: 44 }}>{opt.label_en}</span>
                  )}
                </div>
                {showBranch && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>urgency</span>
                    <select className="input" style={{ width: 128, minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={urgencyFor(opt.value)} onChange={e => setUrgencyFor(opt.value, e.target.value)}>
                      <option value="">— none —</option>
                      <option value="AMBER">🟡 Amber</option>
                      <option value="RED">🔴 Red</option>
                    </select>
                    <span style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>→ then ask</span>
                    <div style={{ flex: '1 1 170px' }}>
                      <QTargetPicker mode="branch" value={branchValueFor(opt.value)} targets={targetQuestions} onChange={v => setBranchFor(opt.value, v)} />
                    </div>
                  </div>
                )}
              </div>
            ))}
            {showBranch && <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)', marginTop: 2 }}>Each answer can carry its own urgency; the most urgent one triggered during intake wins.</p>}
          </div>
        )}

        <div>
          <label style={qLbl}>{showBranch ? 'If no branch above matches, go to' : 'After this question, go to'}</label>
          <QTargetPicker mode="default" value={editing.next_default || ''} targets={targetQuestions} onChange={v => setEditing(prev => ({ ...prev, next_default: v }))} />
        </div>

        <div>
          <button type="button" onClick={() => setShowAdvanced(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', padding: 0 }}>{showAdvanced ? '▾' : '▸'} Advanced</button>
          {showAdvanced && (
            <div style={{ ...qPanel, marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px' }}>
                <label style={qLbl}>Question ID (auto-generated)</label>
                <input className="input" value={editing.id} disabled={!isNew} placeholder="(made from the text on save)" onChange={e => setEditing(prev => ({ ...prev, id: e.target.value }))} />
              </div>
              <div style={{ width: 100 }}>
                <label style={qLbl}>Order</label>
                <input className="input" type="number" value={editing.sort_order} onChange={e => setEditing(prev => ({ ...prev, sort_order: parseInt(e.target.value) || 0 }))} />
              </div>
              <div style={{ width: 120 }}>
                <label style={qLbl}>Required</label>
                <select className="input" value={editing.required ? 'true' : 'false'} onChange={e => setEditing(prev => ({ ...prev, required: e.target.value === 'true' }))}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {error && <p style={qErr}>{error}</p>}
        {success && <p style={qOk}>{success}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? 'Saving…' : 'Save question'}</button>
          {!isNew && <button type="button" className="btn btn-outline" onClick={() => handleDelete(editing.id)} style={{ borderColor: 'var(--red)', color: 'var(--red)', width: 'auto', padding: '0 16px' }}>Delete</button>}
        </div>
      </form>
    );
  }

  function renderBulkAdd() {
    const lines = bulkText.split('\n').map(s => s.trim()).filter(Boolean);
    const prevEnd = openChainEnd();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Add several questions</h3>
          <button type="button" onClick={() => setShowBulk(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
        </div>
        <p style={{ fontSize: 'calc(12.5px * var(--fs))', color: 'var(--text-light)', lineHeight: 1.5 }}>
          Type one question per line. They’re created in order and automatically chained
          — each one continues to the next{prevEnd ? <>, starting right after “<strong>{qShort(prevEnd.text_en, 34)}</strong>”</> : ' (the first becomes the department’s starting question)'}.
          Add branching (Yes → go here) afterwards on any question that needs it.
        </p>
        <div style={{ width: 200 }}>
          <label style={qLbl}>Answer type for all</label>
          <select className="input" value={bulkType} onChange={e => setBulkType(e.target.value)}>
            <option value="FREE_TEXT">Free text</option>
            <option value="BOOLEAN">Yes / No</option>
            <option value="NUMERIC">Number</option>
          </select>
        </div>
        <div>
          <label style={qLbl}>Questions (one per line)</label>
          <textarea className="input" rows={9} value={bulkText} onChange={e => setBulkText(e.target.value)}
            placeholder={"Do you have a fever?\nHow many days have you had it?\nAre you taking any medication for it?"}
            style={{ resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
        </div>
        {error && <p style={qErr}>{error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '0 16px', minHeight: 38 }}
            disabled={saving || !lines.length} onClick={handleBulkCreate}>
            {saving ? 'Adding…' : `Add ${lines.length || ''} question${lines.length === 1 ? '' : 's'}`.trim()}
          </button>
          <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '0 14px', minHeight: 38 }} onClick={() => setShowBulk(false)}>Cancel</button>
          <span style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>You can edit each one’s wording, type and branches after.</span>
        </div>
      </div>
    );
  }

  function renderPreview() {
    const node = preview.currentId ? questions.find(q => q.id === preview.currentId && !q.is_base) : null;
    const opts = node ? qAnswerOptions(node) : [];
    const urg = f => f && <span style={qBadge(f === 'RED' ? 'var(--red)' : 'var(--amber)', f === 'RED' ? '#fff' : 'var(--amber-on)')}>{f === 'RED' ? '🔴' : '🟡'} {f}</span>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Preview flow — {depts.find(d => d.code === dept)?.name || dept}</h3>
          <button type="button" onClick={startPreview} style={qMiniBtn}>Restart</button>
          <button type="button" onClick={() => setPreview(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
        </div>
        <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', display: 'flex', alignItems: 'center', gap: 6 }}>
          Running urgency: {preview.triage ? urg(preview.triage) : <span style={{ color: 'var(--green)' }}>none yet</span>}
        </div>
        {preview.path.length > 0 && (
          <div style={qPanel}>
            {preview.path.map((s, i) => (
              <div key={i} style={{ fontSize: 'calc(12px * var(--fs))', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-light)' }}>{i + 1}.</span> {s.q} → <strong>{s.a}</strong> {s.flag ? urg(s.flag) : null}
              </div>
            ))}
          </div>
        )}
        {!node ? (
          <div style={{ padding: 16, borderRadius: 8, background: '#EAF7EF', color: 'var(--green)', fontSize: 'calc(13px * var(--fs))' }}>
            ✓ End of department questions — the patient continues to Vitals.
            {preview.triage && <div style={{ marginTop: 6, color: 'var(--text)' }}>Final urgency from this path: {urg(preview.triage)}</div>}
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 'calc(15px * var(--fs))', fontWeight: 600, marginBottom: 10 }}>{node.text_en}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {opts.length > 0 ? opts.map((o, i) => (
                <button key={i} type="button" onClick={() => previewAnswer(node, o)}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid #D0D0D0', background: '#fff', cursor: 'pointer', fontSize: 'calc(13px * var(--fs))', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {o.label_en || o.value} {qUrgencyMap(node)[o.value] ? urg(qUrgencyMap(node)[o.value]) : null}
                </button>
              )) : (
                <button type="button" onClick={() => previewAnswer(node, { value: '__any__', label_en: '(any answer)' })}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid #D0D0D0', background: '#fff', cursor: 'pointer', fontSize: 'calc(13px * var(--fs))' }}>
                  Continue →
                </button>
              )}
            </div>
          </div>
        )}
        <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' }}>Base intake questions run first (in order); this previews the department’s branching path only.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {dialog}{toastView}
      <div style={{ width: 400, flexShrink: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <select className="input" style={{ width: '100%' }} value={dept} onChange={e => setDept(e.target.value)}>
            {depts.filter(d => d.is_active).map(d => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 36, width: 'auto', padding: '0 14px' }} onClick={startNew}>+ Add question</button>
            <button className="btn btn-outline" style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 36, width: 'auto', padding: '0 12px' }} onClick={startBulk} title="Paste a list of questions and add them all at once, already chained in order">+ Add several</button>
            <button className="btn btn-outline" style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 36, width: 'auto', padding: '0 12px' }} onClick={startPreview} disabled={!dagQs.length} title="Walk the branching as a patient would">▶ Preview</button>
            <button className="btn btn-outline" style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 36, width: 'auto', padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setEditing(null); setPreview(null); setShowBulk(false); setShowMap(true); }} disabled={!dagQs.length} title="See the whole branching flow as a diagram"><QGraphIcon /> Map</button>
          </div>
        </div>

        {hasDraft ? (
          <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#FDF3E2', border: '1px solid #F0D9A8' }}>
            <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--amber-on)', fontWeight: 600, marginBottom: 6 }}>
              ● Unpublished changes — patients still see the last published version.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary" style={{ fontSize: 'calc(12px * var(--fs))', minHeight: 32, width: 'auto', padding: '0 14px' }}
                disabled={publishing} onClick={handlePublish}>{publishing ? 'Publishing…' : 'Publish'}</button>
              <button className="btn btn-outline" style={{ fontSize: 'calc(12px * var(--fs))', minHeight: 32, width: 'auto', padding: '0 12px' }}
                disabled={publishing} onClick={handleDiscard}>Discard changes</button>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 'calc(11px * var(--fs))', marginBottom: 8, padding: '5px 10px', borderRadius: 8, background: '#EAF7EF', color: 'var(--green)' }}>
            ✓ Published — no unpublished changes. Edits are saved as a draft and go live when you Publish.
          </div>
        )}

        <div style={{ fontSize: 'calc(12px * var(--fs))', marginBottom: 8, padding: '6px 10px', borderRadius: 8,
          background: totalIssues ? '#FDF3E2' : '#EAF7EF', color: totalIssues ? 'var(--amber-on)' : 'var(--green)' }}>
          {totalIssues ? `⚠ Flow check: ${totalIssues} thing${totalIssues === 1 ? '' : 's'} to review below` : '✓ Flow check: no issues'}
        </div>

        <div style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto', paddingRight: 6 }}>
          {baseQs.length > 0 && <p style={qSectionLabel}>Shared intake · reorder with ↑ ↓</p>}
          {baseQs.map((q, i) => (
            <QRow key={q.id} q={q} selected={editing?.id === q.id} issues={health[q.id] || []} onClick={() => startEdit(q)}
              reorder={<>
                <button type="button" title="Move up" disabled={i === 0} onClick={e => { e.stopPropagation(); moveBase(i, -1); }} style={qArrowBtn(i === 0)}>↑</button>
                <button type="button" title="Move down" disabled={i === baseQs.length - 1} onClick={e => { e.stopPropagation(); moveBase(i, 1); }} style={qArrowBtn(i === baseQs.length - 1)}>↓</button>
              </>} />
          ))}
          {dagQs.length > 0 && <p style={{ ...qSectionLabel, marginTop: 12 }}>Department questions · branching</p>}
          {dagQs.map(q => (
            <QRow key={q.id} q={q} selected={editing?.id === q.id} issues={health[q.id] || []} onClick={() => startEdit(q)} />
          ))}
          {questions.length === 0 && <p style={{ color: 'var(--text-light)', fontSize: 'calc(12px * var(--fs))', padding: 8 }}>No questions yet. Click “+ Add question”.</p>}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        {showMap ? <QFlowMap questions={questions} deptName={depts.find(d => d.code === dept)?.name || dept} health={health} onPick={startEdit} onClose={() => setShowMap(false)} />
          : showBulk ? renderBulkAdd()
          : preview ? renderPreview()
          : !editing ? <p style={{ color: 'var(--text-light)', textAlign: 'center', marginTop: 40 }}>Select a question to edit, or click “+ Add question”.</p>
          : editing.is_base ? renderBaseEditor() : renderDagEditor()}
      </div>
    </div>
  );
}


// Doctor-raised tickets about the AI summaries / questionnaires. The doctor flags a
// systemic issue from their dashboard; HIS reviews here, and can jump straight to the
// relevant department's questionnaire (which now stages edits as a draft to publish).
const TICKET_CATEGORY_LABELS = {
  missing_question: 'Missing question',
  wrong_extraction: 'Wrong extraction',
  prompt_issue: 'Summary/prompt issue',
  triage_concern: 'Triage concern',
  other: 'Other',
};
function fmtTicketDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function TicketsManager({ onOpenQuestionnaire }) {
  const [tickets, setTickets] = useState([]);
  const [filter, setFilter] = useState('open'); // open | triaged | resolved | all
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [resolveNote, setResolveNote] = useState('');
  const { toast, toastView } = useToast();

  useEffect(() => { loadTickets(); /* eslint-disable-next-line */ }, [filter]);

  async function loadTickets() {
    setLoading(true);
    try {
      const resp = await api.getTickets(filter === 'all' ? '' : filter);
      setTickets(Array.isArray(resp?.data) ? resp.data : []);
    } catch { setTickets([]); }
    finally { setLoading(false); }
  }

  async function setStatus(id, status, resolution) {
    setBusyId(id);
    try {
      await api.updateTicket(id, { status, ...(resolution !== undefined ? { resolution } : {}) });
      setResolvingId(null); setResolveNote('');
      await loadTickets();
      toast(status === 'resolved' ? 'Ticket resolved.' : 'Ticket updated.', 'success');
    } catch (err) { toast('Update failed: ' + err.message, 'error'); }
    finally { setBusyId(null); }
  }

  const statusColor = { open: 'var(--red)', triaged: 'var(--amber-on)', resolved: 'var(--green)' };

  return (
    <div style={{ maxWidth: 900 }}>
      {toastView}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)', marginRight: 8 }}>Tickets from doctors</h2>
        {[['open', 'Open'], ['triaged', 'Triaged'], ['resolved', 'Resolved'], ['all', 'All']].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`btn ${filter === id ? 'btn-primary' : 'btn-outline'}`}
            style={{ width: 'auto', padding: '0 12px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }}>{label}</button>
        ))}
      </div>

      <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 12 }}>
        Doctors raise these from a patient's report when something is a systemic questionnaire/AI problem (not just one patient).
      </p>

      {loading ? (
        <p style={{ color: 'var(--text-light)' }}>Loading…</p>
      ) : tickets.length === 0 ? (
        <div style={{ padding: 16, borderRadius: 10, background: '#EAF7EF', color: 'var(--green)', fontSize: 'calc(13px * var(--fs))' }}>
          ✓ No {filter === 'all' ? '' : filter} tickets.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tickets.map(t => (
            <div key={t.id} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', borderLeft: `4px solid ${statusColor[t.status] || 'var(--text-light)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 'calc(13px * var(--fs))' }}>{TICKET_CATEGORY_LABELS[t.category] || t.category}</span>
                {t.department && <span style={{ fontSize: 'calc(11px * var(--fs))', background: '#EEF2F6', borderRadius: 4, padding: '2px 8px' }}>{t.department}</span>}
                <span style={{ fontSize: 'calc(11px * var(--fs))', textTransform: 'uppercase', fontWeight: 700, color: statusColor[t.status] || 'var(--text-light)' }}>{t.status}</span>
                <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{fmtTicketDate(t.created_at)}</span>
              </div>
              <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: t.note ? 6 : 0 }}>
                {t.patient_name ? `Patient: ${t.patient_name} · ` : ''}Raised by {t.raised_by_name || 'a doctor'}
              </div>
              {t.note && <p style={{ fontSize: 'calc(13px * var(--fs))', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{t.note}</p>}
              {t.status === 'resolved' && (t.resolution || t.resolved_by) && (
                <div style={{ fontSize: 'calc(12px * var(--fs))', background: '#EAF7EF', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                  <strong>Resolved{t.resolved_by ? ` by ${t.resolved_by}` : ''}:</strong> {t.resolution || '—'}
                </div>
              )}

              {resolvingId === t.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea className="input" rows={2} value={resolveNote} onChange={e => setResolveNote(e.target.value)}
                    placeholder="What was done (optional)" style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 'calc(12px * var(--fs))' }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" style={{ width: 'auto', padding: '0 14px', minHeight: 32 }} disabled={busyId === t.id}
                      onClick={() => setStatus(t.id, 'resolved', resolveNote)}>Confirm resolve</button>
                    <button className="btn btn-outline" style={{ width: 'auto', padding: '0 12px', minHeight: 32 }}
                      onClick={() => { setResolvingId(null); setResolveNote(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {t.department && (
                    <button className="btn btn-outline" style={{ width: 'auto', padding: '0 12px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }}
                      onClick={() => onOpenQuestionnaire && onOpenQuestionnaire(t.department)}>Open questionnaire →</button>
                  )}
                  {t.status === 'open' && (
                    <button className="btn btn-outline" style={{ width: 'auto', padding: '0 12px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }}
                      disabled={busyId === t.id} onClick={() => setStatus(t.id, 'triaged')}>Mark triaged</button>
                  )}
                  {t.status !== 'resolved' && (
                    <button className="btn btn-primary" style={{ width: 'auto', padding: '0 12px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }}
                      disabled={busyId === t.id} onClick={() => { setResolvingId(t.id); setResolveNote(''); }}>Resolve</button>
                  )}
                  {t.status === 'resolved' && (
                    <button className="btn btn-outline" style={{ width: 'auto', padding: '0 12px', minHeight: 32, fontSize: 'calc(12px * var(--fs))' }}
                      disabled={busyId === t.id} onClick={() => setStatus(t.id, 'open')}>Reopen</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// Common department icons offered in the picker modal (admins can also type any
// emoji). Mirrors the patient-side fallback set.
const ICON_CHOICES = ['🫀', '🩺', '🦴', '👂', '👁️', '🧴', '🧒', '🤰', '🧠', '🦷', '🧑‍⚕️', '🫁', '🩸', '💉', '🩹', '🦻', '🦶', '🫄', '🧬', '🥼', '🚑', '🏥'];

function DepartmentsManager({ depts, onChange }) {
  const [form, setForm] = useState({ code: '', name: '', collect_vitals: true, icon: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Icon-picker modal: the department being edited + the pending emoji value.
  const [iconEdit, setIconEdit] = useState(null);
  const [iconValue, setIconValue] = useState('');
  const [iconSaving, setIconSaving] = useState(false);
  // Report-focus modal: the department being edited + the pending focus text.
  const [focusEdit, setFocusEdit] = useState(null);
  const [focusValue, setFocusValue] = useState('');
  const [focusSaving, setFocusSaving] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!form.code || !form.name) { setError('Code and name required'); return; }
    setSaving(true);
    try {
      const created = await api.createDepartment(form);
      setSuccess(`Department "${created.name}" (${created.code}) added`);
      setForm({ code: '', name: '', collect_vitals: true, icon: '' });
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Flip a department's "collect vitals" toggle. When off, the patient flow skips
  // the vitals step and the done page hides the vitals tile for that department.
  async function handleToggleVitals(d) {
    try {
      await api.updateDepartment(d.code, { collect_vitals: !d.collect_vitals });
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Open the icon-picker modal for a department (see the modal near the bottom of
  // this component). Blank clears the icon → frontend falls back to an auto icon.
  function handleEditIcon(d) {
    setIconValue(d.icon || '');
    setIconEdit(d);
  }
  async function saveIcon(override) {
    if (!iconEdit) return;
    const next = (override !== undefined ? override : iconValue).trim();
    setIconSaving(true);
    try {
      await api.updateDepartment(iconEdit.code, { icon: next });
      setIconEdit(null);
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setIconSaving(false);
    }
  }

  // Open the report-focus editor for a department (see the modal below). Blank
  // clears it → the report LLM uses the base prompt unchanged for this department.
  function handleEditFocus(d) {
    setFocusValue(d.report_focus || '');
    setFocusEdit(d);
  }
  async function saveFocus() {
    if (!focusEdit) return;
    setFocusSaving(true);
    try {
      await api.updateDepartment(focusEdit.code, { report_focus: focusValue.trim() });
      setFocusEdit(null);
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setFocusSaving(false);
    }
  }

  // Hide a department from the patient picker without destroying anything. The
  // reversible option, and the right one in almost every case — a department with
  // patient visits cannot be deleted at all, only deactivated.
  async function handleToggleActive(d) {
    try {
      await api.updateDepartment(d.code, { is_active: !d.is_active });
      toast(d.is_active ? `"${d.code}" deactivated — hidden from patients` : `"${d.code}" reactivated`, 'success');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function handleDelete(code) {
    let impact;
    try {
      impact = await api.departmentImpact(code);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    // Patient visits are clinical records — never collateral damage of a config
    // change. Say so plainly and point at the reversible option instead of letting
    // the admin type the code and then hit a 409.
    if (!impact.deletable) {
      await confirm({
        title: `"${code}" cannot be deleted`,
        icon: '🛑',
        message: `${impact.sessions} patient visit${impact.sessions === 1 ? '' : 's'} reference this department, and deleting it would strand those records. `
               + `Deactivate it instead — it disappears from the patient picker immediately, every visit stays intact, and you can reactivate it any time.`,
        confirmLabel: 'Got it',
        hideCancel: true,
        danger: true,
      });
      return;
    }

    const losses = [
      impact.questions > 0 && `${impact.questions} questionnaire question${impact.questions === 1 ? '' : 's'} will be permanently deleted`,
      impact.doctors > 0 && `${impact.doctors} doctor${impact.doctors === 1 ? ' will be' : 's will be'} deactivated and unable to log in (you can reactivate them into another department)`,
    ].filter(Boolean);

    if (!(await confirm({
      title: `Permanently delete "${code}"?`,
      icon: '⚠️',
      message: losses.length
        ? `This cannot be undone. ${losses.join('. ')}.`
        : 'This cannot be undone.',
      confirmText: code,
      confirmLabel: 'Delete this department',
      danger: true,
    }))) return;

    try {
      const r = await api.forceDeleteDepartment(code, code);
      const done = [
        r.questions_deleted > 0 && `${r.questions_deleted} question(s) deleted`,
        r.doctors_deactivated > 0 && `${r.doctors_deactivated} doctor(s) deactivated`,
      ].filter(Boolean);
      toast(`"${code}" deleted${done.length ? ` — ${done.join(', ')}` : ''}`, 'success');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {dialog}
      {toastView}

      {/* Icon picker modal — replaces the browser prompt with a tap-an-emoji grid. */}
      {iconEdit && (
        <Modal
          onClose={() => setIconEdit(null)}
          labelledBy="icon-picker-title"
          scrimStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }}
          panelStyle={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
            width: 430, maxWidth: '92vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <h3 id="icon-picker-title" style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Icon for {iconEdit.name}</h3>
              <button type="button" onClick={() => setIconEdit(null)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)', display: 'flex' }}>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
              </button>
            </div>
            <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 14 }}>
              Pick the icon patients see on the department picker, or type your own emoji.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 16 }}>
              {ICON_CHOICES.map(em => (
                <button key={em} onClick={() => setIconValue(em)} title={em}
                  style={{ fontSize: 'calc(24px * var(--fs))', padding: '8px 0', borderRadius: 10, cursor: 'pointer',
                    border: iconValue === em ? '2px solid var(--primary)' : '1px solid #E0E0E0',
                    background: iconValue === em ? '#EAF2F8' : '#fff' }}>
                  {em}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <div style={{ fontSize: 'calc(30px * var(--fs))', width: 52, height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #E0E0E0', borderRadius: 10 }}>
                {iconValue || '🏥'}
              </div>
              <input className="input" value={iconValue} maxLength={8} style={{ fontSize: 'calc(18px * var(--fs))' }}
                onChange={e => setIconValue(e.target.value)} placeholder="Custom emoji (blank = auto)" />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => saveIcon('')} disabled={iconSaving}>Clear (auto)</button>
              <button className="btn btn-primary" onClick={() => saveIcon()} disabled={iconSaving}>{iconSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Report-focus editor — specialty-specific emphasis appended to the report
          LLM prompt. Structure (headings, verbatim meds/allergies/vitals) is fixed;
          this only steers what the AI prioritises and how it words the interpretive
          sections. Blank = base prompt unchanged. */}
      {focusEdit && (
        <Modal
          onClose={() => setFocusEdit(null)}
          labelledBy="focus-editor-title"
          scrimStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }}
          panelStyle={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
            width: 560, maxWidth: '94vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <h3 id="focus-editor-title" style={{ fontSize: 'calc(18px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Report focus — {focusEdit.name}</h3>
              <button type="button" onClick={() => setFocusEdit(null)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-light)', display: 'flex' }}>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
              </button>
            </div>
            <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 12, lineHeight: 1.6 }}>
              Specialty-specific emphasis added to the AI report for this department — e.g. what symptoms to characterise
              and which prior findings to surface. It only steers <strong>wording and priority</strong>; it never changes the
              report’s sections and cannot make the AI invent information. Leave blank to use the standard report.
            </p>
            <textarea className="input" value={focusValue} rows={7} maxLength={2000}
              onChange={e => setFocusValue(e.target.value)}
              placeholder="e.g. Emphasise cardiovascular assessment: characterise chest pain (exertional vs rest, radiation), note cardiac risk factors, and surface prior ECG/echo findings in Past Medical History."
              style={{ resize: 'vertical', lineHeight: 1.5, fontSize: 'calc(13px * var(--fs))' }} />
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 16 }}>
              <span style={{ flex: 1, fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{focusValue.length}/2000</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" onClick={() => setFocusValue('')} disabled={focusSaving}>Clear</button>
                <button className="btn btn-primary" onClick={() => saveFocus()} disabled={focusSaving}>{focusSaving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Add form */}
      <div style={{ width: 360, flexShrink: 0, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', height: 'fit-content' }}>
        <h3 style={{ fontSize: 'calc(16px * var(--fs))', marginBottom: 16, color: 'var(--primary)' }}>Add New Department</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Code * (e.g. ORTHO, ENT, DERM)</label>
            <input className="input" required value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
              placeholder="ORTHO" maxLength={16} style={{ textTransform: 'uppercase' }} />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Display Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Orthopaedics" />
          </div>
          <div>
            <label style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Icon (emoji, optional)</label>
            <input className="input" value={form.icon}
              onChange={e => setForm({ ...form, icon: e.target.value })}
              placeholder="🦴" maxLength={8} style={{ fontSize: 'calc(18px * var(--fs))' }} />
            <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 4 }}>
              Shown to patients on the department picker. Leave blank for an automatic icon.
            </p>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--fs))', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.collect_vitals}
              onChange={e => setForm({ ...form, collect_vitals: e.target.checked })} />
            Collect vitals from patients
          </label>
          {error && <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))' }}>{error}</p>}
          {success && <p style={{ color: 'var(--green)', fontSize: 'calc(13px * var(--fs))' }}>{success}</p>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Adding...' : 'Add Department'}
          </button>
        </form>
        <div style={{ marginTop: 20, padding: 12, background: '#F8F9FA', borderRadius: 8, fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', lineHeight: 1.6 }}>
          <p><strong>After adding a department:</strong></p>
          <p>1. Set an <strong>icon</strong> so patients recognise it on the picker</p>
          <p>2. Go to <strong>Questionnaires</strong> tab to add questions for it</p>
          <p>3. Go to <strong>Manage Doctors</strong> tab to assign doctors to it</p>
          <p style={{ marginTop: 6 }}>Patients reach every department through the single hospital QR — no per-department QR needed.</p>
        </div>
      </div>

      {/* Department list */}
      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: 'calc(16px * var(--fs))', marginBottom: 12, color: 'var(--primary)' }}>Departments ({depts.length})</h3>
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 220px)', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ background: 'var(--primary)', color: '#fff', fontSize: 'calc(13px * var(--fs))' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Icon</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Code</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Name</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Collect Vitals</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', position: 'sticky', top: 0, background: 'var(--primary)', zIndex: 1 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {depts.map(d => (
                <tr key={d.code} style={{ borderBottom: '1px solid #F0F0F0' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => handleEditIcon(d)} title="Set the icon patients see for this department"
                      style={{ background: 'none', border: '1px solid #E0E0E0', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(20px * var(--fs))', lineHeight: 1 }}>
                      {d.icon || '➕'}
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(14px * var(--fs))', fontWeight: 600 }}>{d.code}</td>
                  <td style={{ padding: '10px 12px', fontSize: 'calc(14px * var(--fs))' }}>{d.name}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => handleToggleVitals(d)}
                      title="Toggle whether patients in this department are asked for vitals"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 999, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', fontWeight: 600,
                        background: d.collect_vitals ? '#D5F5E3' : '#F8F9FA', color: d.collect_vitals ? '#1E8449' : 'var(--text-light)' }}>
                      <span style={{ fontSize: 'calc(14px * var(--fs))' }}>{d.collect_vitals ? '✅' : '⚪'}</span>
                      {d.collect_vitals ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => handleEditFocus(d)}
                        title="Specialty-specific emphasis for the AI report in this department"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', fontWeight: 600,
                          border: (d.report_focus && d.report_focus.trim()) ? '1px solid var(--primary)' : '1px solid #E0E0E0',
                          color: (d.report_focus && d.report_focus.trim()) ? 'var(--primary)' : 'var(--text-light)' }}>
                        {(d.report_focus && d.report_focus.trim()) ? '📝 Report focus' : '＋ Report focus'}
                      </button>
                      <button onClick={() => handleToggleActive(d)}
                        title={d.is_active
                          ? 'Hide from the patient department picker. Nothing is deleted; reversible.'
                          : 'Show in the patient department picker again.'}
                        style={{ background: 'none', border: '1px solid #E0E0E0', color: 'var(--text-light)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
                        {d.is_active ? '🚫 Deactivate' : '✅ Reactivate'}
                      </button>
                      <button onClick={() => handleDelete(d.code)}
                        title="Permanently delete this department. Blocked while any patient visit references it."
                        style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))' }}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
        </div>
        {depts.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 32 }}>No departments yet</p>
        )}
      </div>
    </div>
  );
}


function ProtocolsManager({ depts = [] }) {
  const [dept, setDept] = useState(depts[0]?.code || 'CARD');
  const [protocols, setProtocols] = useState([]);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  useEffect(() => { loadProtocols(); }, [dept]);

  async function loadProtocols() {
    try { setProtocols(await api.getProtocols(dept)); } catch {}
  }

  const EMPTY = {
    id: '', name: '', department: dept,
    trigger_conditions: {}, trigger_medications: [],
    required_tests: [], required_vitals: [],
    pre_visit_msg_en: '', pre_visit_msg_hi: '', pre_visit_msg_te: '',
    authored_by: '', version: '1.0',
  };

  function startNew() {
    setEditing({ ...EMPTY, department: dept });
    setError(''); setSuccess('');
  }

  function startEdit(p) {
    setEditing({
      ...p,
      trigger_conditions: p.trigger_conditions || {},
      trigger_medications: p.trigger_medications || [],
      required_tests: p.required_tests || [],
      required_vitals: p.required_vitals || [],
    });
    setError(''); setSuccess('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!editing.id || !editing.name) { setError('ID and name required'); return; }

    setSaving(true);
    try {
      const existing = protocols.find(p => p.id === editing.id);
      if (existing) {
        await api.updateProtocol(editing.id, editing);
        setSuccess('Protocol updated');
      } else {
        await api.createProtocol(editing);
        setSuccess('Protocol created');
      }
      loadProtocols();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!(await confirm({
      title: `Deactivate protocol "${id}"?`,
      message: 'It will no longer be evaluated during patient intake.',
      confirmLabel: 'Deactivate',
      danger: true,
    }))) return;
    try {
      await api.deleteProtocol(id);
      loadProtocols();
      if (editing?.id === id) setEditing(null);
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  }

  // Helpers for array fields
  function updateList(field, value) {
    setEditing(prev => ({ ...prev, [field]: value.split(',').map(s => s.trim()).filter(Boolean) }));
  }

  // Helpers for trigger_conditions (key-value pairs)
  function setCondition(key, val) {
    setEditing(prev => ({ ...prev, trigger_conditions: { ...prev.trigger_conditions, [key]: val } }));
  }
  function removeCondition(key) {
    setEditing(prev => {
      const c = { ...prev.trigger_conditions };
      delete c[key];
      return { ...prev, trigger_conditions: c };
    });
  }

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {dialog}
      {toastView}
      {/* Left: protocol list */}
      <div style={{ width: 380, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <select className="input" style={{ width: 160 }} value={dept} onChange={e => setDept(e.target.value)}>
            {depts.filter(d => d.is_active).map(d => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          <button className="btn btn-primary" style={{ fontSize: 'calc(13px * var(--fs))', minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={startNew}>+ Add Protocol</button>
        </div>

        <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 8 }}>{protocols.length} active protocols</p>

        <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 260px)', paddingRight: 4 }}>
        {protocols.map(p => (
          <div key={p.id} onClick={() => startEdit(p)}
            style={{
              background: editing?.id === p.id ? '#EBF5FB' : '#fff',
              border: editing?.id === p.id ? '2px solid var(--secondary)' : '1px solid #E0E0E0',
              borderRadius: 10, padding: 12, marginBottom: 6, cursor: 'pointer',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'calc(13px * var(--fs))', fontWeight: 600, flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 'calc(10px * var(--fs))', background: '#F0F0F0', padding: '2px 6px', borderRadius: 4 }}>v{p.version || '1.0'}</span>
            </div>
            <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 4 }}>ID: {p.id}</p>
            {p.required_vitals?.length > 0 && (
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--secondary)', marginTop: 2 }}>Vitals: {p.required_vitals.join(', ')}</p>
            )}
            {p.required_tests?.length > 0 && (
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--secondary)', marginTop: 2 }}>Tests: {p.required_tests.join(', ')}</p>
            )}
          </div>
        ))}
        </div>

        {protocols.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 32, fontSize: 'calc(13px * var(--fs))' }}>
            No protocols for this department. Click "+ Add Protocol" to create one.
          </p>
        )}
      </div>

      {/* Right: editor */}
      <div style={{ flex: 1, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        {!editing ? (
          <div style={{ color: 'var(--text-light)', textAlign: 'center', marginTop: 40 }}>
            <p>Select a protocol to edit, or click "+ Add Protocol"</p>
            <p style={{ fontSize: 'calc(12px * var(--fs))', marginTop: 8 }}>
              Protocols define clinical guardrails: trigger conditions (based on questionnaire answers),
              required vitals/tests, and pre-visit messages for patients.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>
                {protocols.find(p => p.id === editing.id) ? 'Edit Protocol' : 'New Protocol'}
              </h3>
              <button type="button" onClick={() => setEditing(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(18px * var(--fs))' }}>✕</button>
            </div>

            {/* ID + Name */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Protocol ID *</label>
                <input className="input" required value={editing.id} placeholder="proto_chest_pain"
                  onChange={e => setEditing({ ...editing, id: e.target.value })}
                  disabled={!!protocols.find(p => p.id === editing.id)} />
              </div>
              <div style={{ width: 100 }}>
                <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Version</label>
                <input className="input" value={editing.version || '1.0'}
                  onChange={e => setEditing({ ...editing, version: e.target.value })} />
              </div>
            </div>

            <div>
              <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Protocol Name *</label>
              <input className="input" required value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                placeholder="Chest Pain Protocol" />
            </div>

            <div>
              <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Authored By</label>
              <input className="input" value={editing.authored_by || ''}
                onChange={e => setEditing({ ...editing, authored_by: e.target.value })}
                placeholder="Dr. Name" />
            </div>

            {/* Trigger Conditions */}
            <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12 }}>
              <label style={{ fontSize: 'calc(12px * var(--fs))', fontWeight: 600 }}>Trigger Conditions</label>
              <p style={{ fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)', marginBottom: 8 }}>
                Question ID = expected answer. Protocol activates when any condition matches.
              </p>
              {Object.entries(editing.trigger_conditions || {}).map(([key, val]) => (
                <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={key} disabled />
                  <span style={{ fontSize: 'calc(11px * var(--fs))' }}>=</span>
                  <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} value={val}
                    onChange={e => setCondition(key, e.target.value)} />
                  <button type="button" onClick={() => removeCondition(key)}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(16px * var(--fs))' }}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} id="new-cond-key" placeholder="question_id" />
                <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 'calc(12px * var(--fs))' }} id="new-cond-val" placeholder="answer" />
                <button type="button" onClick={() => {
                  const k = document.getElementById('new-cond-key').value.trim();
                  const v = document.getElementById('new-cond-val').value.trim();
                  if (k && v) { setCondition(k, v); document.getElementById('new-cond-key').value = ''; document.getElementById('new-cond-val').value = ''; }
                }} style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 'calc(11px * var(--fs))', cursor: 'pointer' }}>
                  + Add
                </button>
              </div>
            </div>

            {/* Required Vitals */}
            <div>
              <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Required Vitals (comma-separated)</label>
              <input className="input" value={(editing.required_vitals || []).join(', ')}
                onChange={e => updateList('required_vitals', e.target.value)}
                placeholder="BP, SpO2, Heart Rate" />
            </div>

            {/* Required Tests */}
            <div>
              <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Required Tests (comma-separated)</label>
              <input className="input" value={(editing.required_tests || []).join(', ')}
                onChange={e => updateList('required_tests', e.target.value)}
                placeholder="Lipid Profile, ECG, Troponin" />
            </div>

            {/* Pre-visit messages */}
            <div>
              <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Pre-visit Message (English)</label>
              <textarea className="input" rows={2} value={editing.pre_visit_msg_en || ''}
                onChange={e => setEditing({ ...editing, pre_visit_msg_en: e.target.value })}
                placeholder="Please bring your recent blood test reports..." />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Hindi</label>
                <textarea className="input" rows={2} value={editing.pre_visit_msg_hi || ''}
                  onChange={e => setEditing({ ...editing, pre_visit_msg_hi: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Telugu</label>
                <textarea className="input" rows={2} value={editing.pre_visit_msg_te || ''}
                  onChange={e => setEditing({ ...editing, pre_visit_msg_te: e.target.value })} />
              </div>
            </div>

            {error && <p style={{ color: 'var(--red)', fontSize: 'calc(13px * var(--fs))' }}>{error}</p>}
            {success && <p style={{ color: 'var(--green)', fontSize: 'calc(13px * var(--fs))' }}>{success}</p>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={saving} style={{ flex: 1 }}>
                {saving ? 'Saving...' : 'Save Protocol'}
              </button>
              {protocols.find(p => p.id === editing.id) && (
                <button type="button" className="btn btn-outline" onClick={() => handleDelete(editing.id)}
                  style={{ borderColor: 'var(--red)', color: 'var(--red)', width: 'auto', padding: '0 16px' }}>
                  Deactivate
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}


function AnalyticsDashboard() {
  const [data, setData] = useState(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, [hours]);

  async function loadData() {
    setLoading(true);
    try { setData(await api.getAnalytics(hours)); } catch { setData(null); }
    setLoading(false);
  }

  if (loading) return <p style={{ textAlign: 'center', padding: 40, color: 'var(--text-light)' }}>Loading analytics...</p>;
  if (!data) return <p style={{ textAlign: 'center', padding: 40, color: 'var(--red)' }}>Failed to load analytics</p>;

  const cardStyle = { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', flex: '1 1 160px', minWidth: 160 };
  const thStyle = { padding: '8px 12px', textAlign: 'left', fontSize: 'calc(12px * var(--fs))', background: 'var(--primary)', color: '#fff' };
  const tdStyle = { padding: '8px 12px', fontSize: 'calc(13px * var(--fs))', borderBottom: '1px solid #F0F0F0' };
  // Minutes → "9 min" for short spans, rolling over to "6h 33m" once past an hour
  // (avg wait is usually minutes; avg total can be hours).
  const fmtMin = (v) => {
    if (v == null) return '—';
    const m = Math.round(v);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>Period:</span>
        {[6, 12, 24, 48, 168].map(h => (
          <button key={h} className={`btn ${hours === h ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 'calc(12px * var(--fs))', minHeight: 30, width: 'auto', padding: '0 12px' }}
            onClick={() => setHours(h)}>
            {h <= 24 ? `${h}h` : `${h / 24}d`}
          </button>
        ))}
      </div>

      {/* Throughput funnel — one row, one vocabulary, used identically across the
          whole HIS dashboard: Registered → Ready → Started → Completed, then the
          live "Waiting now" gauge and the two timing averages. Each label carries
          its exact definition as a hover title. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={cardStyle}>
          <p title="Patients who got past the QR scan into registration" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Registered</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--primary)' }}>{data.registered ?? data.total_sessions}</p>
        </div>
        <div style={cardStyle}>
          <p title="Finished the AI pre-consult (questionnaire, vitals, documents, summary) — waiting for a doctor" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Ready</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--green)' }}>{data.completed ?? data.completed_count}</p>
        </div>
        <div style={cardStyle}>
          <p title="A doctor has opened the visit — consultation started" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Started</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--secondary)' }}>{data.consulted ?? '—'}</p>
        </div>
        <div style={cardStyle}>
          <p title="Doctor finished the consultation (Save & Generate QR / prescription issued)" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Completed</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--secondary)' }}>{data.dispatched ?? '—'}</p>
        </div>
        <div style={cardStyle}>
          <p title="Ready patients not yet picked up by a doctor (live)" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Waiting now</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: (data.waiting ?? 0) > 0 ? 'var(--amber)' : 'var(--text-light)' }}>{data.waiting ?? '—'}</p>
        </div>
        <div style={cardStyle}>
          <p title="Average time from arrival (registration) to a doctor opening the visit" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Avg wait · arrival→started</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--secondary)' }}>{fmtMin(data.avg_wait_minutes)}</p>
        </div>
        <div style={cardStyle}>
          <p title="Average end-to-end time from arrival (registration) to a completed consultation" style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Avg total · arrival→completed</p>
          <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--secondary)' }}>{fmtMin(data.avg_total_minutes)}</p>
        </div>
      </div>

      {/* Triage mix — safety + staffing signal. Always render RED→AMBER→GREEN in
          that fixed order (not data order) with human labels. "Untriaged" (a
          session with no triage_level — the patient never finished the interview)
          is its own card, never merged into GREEN. */}
      {(() => {
        const byLevel = Object.fromEntries((data.by_triage || []).map(t => [t.level, t.count]));
        const TRIAGE = [
          ['RED', 'Severe · RED', 'var(--red)'],
          ['AMBER', 'Moderate · AMBER', 'var(--amber-text)'],
          ['GREEN', 'Mild · GREEN', 'var(--green)'],
        ];
        return (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {TRIAGE.map(([key, label, color]) => (
              <div key={key} style={cardStyle}>
                <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>{label}</p>
                <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color }}>{byLevel[key] || 0}</p>
              </div>
            ))}
            {byLevel.NONE > 0 && (
              <div style={cardStyle}>
                <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>Untriaged</p>
                <p style={{ fontSize: 'calc(28px * var(--fs))', fontWeight: 700, color: 'var(--text-light)' }}>{byLevel.NONE}</p>
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>By Department · throughput & live load</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thStyle}>Department</th><th style={thStyle}>Registered</th>
            <th style={thStyle} title="Finished pre-consult, waiting for a doctor">Ready</th>
            <th style={thStyle} title="A doctor has opened the visit — consultation started">Started</th>
            <th style={thStyle}>Waiting</th><th style={thStyle}>Avg wait</th>
            <th style={thStyle} title="Share of registered patients who reached Ready (Ready ÷ Registered)">Completion</th>
          </tr></thead>
          <tbody>
            {data.by_department?.map(d => {
              const reg = d.registered ?? d.total;
              return (
                <tr key={d.department}>
                  <td style={tdStyle}><strong>{d.department}</strong></td>
                  <td style={tdStyle}>{reg}</td>
                  <td style={tdStyle}>{d.completed}</td>
                  <td style={tdStyle}>{d.consulted ?? '—'}</td>
                  <td style={{ ...tdStyle, color: (d.waiting ?? 0) > 0 ? 'var(--amber)' : 'inherit', fontWeight: (d.waiting ?? 0) > 0 ? 700 : 400 }}>{d.waiting ?? '—'}</td>
                  <td style={tdStyle}>{fmtMin(d.avg_wait_minutes)}</td>
                  <td style={tdStyle}>{reg > 0 ? Math.round(d.completed / reg * 100) : 0}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>By Doctor · productivity</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thStyle}>Doctor</th><th style={thStyle}>Dept</th>
            <th style={thStyle} title="Visits this doctor has opened — consultations started">Started</th>
            <th style={thStyle} title="Consultations this doctor finished (Save & Generate QR)">Completed</th>
            <th style={thStyle}>Avg consult</th>
            <th style={{ ...thStyle, textAlign: 'center' }} title="Severe-triage patients handled">RED</th>
            <th style={{ ...thStyle, textAlign: 'center' }} title="Moderate-triage patients handled">AMBER</th>
            <th style={{ ...thStyle, textAlign: 'center' }} title="Mild-triage patients handled">GREEN</th>
          </tr></thead>
          <tbody>
            {data.by_doctor?.map(d => (
              <tr key={d.name}>
                <td style={tdStyle}><strong>{d.name}</strong></td>
                <td style={tdStyle}>{d.department}</td>
                <td style={tdStyle}>{d.seen ?? '—'}</td>
                <td style={tdStyle}>{d.completed}</td>
                <td style={tdStyle}>{fmtMin(d.avg_consult_minutes)}</td>
                <td style={{ ...tdStyle, textAlign: 'center', color: d.red_count > 0 ? 'var(--red)' : 'var(--text-light)', fontWeight: d.red_count > 0 ? 700 : 400 }}>{d.red_count}</td>
                <td style={{ ...tdStyle, textAlign: 'center', color: (d.amber_count ?? 0) > 0 ? 'var(--amber-text)' : 'var(--text-light)' }}>{d.amber_count ?? 0}</td>
                <td style={{ ...tdStyle, textAlign: 'center', color: (d.green_count ?? 0) > 0 ? 'var(--green)' : 'var(--text-light)' }}>{d.green_count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data.by_doctor || data.by_doctor.length === 0) && (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 16, fontSize: 'calc(13px * var(--fs))' }}>No doctor-assigned sessions</p>
        )}
      </div>

      {/* Peak-hour load — registrations by hour of day, the #1 staffing lever */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>Registrations by hour · peak load</h3>
        {(() => {
          const counts = Array(24).fill(0);
          (data.by_hour || []).forEach(h => { if (h.hour >= 0 && h.hour < 24) counts[h.hour] = h.registrations; });
          const max = Math.max(1, ...counts);
          const anyData = counts.some(c => c > 0);
          if (!anyData) return <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 8, fontSize: 'calc(13px * var(--fs))' }}>No registrations in this period</p>;
          const peakHour = counts.indexOf(max);
          const total = counts.reduce((a, b) => a + b, 0);
          // 12-hour clock label, e.g. 0->12am, 13->1pm — friendlier than "13:00".
          const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
          const PLOT_H = 150, X_AXIS = 18;      // px: bar area height + x-label gutter
          const ticks = [max, Math.round(max / 2), 0];   // y-axis: top / mid / baseline
          const axisLabel = { fontSize: 'calc(10px * var(--fs))', color: 'var(--text-light)' };
          return (
            <div>
              <div style={{ display: 'flex', gap: 8 }}>
                {/* y-axis scale (registrations) */}
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  height: PLOT_H, paddingBottom: X_AXIS, textAlign: 'right', minWidth: 16, ...axisLabel }}>
                  {ticks.map((t, i) => <span key={i}>{t}</span>)}
                </div>
                {/* plot: dashed gridlines behind, bars in front */}
                <div style={{ flex: 1, position: 'relative' }}>
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: X_AXIS,
                    display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
                    {ticks.map((t, i) => <div key={i} style={{ borderTop: '1px dashed #E6EBF0' }} />)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: PLOT_H, paddingBottom: X_AXIS }}>
                    {counts.map((c, h) => (
                      <div key={h} title={`${fmtHour(h)} — ${c} registration${c === 1 ? '' : 's'}`}
                        style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column',
                          alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        {h === peakHour && (
                          <span style={{ position: 'absolute', top: -16, fontSize: 'calc(10px * var(--fs))', fontWeight: 700, color: 'var(--primary)' }}>{c}</span>
                        )}
                        <div style={{ width: '100%', height: `${(c / max) * 100}%`, minHeight: c > 0 ? 3 : 0,
                          background: h === peakHour ? 'var(--primary)' : 'var(--secondary)', borderRadius: '4px 4px 0 0' }} />
                        {/* x-axis: label every 3rd hour, in the gutter below the baseline */}
                        <span style={{ position: 'absolute', bottom: -16, whiteSpace: 'nowrap', ...axisLabel }}>
                          {h % 3 === 0 ? fmtHour(h) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {/* caption — names the axes and calls out the peak */}
              <p style={{ marginTop: 12, fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>
                Busiest hour <strong style={{ color: 'var(--primary)' }}>{fmtHour(peakHour)}</strong> ({max} registration{max === 1 ? '' : 's'}) · {total} total in period.
                Bars = registrations per hour of day (x-axis); height = count (y-axis).
              </p>
            </div>
          );
        })()}
      </div>

      {/* Intake funnel — raw pre-consult stages (a session's `state` only moves
          through intake; "Started"/"Completed" are later doctor-workflow stamps,
          so they don't appear here). Labels mapped to the dashboard vocabulary. */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>Intake stages · pre-consult funnel</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(() => {
            const RAW_STATE_LABEL = { CONSENTED: 'Consented', REGISTERED: 'Registered', INTERVIEW: 'In Interview', VITALS: 'Vitals', COMPLETE: 'Ready' };
            // Hide INIT (scanned but abandoned before registering) — it's noise in
            // the intake funnel, not a stage anyone acts on (mentor feedback).
            return (data.by_state || []).filter(s => s.state !== 'INIT').map(s => (
              <div key={s.state} style={{ background: '#F8FAFC', borderRadius: 8, padding: '8px 16px', textAlign: 'center' }}>
                <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{RAW_STATE_LABEL[s.state] || s.state}</p>
                <p style={{ fontSize: 'calc(20px * var(--fs))', fontWeight: 600 }}>{s.count}</p>
              </div>
            ));
          })()}
        </div>
      </div>

      {data.ai_accuracy && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 4 }}>AI summary accuracy</h3>
          <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginBottom: 12 }}>
            From doctors' Accurate/Inaccurate review of the AI report (this period). Only reviewed reports count toward the rate.
          </p>
          {data.ai_accuracy.reviewed > 0 ? (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <div style={{ background: '#EAF7EF', borderRadius: 8, padding: '10px 18px', textAlign: 'center', minWidth: 110 }}>
                <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>Accepted rate</p>
                <p style={{ fontSize: 'calc(26px * var(--fs))', fontWeight: 700, color: 'var(--green)' }}>{data.ai_accuracy.rate}%</p>
              </div>
              {[['Reviewed', data.ai_accuracy.reviewed], ['Accurate', data.ai_accuracy.accurate], ['Inaccurate', data.ai_accuracy.inaccurate], ['Edited', data.ai_accuracy.edited]].map(([label, val]) => (
                <div key={label} style={{ background: '#F8F9FA', borderRadius: 8, padding: '10px 18px', textAlign: 'center', minWidth: 90 }}>
                  <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{label}</p>
                  <p style={{ fontSize: 'calc(20px * var(--fs))', fontWeight: 600 }}>{val}</p>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>No reports reviewed by a doctor in this period yet.</p>
          )}
        </div>
      )}

      {data.followups?.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 12 }}>Follow-ups</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {data.followups.map(f => (
              <div key={f.status} style={{ background: '#F8F9FA', borderRadius: 8, padding: '8px 16px', textAlign: 'center' }}>
                <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)' }}>{f.status}</p>
                <p style={{ fontSize: 'calc(20px * var(--fs))', fontWeight: 600 }}>{f.count}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// Short, scannable summary of a longer text (first sentence, else clipped at a
// word boundary) — used to collapse the verbose AI descriptions in the queue.
function gist(text, n = 130) {
  const s = (text || '').trim();
  if (s.length <= n) return s;
  const dot = s.indexOf('. ');
  if (dot > 0 && dot <= n) return s.slice(0, dot + 1);
  return s.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

// ── Rx Template manager: hospital prescription branding/theme/toggles + live preview ──
const RX_SAMPLE = {
  patient: 'Ravi Kumar', patient_age: 42, patient_gender: 'M', patient_phone: '9876543210',
  doctor: 'Dr. Priya Sharma', doctor_registration: 'KMC-12345', department: 'CARD',
  items: [
    { drug: 'Paracetamol 500mg', dose: '1 tab', freq: 'TID', duration: '5 days', instructions: 'After food' },
    { drug: 'Amoxicillin 250mg', dose: '1 cap', freq: 'BD', duration: '7 days', instructions: '' },
  ],
  notes: 'Plenty of fluids and rest. Review in 1 week if symptoms persist.',
  rx_id: 'SAMPLE-0000', issued_at: new Date().toISOString(),
};

// Hospital-wide feature settings. Currently just the global OCR/document-scanning
// toggle — flipping it off stops the paid AI/OCR extraction across ALL departments
// (the patient flow hides the upload step; the python OCR endpoint also refuses).
// Per-department control is intentionally deferred until requested.
function SettingsManager() {
  const [settings, setSettings] = useState(null);   // null = loading
  const [saving, setSaving] = useState(false);
  const { toast, toastView } = useToast();

  useEffect(() => {
    api.getAdminSettings()
      .then(s => setSettings({ ocr_enabled: s.ocr_enabled !== false }))
      .catch(() => setSettings({ ocr_enabled: true }));
  }, []);

  async function setOcr(next) {
    if (saving) return;
    const prev = settings;
    setSettings({ ...settings, ocr_enabled: next });   // optimistic
    setSaving(true);
    try {
      const s = await api.updateSettings({ ocr_enabled: next });
      setSettings({ ocr_enabled: s.ocr_enabled !== false });
      toast(next ? 'OCR / document scanning turned ON' : 'OCR / document scanning turned OFF', 'success');
    } catch (e) {
      setSettings(prev);   // revert on failure
      toast('Could not update setting: ' + (e.message || ''), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p style={{ color: 'var(--text-light)', padding: 24 }}>Loading settings…</p>;

  const on = settings.ocr_enabled;

  return (
    <div style={{ padding: '8px 4px', maxWidth: 640 }}>
      {toastView}
      <div style={{ background: 'var(--card-bg)', border: '1px solid #E2E8F0', borderRadius: 12, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)' }}>Document scanning (OCR)</h3>
            <p style={{ margin: 0, fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)', lineHeight: 1.5 }}>
              When ON, uploaded prescriptions and reports are read by AI/OCR and the extracted
              medicines, lab values and allergies are added to the doctor's report. When OFF,
              patients can still upload — the files are shown to the doctor as-is, but no AI
              extraction runs, avoiding the per-scan API cost. Applies to all departments.
            </p>
          </div>
          {/* Toggle switch */}
          <button
            role="switch"
            aria-checked={on}
            aria-label="Toggle document scanning (OCR)"
            disabled={saving}
            onClick={() => setOcr(!on)}
            style={{
              flexShrink: 0, position: 'relative', width: 56, height: 32, borderRadius: 16,
              border: 'none', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
              background: on ? 'var(--accent)' : '#C4CDD5', transition: 'background 0.15s',
            }}>
            <span style={{
              position: 'absolute', top: 3, left: on ? 27 : 3, width: 26, height: 26, borderRadius: '50%',
              background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.15s',
            }} />
          </button>
        </div>
        <div style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--fs))', fontWeight: 600,
          color: on ? 'var(--green)' : 'var(--text-light)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: on ? 'var(--green)' : '#B0B8C1' }} />
          {on ? 'Enabled — uploads are read by AI/OCR' : 'Disabled — uploads shown to doctor as-is, no AI extraction'}
        </div>
      </div>

      {/* Patient check-in QR / poster generator */}
      <CheckinQRPanel />
    </div>
  );
}

// ── Check-in QR / poster generator ────────────────────────────────────────────
// Generates the single-hospital check-in QR (the plain app URL with ?h=<id>) and
// wraps it in a printable poster. The QR is rendered CLIENT-SIDE from the `qrcode`
// package (no CDN) and the exported poster is fully SELF-CONTAINED — the QR is
// embedded as a data URI and every style is inline — so it renders on a kiosk or
// waiting-room screen with NO internet and never calls out to a firewalled LAN.
function CheckinQRPanel() {
  const { toast, toastView } = useToast();
  const [hospitalName, setHospitalName] = useState('Pratham OPD');
  const [hospitalId, setHospitalId] = useState('demo_hospital_01');
  const [baseUrl, setBaseUrl] = useState('');
  const [qr, setQr] = useState('');       // QR as a PNG data URL
  const [err, setErr] = useState('');

  // Default the base URL to wherever HIS is being served, so the poster points at
  // this same deployment by default (no typing the domain). Editable for the case
  // where the kiosk should point at a different host / LAN IP.
  useEffect(() => {
    if (typeof window !== 'undefined') setBaseUrl(window.location.origin);
  }, []);

  const cleanBase = (baseUrl || '').trim().replace(/\/+$/, '');
  const hid = (hospitalId || 'demo_hospital_01').trim();
  const checkinUrl = cleanBase ? `${cleanBase}/?h=${encodeURIComponent(hid)}` : '';

  // Regenerate the QR whenever the target URL changes.
  useEffect(() => {
    if (!checkinUrl) { setQr(''); return; }
    let alive = true;
    QRCode.toDataURL(checkinUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320, color: { dark: '#1B4F72', light: '#ffffff' } })
      .then(url => { if (alive) { setQr(url); setErr(''); } })
      .catch(() => { if (alive) { setQr(''); setErr('Could not generate the QR code.'); } });
    return () => { alive = false; };
  }, [checkinUrl]);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The self-contained poster document. `autoPrint` triggers the browser print
  // dialog once loaded (used by "Print / Save as PDF"); the downloadable kiosk
  // file omits it so it just displays.
  function buildPosterHtml({ autoPrint = false } = {}) {
    if (!qr) return '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(hospitalName)} — Check-in QR</title>
<style>
  :root { --primary:#1B4F72; --secondary:#2E86AB; --text-light:#7F8C8D; }
  * { box-sizing:border-box; margin:0; }
  html,body { height:100%; }
  body { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:#f4f6f8; color:#1a2b3c;
    display:flex; align-items:center; justify-content:center; padding:24px; }
  .poster { width:100%; max-width:620px; background:#fff; border-radius:16px; box-shadow:0 4px 24px rgba(0,0,0,.08);
    padding:40px 32px; text-align:center; }
  .brand { font-size:15px; letter-spacing:2px; color:var(--secondary); font-weight:700; text-transform:uppercase; }
  h1 { font-size:30px; color:var(--primary); margin:6px 0 2px; }
  .sub { font-size:17px; color:var(--text-light); margin:0 0 24px; }
  .qr { display:inline-flex; padding:16px; background:#fff; border:3px solid var(--primary); border-radius:16px; }
  .qr img { display:block; width:300px; height:300px; }
  .steps { margin:26px auto 0; max-width:420px; text-align:left; }
  .step { display:flex; gap:12px; align-items:flex-start; margin:10px 0; }
  .n { flex:0 0 26px; height:26px; border-radius:50%; background:var(--primary); color:#fff;
    display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; }
  .txt { font-size:15px; line-height:1.4; } .txt small { color:var(--text-light); }
  .hospital { margin-top:22px; font-size:13px; color:var(--text-light); }
  .disclaimer { margin-top:14px; font-size:11px; color:var(--text-light); font-style:italic; }
  @media print { body { background:#fff; padding:0; } .poster { box-shadow:none; max-width:100%; } }
</style></head>
<body>
  <div class="poster">
    <div class="brand">Pratham · AI Pre-Consultation</div>
    <h1>${esc(hospitalName)}</h1>
    <p class="sub">स्कैन करें · Scan · స్కాన్ చేయండి</p>
    <div class="qr"><img src="${qr}" alt="Check-in QR code" /></div>
    <div class="steps">
      <div class="step"><div class="n">1</div><div class="txt">Scan this QR with your phone camera<br><small>अपने फ़ोन कैमरे से स्कैन करें · మీ ఫోన్ కెమెరాతో స్కాన్ చేయండి</small></div></div>
      <div class="step"><div class="n">2</div><div class="txt">Choose your language &amp; department<br><small>अपनी भाषा और विभाग चुनें · మీ భాష, విభాగాన్ని ఎంచుకోండి</small></div></div>
      <div class="step"><div class="n">3</div><div class="txt">Get your token &amp; fill in a few details<br><small>टोकन लें और कुछ जानकारी भरें · టోకెన్ పొంది వివరాలు నింపండి</small></div></div>
    </div>
    <div class="hospital">Hospital ID: ${esc(hid)}</div>
    <div class="disclaimer">Investigational — not for clinical use.</div>
  </div>
  ${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print();},150);});<\/script>' : ''}
</body></html>`;
  }

  function printPoster() {
    const html = buildPosterHtml({ autoPrint: true });
    if (!html) return;
    const w = window.open('', '_blank');
    if (!w) { toast('Pop-up blocked — allow pop-ups for this site, then try again.', 'error'); return; }
    w.document.write(html);
    w.document.close();
  }

  function downloadHtml() {
    const html = buildPosterHtml();
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `checkin-qr-${hid}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    toast('Kiosk HTML downloaded — open it on the screen; it works offline.', 'success');
  }

  function downloadPng() {
    if (!qr) return;
    const a = document.createElement('a');
    a.href = qr; a.download = `checkin-qr-${hid}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  const label = { fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 3, display: 'block' };

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid #E2E8F0', borderRadius: 12, padding: 20, marginTop: 16 }}>
      {toastView}
      <h3 style={{ margin: '0 0 6px', fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)' }}>Patient check-in QR / poster</h3>
      <p style={{ margin: '0 0 16px', fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)', lineHeight: 1.5 }}>
        The QR carries your check-in link (<code>{'/?h=<hospital id>'}</code>). Print it as a
        waiting-room poster, or download a self-contained HTML page for a kiosk / display — that
        page embeds the QR and works with no internet.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={label}>Hospital name (shown on the poster)</label>
          <input className="input" value={hospitalName} onChange={e => setHospitalName(e.target.value)} style={{ height: 38 }} />
        </div>
        <div>
          <label style={label}>Hospital ID</label>
          <input className="input" value={hospitalId} onChange={e => setHospitalId(e.target.value)} style={{ height: 38 }} />
        </div>
        <div>
          <label style={label}>App base URL</label>
          <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://your-domain" style={{ height: 38 }} />
        </div>
      </div>

      {checkinUrl && (
        <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--secondary)', wordBreak: 'break-all',
          background: '#F4F8FB', borderRadius: 6, padding: '8px 10px', margin: '0 0 16px', fontFamily: 'ui-monospace, monospace' }}>
          {checkinUrl}
        </p>
      )}

      {/* Live poster preview */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 auto', textAlign: 'center', border: '1px solid #E2E8F0', borderRadius: 12, padding: 16, background: '#fff' }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--secondary)', fontWeight: 700, textTransform: 'uppercase' }}>Pratham · AI Pre-Consultation</div>
          <div style={{ fontSize: 20, color: 'var(--primary)', fontWeight: 700, margin: '4px 0 2px' }}>{hospitalName || 'Hospital name'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12 }}>स्कैन करें · Scan · స్కాన్ చేయండి</div>
          {qr
            ? <img src={qr} alt="Check-in QR preview" style={{ width: 200, height: 200, border: '3px solid var(--primary)', borderRadius: 12, padding: 8, background: '#fff' }} />
            : <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-light)', fontSize: 12, border: '1px dashed #C4CDD5', borderRadius: 12 }}>{err || 'Enter a base URL…'}</div>}
          <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 10 }}>Hospital ID: {hid}</div>
        </div>

        <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 180 }}>
          <button className="btn btn-primary" disabled={!qr} onClick={printPoster}>🖨️ Print / Save as PDF</button>
          <button className="btn btn-outline" disabled={!qr} onClick={downloadHtml}>💾 Download kiosk HTML (works offline)</button>
          <button className="btn btn-outline" disabled={!qr} onClick={downloadPng}>🖼️ Download QR image (PNG)</button>
          {err && <p style={{ color: 'var(--red)', fontSize: 'calc(12px * var(--fs))', margin: 0 }}>{err}</p>}
        </div>
      </div>
    </div>
  );
}

function RxTemplateManager() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const { toast, toastView } = useToast();

  useEffect(() => { api.getRxTemplate().then(setCfg).catch(() => setCfg({})); }, []);

  if (!cfg) return <p style={{ color: 'var(--text-light)', padding: 24 }}>Loading template…</p>;

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const setShow = (k, v) => setCfg(c => ({ ...c, show: { ...(c.show || {}), [k]: v } }));
  const show = cfg.show || {};

  async function save() {
    setSaving(true);
    try { setCfg(await api.saveRxTemplate(cfg)); toast('Prescription template saved', 'success'); }
    catch (e) { toast('Save failed: ' + (e.message || ''), 'error'); }
    finally { setSaving(false); }
  }

  // Upload a logo (PNG/JPG): read → resize to ≤240px → store as a base64 data
  // URL in logo_url. A data URL renders directly in <img src>, so it shows in
  // the preview, the patient's digital Rx, and the doctor's printed slip with no
  // backend file storage. Resizing keeps the stored config small.
  function onLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast('Please choose a PNG or JPG image.', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 240;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const s = MAX / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        set('logo_url', canvas.toDataURL('image/png'));   // PNG keeps transparency
        setShow('logo', true);                            // auto-enable so it shows
      };
      img.onerror = () => toast('Could not read that image.', 'error');
      img.src = reader.result;
    };
    reader.onerror = () => toast('Could not read the file.', 'error');
    reader.readAsDataURL(file);
    e.target.value = '';   // allow re-selecting the same file
  }

  const label = { fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 3, display: 'block' };
  const field = (key, ph) => (
    <input className="input" value={cfg[key] || ''} placeholder={ph}
      onChange={e => set(key, e.target.value)} style={{ height: 38 }} />
  );
  const Toggle = ({ k, text }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--fs))', cursor: 'pointer', padding: '4px 0' }}>
      <input type="checkbox" checked={!!show[k]} onChange={e => setShow(k, e.target.checked)}
        style={{ width: 16, height: 16, cursor: 'pointer' }} />
      {text}
    </label>
  );
  const sectionHead = { fontSize: 'calc(11px * var(--fs))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', margin: '16px 0 8px' };

  return (
    <div>
      {toastView}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Config form ── */}
        <div style={{ flex: '1 1 420px', minWidth: 360, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <h3 style={{ fontSize: 'calc(16px * var(--fs))', color: 'var(--primary)', flex: 1 }}>Prescription Template</h3>
            <button className="btn btn-primary" onClick={save} disabled={saving} style={{ width: 'auto', padding: '0 18px', height: 38, fontSize: 'calc(14px * var(--fs))' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 8 }}>
            Configure how your hospital's digital prescription looks. Clinical fields (patient, ℞ medicines with dose/frequency/duration, prescriber, signature) always appear — these settings control branding and optional details.
          </p>

          <p style={sectionHead}>Hospital branding</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}><label style={label}>Hospital name</label>{field('hospital_name', 'City General Hospital')}</div>
            <div style={{ gridColumn: '1 / -1' }}><label style={label}>Tagline</label>{field('tagline', 'Caring for you, always')}</div>
            <div style={{ gridColumn: '1 / -1' }}><label style={label}>Address</label>{field('address', '123 Main Road, City – 500001')}</div>
            <div><label style={label}>Phone</label>{field('phone', '+91 98765 43210')}</div>
            <div><label style={label}>Email</label>{field('email', 'opd@hospital.org')}</div>
            <div style={{ gridColumn: '1 / -1' }}><label style={label}>Registration / license line</label>{field('registration_line', 'Reg. No. HOSP-2024-0001')}</div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label}>Hospital logo (PNG or JPG)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {cfg.logo_url ? (
                  <img src={cfg.logo_url} alt="logo" style={{ height: 46, width: 46, objectFit: 'contain', borderRadius: 6, border: '1px solid #E2E8F0', background: '#fff' }} />
                ) : (
                  <div style={{ height: 46, width: 46, borderRadius: 6, border: '1px dashed #CBD5E0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-light)', fontSize: 'calc(18px * var(--fs))' }}>🏥</div>
                )}
                <label className="btn btn-outline" style={{ width: 'auto', padding: '0 14px', height: 38, fontSize: 'calc(13px * var(--fs))', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                  {cfg.logo_url ? 'Change logo' : 'Upload logo'}
                  <input type="file" accept="image/png,image/jpeg" onChange={onLogoFile} style={{ display: 'none' }} />
                </label>
                {cfg.logo_url && (
                  <button type="button" onClick={() => set('logo_url', '')}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(13px * var(--fs))', fontWeight: 600 }}>Remove</button>
                )}
              </div>
              <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 4 }}>
                Shown on the prescription when the “Hospital logo” toggle is on. PNG/JPG, auto-resized.
              </p>
            </div>
          </div>

          <p style={sectionHead}>Theme</p>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {['classic', 'modern'].map(th => (
              <label key={th} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(13px * var(--fs))', cursor: 'pointer', textTransform: 'capitalize' }}>
                <input type="radio" name="rx-theme" checked={(cfg.theme || 'classic') === th} onChange={() => set('theme', th)} /> {th}
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'calc(13px * var(--fs))', marginLeft: 'auto' }}>
              Accent
              <input type="color" value={cfg.accent || '#1c5d8c'} onChange={e => set('accent', e.target.value)}
                style={{ width: 34, height: 28, border: 'none', background: 'none', cursor: 'pointer' }} />
            </label>
          </div>

          <p style={sectionHead}>Show on prescription</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Toggle k="logo" text="Hospital logo" />
            <Toggle k="department" text="Doctor's department" />
            <Toggle k="patient_age" text="Patient age" />
            <Toggle k="doctor_registration" text="Doctor registration no." />
            <Toggle k="patient_gender" text="Patient gender" />
            <Toggle k="valid_until" text="Valid-until date" />
            <Toggle k="patient_phone" text="Patient phone" />
            <Toggle k="generic_note" text="Generic-substitution note" />
          </div>

          {show.valid_until && (
            <div style={{ marginTop: 10 }}>
              <label style={label}>Valid for (days)</label>
              {/* Free entry — any whole number. We DON'T clamp on keystroke (that
                  fights typing/backspace); the preview's date math already handles
                  absurd values gracefully without crashing. */}
              <input className="input" type="number" min="1" value={cfg.valid_days ?? 30}
                onChange={e => {
                  const v = e.target.value;
                  if (v === '') { set('valid_days', ''); return; }   // allow clearing while editing
                  const n = parseInt(v, 10);
                  if (!Number.isNaN(n)) set('valid_days', n);
                }} style={{ height: 38, width: 120 }} />
            </div>
          )}
          {show.generic_note && (
            <div style={{ marginTop: 10 }}>
              <label style={label}>Generic-substitution note text</label>
              <input className="input" value={cfg.generic_note_text || ''}
                onChange={e => set('generic_note_text', e.target.value)} style={{ height: 38 }} />
            </div>
          )}

          <p style={sectionHead}>Footer</p>
          <input className="input" value={cfg.footer || ''} onChange={e => set('footer', e.target.value)}
            placeholder="Digitally signed prescription. Verify before dispensing." style={{ height: 38 }} />
        </div>

        {/* ── Live preview ── */}
        <div style={{ flex: '1 1 460px', minWidth: 380, position: 'sticky', top: 16 }}>
          <p style={{ fontSize: 'calc(11px * var(--fs))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 8 }}>Live preview</p>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, boxShadow: '0 4px 20px rgba(0,0,0,.08)' }}>
            <RxDocument rx={RX_SAMPLE} template={cfg} verified={true} />
          </div>
          <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 8 }}>Sample data — this is exactly how a patient's verified prescription will render.</p>
        </div>
      </div>
    </div>
  );
}

// ── Drug Formulary manager: AI review queue + curated drugs/interactions ──────
function FormularyManager() {
  const [queue, setQueue] = useState([]);
  const [qExpanded, setQExpanded] = useState(() => new Set()); // queue rows showing full description
  const [drugs, setDrugs] = useState([]);
  const [inter, setInter] = useState([]);
  const [classInter, setClassInter] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [drugForm, setDrugForm] = useState({ generic: '', classes: '', aliases: '' });
  const [intForm, setIntForm] = useState({ generic_a: '', generic_b: '', severity: 'warn', description: '' });
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  async function loadAll() {
    setLoading(true);
    try {
      const [q, d, i, c] = await Promise.all([
        api.reviewQueue(),
        api.formularyDrugs(),
        api.formularyInteractions(),
        api.formularyClassInteractions(),
      ]);
      setQueue(q || []); setDrugs(d || []); setInter(i || []); setClassInter(c || []);
      setLoadError(null);
    } catch (e) {
      // Do NOT fall back to empty arrays: a failed load and a genuinely empty formulary
      // would render identically ("0 formulary drugs", "0 curated interactions"), leaving
      // an admin unable to tell an un-curated formulary from a backend that is down — on
      // the screen that governs drug-interaction checking. Surface it and show nothing.
      setLoadError(e.message || 'Request failed');
    } finally { setLoading(false); }
  }
  useEffect(() => { loadAll(); }, []);

  async function approve(item) {
    try { await api.approveReview(item.id, {}); toast('Added to formulary', 'success'); loadAll(); }
    catch (e) { toast('Approve failed: ' + e.message, 'error'); }
  }
  async function dismiss(item) {
    if (!(await confirm({ title: 'Dismiss this AI finding?', message: `${item.unknown_drug} + ${item.other_drug}`, confirmLabel: 'Dismiss', danger: true }))) return;
    try { await api.dismissReview(item.id); loadAll(); } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function addDrug(e) {
    e.preventDefault();
    if (!drugForm.generic.trim()) return;
    const payload = {
      generic: drugForm.generic.trim().toLowerCase().replace(/\s+/g, '_'),
      classes: drugForm.classes.split(',').map(s => s.trim()).filter(Boolean),
      aliases: drugForm.aliases.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    };
    try { await api.saveFormularyDrug(payload); setDrugForm({ generic: '', classes: '', aliases: '' }); toast('Drug saved', 'success'); loadAll(); }
    catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function delDrug(generic) {
    if (!(await confirm({ title: `Remove "${generic}"?`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.deleteFormularyDrug(generic); loadAll(); } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function addInteraction(e) {
    e.preventDefault();
    if (!intForm.generic_a.trim() || !intForm.generic_b.trim()) return;
    try {
      await api.saveFormularyInteraction({
        generic_a: intForm.generic_a.trim().toLowerCase(), generic_b: intForm.generic_b.trim().toLowerCase(),
        severity: intForm.severity, description: intForm.description.trim(),
      });
      setIntForm({ generic_a: '', generic_b: '', severity: 'warn', description: '' });
      toast('Interaction saved', 'success'); loadAll();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }
  async function delInteraction(id) {
    if (!(await confirm({ title: 'Delete interaction?', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.deleteFormularyInteraction(id); loadAll(); } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  const card = { background: 'var(--card-bg)', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' };
  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.03em' };
  const td = { padding: '6px 8px', fontSize: 'calc(13px * var(--fs))', borderTop: '1px solid #F0F0F0' };
  const sev = (s) => <span style={{ fontWeight: 700, color: s === 'block' ? 'var(--red)' : '#B9770E' }}>{(s || '').toUpperCase()}</span>;

  if (loading) return <div style={{ padding: 24, color: 'var(--text-light)' }}>Loading formulary…</div>;

  if (loadError) return (
    <div style={{ ...card, borderLeft: '4px solid var(--red)' }} role="alert">
      <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--red)', marginBottom: 6 }}>Could not load the formulary</h3>
      <p style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text)', marginBottom: 6 }}>{loadError}</p>
      <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 12 }}>
        Counts are hidden deliberately — <strong>this is not an empty formulary</strong>, it could not be read. Prescription
        interaction checking is served by the same backend, so verify it before relying on any check.
      </p>
      <button onClick={loadAll} style={{ background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)', borderRadius: 6, padding: '4px 10px', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer' }}>Retry</button>
    </div>
  );

  return (
    <div>
      {dialog}{toastView}

      {/* Review queue — AI findings awaiting curation */}
      <div style={card}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 4 }}>AI Review Queue <span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>({queue.length} pending)</span></h3>
        <p style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)', marginBottom: 10 }}>
          Interactions the AI flagged for drugs not yet in the formulary. Approving adds the drug + a curated interaction; nothing here affects checks until approved.
        </p>
        {queue.length === 0 ? <p style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-light)' }}>Nothing pending.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Unknown drug</th><th style={th}>Other drug</th><th style={th}>AI severity</th><th style={th}>Description</th><th style={th}>Conf.</th><th style={th}></th></tr></thead>
            <tbody>
              {queue.map(q => (
                <tr key={q.id}>
                  <td style={td}><strong>{q.unknown_drug}</strong></td>
                  <td style={td}>{q.other_drug}</td>
                  <td style={td}>{sev(q.ai_severity)}</td>
                  <td style={{ ...td, maxWidth: 340 }}>
                    {(() => {
                      const full = q.ai_description || '';
                      const open = qExpanded.has(q.id);
                      const short = gist(full);
                      const collapsible = short !== full;
                      return (
                        <>
                          {open || !collapsible ? full : short}
                          {collapsible && (
                            <button type="button"
                              onClick={() => setQExpanded(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                              style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'calc(12px * var(--fs))', padding: 0 }}>
                              {open ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td style={td}>{q.ai_confidence != null ? Math.round(q.ai_confidence * 100) + '%' : '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button onClick={() => approve(q)} style={{ background: 'var(--green)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer', marginRight: 6 }}>Approve</button>
                    <button onClick={() => dismiss(q)} style={{ background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 6, padding: '4px 10px', fontSize: 'calc(12px * var(--fs))', cursor: 'pointer' }}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Curated interactions */}
      <div style={card}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 10 }}>Curated Interactions <span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>({inter.length})</span></h3>
        <form onSubmit={addInteraction} style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" placeholder="drug a (generic)" value={intForm.generic_a} onChange={e => setIntForm({ ...intForm, generic_a: e.target.value })} style={{ width: 150, minHeight: 34 }} />
          <input className="input" placeholder="drug b (generic)" value={intForm.generic_b} onChange={e => setIntForm({ ...intForm, generic_b: e.target.value })} style={{ width: 150, minHeight: 34 }} />
          <select className="input" value={intForm.severity} onChange={e => setIntForm({ ...intForm, severity: e.target.value })} style={{ width: 100, minHeight: 34 }}><option value="warn">warn</option><option value="block">block</option></select>
          <input className="input" placeholder="description" value={intForm.description} onChange={e => setIntForm({ ...intForm, description: e.target.value })} style={{ flex: 1, minWidth: 180, minHeight: 34 }} />
          <button className="btn btn-primary" type="submit" style={{ width: 'auto', minHeight: 34, padding: '0 16px', fontSize: 'calc(13px * var(--fs))' }}>Add</button>
        </form>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>A</th><th style={th}>B</th><th style={th}>Severity</th><th style={th}>Description</th><th style={th}>Src</th><th style={th}></th></tr></thead>
            <tbody>
              {inter.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.generic_a}</td><td style={td}>{r.generic_b}</td><td style={td}>{sev(r.severity)}</td>
                  <td style={{ ...td, maxWidth: 320 }}>{r.description}</td><td style={td}>{r.source}</td>
                  <td style={td}><button onClick={() => delInteraction(r.id)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(14px * var(--fs))' }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Curated drugs */}
      <div style={card}>
        <h3 style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--primary)', marginBottom: 10 }}>Formulary Drugs <span style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-light)' }}>({drugs.length})</span></h3>
        <form onSubmit={addDrug} style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" placeholder="generic name" value={drugForm.generic} onChange={e => setDrugForm({ ...drugForm, generic: e.target.value })} style={{ width: 160, minHeight: 34 }} />
          <input className="input" placeholder="classes (comma sep)" value={drugForm.classes} onChange={e => setDrugForm({ ...drugForm, classes: e.target.value })} style={{ width: 200, minHeight: 34 }} />
          <input className="input" placeholder="brand aliases (comma sep)" value={drugForm.aliases} onChange={e => setDrugForm({ ...drugForm, aliases: e.target.value })} style={{ flex: 1, minWidth: 180, minHeight: 34 }} />
          <button className="btn btn-primary" type="submit" style={{ width: 'auto', minHeight: 34, padding: '0 16px', fontSize: 'calc(13px * var(--fs))' }}>Add</button>
        </form>
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Generic</th><th style={th}>Classes</th><th style={th}>Aliases</th><th style={th}>Src</th><th style={th}></th></tr></thead>
            <tbody>
              {drugs.map(d => (
                <tr key={d.id}>
                  <td style={td}><strong>{d.generic}</strong></td>
                  <td style={{ ...td, color: 'var(--text-light)' }}>{(d.classes || []).join(', ')}</td>
                  <td style={{ ...td, color: 'var(--text-light)', maxWidth: 280 }}>{(d.aliases || []).join(', ')}</td>
                  <td style={td}>{d.source}</td>
                  <td style={td}><button onClick={() => delDrug(d.generic)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 'calc(14px * var(--fs))' }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-light)', marginTop: 8 }}>Class-vs-class rules ({classInter.length}) are also active and editable via the API.</p>
      </div>
    </div>
  );
}
