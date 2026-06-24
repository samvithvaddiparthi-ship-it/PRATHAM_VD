'use client';
import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import TriageBadge from '../../components/TriageBadge';
import RxDocument from '../../components/RxDocument';
import ReactMarkdown from 'react-markdown';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';

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

export default function HISPage() {
  const [tab, setTab] = useState('sessions');
  const [sessions, setSessions] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [depts, setDepts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ department: '', doctor_id: '', triage: '', state: '' });
  const [showFilters, setShowFilters] = useState(false);   // filter popover open?
  const [search, setSearch] = useState('');                // name / phone search
  const { toast, toastView } = useToast();
  // Monotonic request id — only the most recently issued all-sessions response
  // is allowed to update state, so a slow/older request (or an overlapping poll)
  // can never paint stale rows over a freshly-filtered list.
  const loadSeq = useRef(0);

  // Static lists only need to load once.
  useEffect(() => {
    loadDoctors();
    loadDepts();
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

  async function selectSession(s) {
    setSelected(s);
    setReport(null);
    setLoading(true);
    try { setReport(await api.getReport(s.id)); } catch { setReport(null); }
    setLoading(false);
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
    // Use the reassign endpoint with null — but we need unassign via direct API
    // Actually we have doctorUnassign but it needs a doctor token. For HIS, use reassign route workaround.
    // Let's call the node backend directly for unassign
    try {
      const res = await fetch(`/api/doctor/reassign/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_doctor_id: null }),
      });
      if (!res.ok) throw new Error('Failed');
      loadData();
    } catch {
      // Fallback: set via session endpoint
      toast('Unassign requires doctor login. Use reassign instead.', 'error');
    }
  }

  // Client-side name/phone search over the (already filtered) sessions.
  const q = search.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter(s =>
        (s.patient_name || '').toLowerCase().includes(q) ||
        (s.patient_phone || '').toLowerCase().includes(q))
    : sessions;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: 16, minHeight: '100vh' }}>
      {toastView}
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, color: 'var(--primary)' }}>🏥 HIS Dashboard</h1>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>Hospital Information System</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className={`btn ${tab === 'sessions' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('sessions')}>Patients</button>
          <button className={`btn ${tab === 'analytics' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('analytics')}>Analytics</button>
          <button className={`btn ${tab === 'departments' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('departments')}>Departments</button>
          <button className={`btn ${tab === 'doctors' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('doctors')}>Doctors</button>
          <button className={`btn ${tab === 'questions' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('questions')}>Questionnaires</button>
          <button className={`btn ${tab === 'protocols' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('protocols')}>Protocols</button>
          <button className={`btn ${tab === 'formulary' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('formulary')}>Drug Formulary</button>
          <button className={`btn ${tab === 'rxtemplate' ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={() => setTab('rxtemplate')}>Rx Template</button>
        </div>
      </div>

      {tab === 'rxtemplate' ? (
        <RxTemplateManager />
      ) : tab === 'formulary' ? (
        <FormularyManager />
      ) : tab === 'doctors' ? (
        <DoctorInfo doctors={doctors} depts={depts} onChange={loadDoctors} />
      ) : tab === 'questions' ? (
        <QuestionsManager depts={depts} />
      ) : tab === 'departments' ? (
        <DepartmentsManager depts={depts} onChange={loadDepts} />
      ) : tab === 'protocols' ? (
        <ProtocolsManager depts={depts} />
      ) : tab === 'analytics' ? (
        <AnalyticsDashboard />
      ) : (<>

      {/* Filters — a single "Filter" button opens a popover holding every filter
          (Department, Doctor, Triage, State) with a Clear button at the bottom.
          The Doctor list is scoped to the chosen Department so they can't
          contradict; changing department drops an out-of-dept doctor. */}
      {(() => {
        const fieldLabel = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 6, display: 'block' };
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
              {/* ghost overlay — mirrors typed text (transparent) then grey tail */}
              {ghostTail && (
                <div aria-hidden style={{ position: 'absolute', inset: 0, paddingLeft: 36, paddingRight: 12,
                  display: 'flex', alignItems: 'center', fontSize: 14, whiteSpace: 'pre', pointerEvents: 'none', overflow: 'hidden' }}>
                  <span style={{ color: 'transparent' }}>{search}</span>
                  <span style={{ color: '#A0AEC0' }}>{ghostTail}</span>
                </div>
              )}
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostTail) { e.preventDefault(); acceptGhost(); }
                  if (e.key === 'Escape') setSearch('');
                }}
                placeholder="Search patient name or phone…"
                style={{ width: '100%', height: 40, paddingLeft: 36, paddingRight: search ? 32 : 12,
                  border: '1px solid #CBD5E0', borderRadius: 10, fontSize: 14, background: 'transparent',
                  outline: 'none', position: 'relative' }}
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
              {suggestions.length > 0 && (
                <div style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 41, background: '#fff',
                  borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', border: '1px solid #E2E8F0', overflow: 'hidden' }}>
                  {suggestions.map(s => (
                    <button key={s.id} onClick={() => { setSearch(s.patient_name || s.patient_phone || ''); selectSession(s); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                        gap: 8, padding: '9px 12px', background: 'none', border: 'none', borderBottom: '1px solid #F2F2F2',
                        cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F5F9FC'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                      <span style={{ fontWeight: 600 }}>{s.patient_name || 'Unregistered'}</span>
                      <span style={{ color: 'var(--text-light)', fontSize: 12 }}>{s.patient_phone || ''} · {s.department}</span>
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
                  fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                Filter
                {activeCount > 0 && (
                  <span style={{ background: activeCount ? 'rgba(255,255,255,0.25)' : 'var(--secondary)',
                    color: '#fff', borderRadius: 10, minWidth: 20, height: 20, padding: '0 6px',
                    fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
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
                        <option value="COMPLETE">Completed</option>
                        <option value="INTERVIEW">In Interview</option>
                        <option value="VITALS">Vitals</option>
                        <option value="REGISTERED">Registered</option>
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
                        fontSize: 13, fontWeight: 600, cursor: activeCount ? 'pointer' : 'default', transition: 'background 0.12s',
                      }}>
                      <XIcon /> Clear filters
                    </button>
                  </div>
                </>
              )}
            </div>

            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
              {visibleSessions.length}
              <span style={{ color: 'var(--text-light)', fontWeight: 400 }}> patient{visibleSessions.length !== 1 ? 's' : ''}</span>
            </span>
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* Patient Table */}
        <div style={{ flex: 1, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <thead>
              <tr style={{ background: 'var(--primary)', color: '#fff', fontSize: 13 }}>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Patient</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Dept</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Triage</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>State</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Consult Time</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Doctor</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Assign / Reassign</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map(s => (
                <tr key={s.id} onClick={() => selectSession(s)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid #F0F0F0',
                    background: selected?.id === s.id ? '#EBF5FB' : 'transparent' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    <strong>{s.patient_name || 'Unregistered'}</strong>
                    <br /><span style={{ color: 'var(--text-light)', fontSize: 11 }}>
                      {s.patient_age ? `${s.patient_age}y` : ''} {s.patient_gender || ''} · #{s.queue_slot || '-'}
                    </span>
                    {s.created_at && (
                      <><br /><span style={{ color: 'var(--text-light)', fontSize: 11 }}>
                        🗓 {fmtDateTime(s.created_at)}
                      </span></>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{s.department}</td>
                  <td style={{ padding: '10px 12px' }}><TriageBadge level={s.triage_level} /></td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 4, fontSize: 11,
                      background: s.state === 'COMPLETE' ? '#D5F5E3' : s.state === 'INTERVIEW' ? '#D6EAF8' : '#F8F9FA',
                      color: s.state === 'COMPLETE' ? '#1E8449' : 'var(--text)'
                    }}>{s.state}</span>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    {(() => {
                      const dur = consultDuration(s);
                      if (dur) return <span style={{ fontWeight: 600, color: 'var(--secondary)' }}>⏱ {dur}</span>;
                      if (s.consulted_at && !s.dispatched_at) return <span style={{ color: 'var(--amber)', fontSize: 11 }}>In progress</span>;
                      return <span style={{ color: 'var(--text-light)', fontSize: 11 }}>—</span>;
                    })()}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    {s.doctor_name || <span style={{ color: 'var(--amber)', fontSize: 11 }}>Unassigned</span>}
                  </td>
                  <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                    <select
                      value={s.assigned_doctor_id || ''}
                      onChange={e => {
                        const val = e.target.value;
                        if (val) handleReassign(s.id, val);
                        else handleUnassign(s.id);
                      }}
                      style={{ border: '1px solid #ccc', borderRadius: 6, padding: '4px 6px', fontSize: 12, cursor: 'pointer', maxWidth: 160 }}>
                      <option value="">Unassigned</option>
                      {doctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
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
              <h3 style={{ fontSize: 16 }}>{selected.patient_name}</h3>
              <button onClick={() => { setSelected(null); setReport(null); }}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 12 }}>
              {selected.patient_age ? `${selected.patient_age}y` : ''} {selected.patient_gender || ''} · {selected.department} · Doctor: {selected.doctor_name || 'Unassigned'}
            </p>

            {loading && <p style={{ color: 'var(--text-light)' }}>Loading report...</p>}
            {report ? (
              <div style={{ lineHeight: 1.7, fontSize: 14 }}>
                <ReactMarkdown>{report.report_md}</ReactMarkdown>
              </div>
            ) : (
              !loading && <p style={{ color: 'var(--text-light)' }}>No report generated yet.</p>
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

  const th = { padding: '11px 14px', textAlign: 'left', fontSize: 12, fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap' };
  const td = { padding: '11px 14px', fontSize: 13, whiteSpace: 'nowrap' };
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
            <div aria-hidden style={{ position: 'absolute', inset: 0, paddingLeft: 36, paddingRight: 12,
              display: 'flex', alignItems: 'center', fontSize: 14, whiteSpace: 'pre', pointerEvents: 'none', overflow: 'hidden' }}>
              <span style={{ color: 'transparent' }}>{search}</span>
              <span style={{ color: '#A0AEC0' }}>{ghostTail}</span>
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
            style={{ width: '100%', height: 40, paddingLeft: 36, paddingRight: search ? 32 : 12,
              border: '1px solid #CBD5E0', borderRadius: 10, fontSize: 14, background: 'transparent', outline: 'none' }}
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
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}
          style={{ marginLeft: 'auto', height: 40, width: 'auto', padding: '0 18px', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          + Add Doctor
        </button>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          ['Doctors', doctors.length, 'var(--primary)'],
          ['Patients assigned', totals.total, 'var(--text)'],
          ['Completed', totals.completed, 'var(--green)'],
          ['Active', totals.active, 'var(--secondary)'],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: '#fff', borderRadius: 12, padding: '12px 18px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minWidth: 120 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
            <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
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
                  <td style={td}><span style={{ fontSize: 12, color: 'var(--text-light)' }}>{d.department || '—'}</span></td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.total, 'var(--text)')}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.completed, 'var(--green)')}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{numChip(st.active, 'var(--secondary)')}</td>
                  <td style={{ ...td, textAlign: 'center', fontWeight: 600 }}>{fmtMs(avgMsFor(d))}</td>
                  <td style={td}><span style={{ fontSize: 12, color: 'var(--text-light)' }}>{st.lastAt ? fmtDateTime(st.lastAt) : '—'}</span></td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11,
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
            <div style={{ fontSize: small ? 14 : 18, fontWeight: 700, color: color || 'var(--text)' }}>{val}</div>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>{label}</div>
          </div>
        );
        return (
          <>
            <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 50 }} />
            <div style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 380, background: '#fff', zIndex: 51,
              boxShadow: '-6px 0 24px rgba(0,0,0,0.15)', padding: 22, overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                  <h3 style={{ fontSize: 18, color: 'var(--primary)' }}>{selected.name}</h3>
                  <span style={{ fontSize: 12, color: 'var(--text-light)' }}>{selected.department}</span>
                </div>
                <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
                </button>
              </div>

              {/* Identity */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                {[['Phone', selected.phone || '—'], ['Department', selected.department || '—'], ['Reg. no.', selected.registration_no || '—']].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-light)' }}>{k}</span>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-light)' }}>Status</span>
                  <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: selected.is_active ? '#D5F5E3' : '#F8F9FA', color: selected.is_active ? '#1E8449' : 'var(--text-light)' }}>
                    {selected.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              {/* Stats */}
              <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 8 }}>Workload (all-time)</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {cell('Total', st.total)}
                {cell('Completed', st.completed, 'var(--green)')}
                {cell('Active', st.active, 'var(--secondary)')}
                {cell('Avg. Consult', fmtMs(avgMsFor(selected)))}
                {cell('Last Consult', st.lastAt ? fmtDateTime(st.lastAt) : '—', null, true)}
              </div>

              <button onClick={() => setShowEdit(true)}
                style={{ marginTop: 18, width: '100%', height: 42, borderRadius: 10, background: '#fff', color: 'var(--primary)', border: '1px solid #CBD5E0', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Edit details
              </button>

              {selected.is_active ? (
                <button onClick={() => handleDeactivate(selected)}
                  style={{ marginTop: 10, width: '100%', height: 42, borderRadius: 10, background: '#FDEDEC', color: '#C0392B', border: '1px solid #F1B0A8', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Deactivate doctor
                </button>
              ) : (
                <button onClick={() => handleReactivate(selected)}
                  style={{ marginTop: 10, width: '100%', height: 42, borderRadius: 10, background: '#D5F5E3', color: '#1E8449', border: '1px solid #A9DFBF', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Reactivate doctor
                </button>
              )}
            </div>
          </>
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
      <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 10 }}>
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
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
        width: 400, maxWidth: '92vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 18, color: 'var(--primary)', flex: 1 }}>Add New Doctor</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dr. Ravi Kumar" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Department *</label>
            <select className="input" value={form.department}
              onChange={e => setForm({ ...form, department: e.target.value })}>
              {depts.filter(d => d.is_active).map(d => (
                <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Phone *</label>
            <input className="input" type="tel" required value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="9876500099" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Registration / license no. (optional)</label>
            <input className="input" value={form.registration_no}
              onChange={e => setForm({ ...form, registration_no: e.target.value })} placeholder="e.g. KMC-12345" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>PIN (4-6 digits) *</label>
            <input className="input" type="password" inputMode="numeric" maxLength={6} required value={form.pin}
              onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
              placeholder="••••" style={{ letterSpacing: 4 }} />
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}

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
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
        width: 400, maxWidth: '92vw', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 18, color: 'var(--primary)', flex: 1 }}>Edit Doctor</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--text-light)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dr. Ravi Kumar" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Department *</label>
            <select className="input" value={form.department}
              onChange={e => setForm({ ...form, department: e.target.value })}>
              {deptOptions.map(d => (
                <option key={d.code} value={d.code}>{d.name} ({d.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Phone *</label>
            <input className="input" type="tel" required value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="9876500099" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Registration / license no.</label>
            <input className="input" value={form.registration_no}
              onChange={e => setForm({ ...form, registration_no: e.target.value })} placeholder="e.g. KMC-12345" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Reset PIN (4-6 digits)</label>
            <input className="input" type="password" inputMode="numeric" maxLength={6} value={form.pin}
              onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
              placeholder="Leave blank to keep current" style={{ letterSpacing: form.pin ? 4 : 0 }} />
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}

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
  triage_flag: '', triage_answer: '', next_default: '', next_rules: [],
  sort_order: 0,
};

const Q_TYPES = ['BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT', 'FREE_TEXT', 'NUMERIC', 'TERMINAL'];

function QuestionsManager({ depts = [] }) {
  const [dept, setDept] = useState('CARD');
  const [questions, setQuestions] = useState([]);
  const [editing, setEditing] = useState(null); // null = list view, object = form
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  useEffect(() => { loadQuestions(); }, [dept]);

  async function loadQuestions() {
    // TERMINAL nodes are vestigial DAG sinks, not real questions — the patient's
    // "done" is the /patient/done page. Hide them from the editor list.
    try { setQuestions((await api.getQuestions(dept)).filter(q => q.q_type !== 'TERMINAL')); } catch {}
  }

  function startNew() {
    setEditing({ ...EMPTY_Q, department: dept, sort_order: questions.length + 1 });
    setError(''); setSuccess('');
  }

  function startEdit(q) {
    setEditing({
      ...q,
      triage_flag: q.triage_flag || '',
      triage_answer: q.triage_answer || '',
      next_default: q.next_default || '',
      next_rules: q.next_rules || [],
      options_json: q.options_json || null,
    });
    setError(''); setSuccess('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!editing.id || !editing.text_en) { setError('ID and English text required'); return; }

    setSaving(true);
    try {
      const data = {
        ...editing,
        triage_flag: editing.triage_flag || null,
        triage_answer: editing.triage_answer || null,
        next_default: editing.next_default || null,
        next_rules: editing.next_rules?.length ? editing.next_rules : null,
        options_json: editing.options_json?.length ? editing.options_json : null,
      };

      const existing = questions.find(q => q.id === editing.id);
      if (existing) {
        await api.updateQuestion(editing.id, data);
        setSuccess('Question updated');
      } else {
        await api.createQuestion(data);
        setSuccess('Question created');
      }
      loadQuestions();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!(await confirm({
      title: `Delete question "${id}"?`,
      message: 'This may break the questionnaire (DAG) flow if other questions depend on it.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    try {
      await api.deleteQuestion(id);
      loadQuestions();
      if (editing?.id === id) setEditing(null);
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  }

  // Options editor helpers
  function setOptions(opts) {
    setEditing(prev => ({ ...prev, options_json: opts }));
  }
  function addOption() {
    setOptions([...(editing.options_json || []), { value: '', label_en: '', label_hi: '', label_te: '' }]);
  }
  function removeOption(idx) {
    setOptions((editing.options_json || []).filter((_, i) => i !== idx));
  }
  function updateOption(idx, field, val) {
    const opts = [...(editing.options_json || [])];
    opts[idx] = { ...opts[idx], [field]: val };
    setOptions(opts);
  }

  // Next rules editor helpers
  function addRule() {
    setEditing(prev => ({ ...prev, next_rules: [...(prev.next_rules || []), { if_answer: '', go_to: '' }] }));
  }
  function removeRule(idx) {
    setEditing(prev => ({ ...prev, next_rules: (prev.next_rules || []).filter((_, i) => i !== idx) }));
  }
  function updateRule(idx, field, val) {
    setEditing(prev => {
      const rules = [...(prev.next_rules || [])];
      rules[idx] = { ...rules[idx], [field]: val };
      return { ...prev, next_rules: rules };
    });
  }

  const allIds = questions.map(q => q.id);

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {dialog}
      {toastView}
      {/* Left: question list */}
      <div style={{ width: 380, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <select className="input" style={{ width: 160 }} value={dept} onChange={e => setDept(e.target.value)}>
            {depts.filter(d => d.is_active).map(d => (
              <option key={d.code} value={d.code}>{d.name}</option>
            ))}
          </select>
          <button className="btn btn-primary" style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={startNew}>+ Add Question</button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>
          {questions.length} questions (sorted by flow order) ·
          <span style={{ color: '#7C5BA6', fontWeight: 600 }}> BASE</span> = shared intake, then department flow
        </p>

        {/* Independent scroll for the question list — the dept selector and count
            above stay put while only this list scrolls. */}
        <div style={{ maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: 6 }}>
          {questions.map((q, idx) => {
            const prev = questions[idx - 1];
            const dagStart = !q.is_base && (idx === 0 || prev?.is_base);
            return (
            <div key={q.id}>
            {dagStart && (
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-light)', textTransform: 'uppercase', margin: '10px 2px 4px' }}>
                — Department questions —
              </p>
            )}
            <div onClick={() => startEdit(q)}
              style={{
                background: editing?.id === q.id ? '#EBF5FB' : (q.is_base ? '#FAF8FD' : '#fff'),
                border: editing?.id === q.id ? '2px solid var(--secondary)' : '1px solid #E0E0E0',
                borderLeft: q.is_base ? '3px solid #9B7FC4' : (editing?.id === q.id ? '2px solid var(--secondary)' : '1px solid #E0E0E0'),
                borderRadius: 10, padding: 12, marginBottom: 6, cursor: 'pointer',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-light)', minWidth: 24 }}>{q.sort_order}</span>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{q.id}</span>
                {q.is_base && (
                  <span style={{ fontSize: 10, background: '#7C5BA6', color: '#fff', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>BASE</span>
                )}
                <span style={{ fontSize: 10, background: '#F0F0F0', padding: '2px 6px', borderRadius: 4 }}>{q.q_type}</span>
                {q.triage_flag && (
                  <span style={{ fontSize: 10, background: q.triage_flag === 'RED' ? 'var(--red)' : 'var(--amber)', color: '#fff', padding: '2px 6px', borderRadius: 4 }}>{q.triage_flag}</span>
                )}
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 4, lineHeight: 1.3 }}>{q.text_en}</p>
              {q.next_default && <p style={{ fontSize: 10, color: 'var(--secondary)', marginTop: 2 }}>next: {q.next_default}</p>}
            </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* Right: editor form */}
      <div style={{ flex: 1, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        {!editing ? (
          <p style={{ color: 'var(--text-light)', textAlign: 'center', marginTop: 40 }}>Select a question to edit, or click "+ Add Question"</p>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ fontSize: 16, color: 'var(--primary)', flex: 1 }}>
                {questions.find(q => q.id === editing.id) ? 'Edit Question' : 'New Question'}
              </h3>
              <button type="button" onClick={() => setEditing(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            {/* ID + Department */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Question ID *</label>
                <input className="input" required value={editing.id} placeholder="q_my_question"
                  onChange={e => setEditing({ ...editing, id: e.target.value })}
                  disabled={!!questions.find(q => q.id === editing.id)} />
              </div>
              <div style={{ width: 120 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Sort Order</label>
                <input className="input" type="number" value={editing.sort_order}
                  onChange={e => setEditing({ ...editing, sort_order: parseInt(e.target.value) || 0 })} />
              </div>
            </div>

            {/* Text fields */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Question text (English) *</label>
              <input className="input" required value={editing.text_en}
                onChange={e => setEditing({ ...editing, text_en: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Hindi</label>
                <input className="input" value={editing.text_hi || ''}
                  onChange={e => setEditing({ ...editing, text_hi: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Telugu</label>
                <input className="input" value={editing.text_te || ''}
                  onChange={e => setEditing({ ...editing, text_te: e.target.value })} />
              </div>
            </div>

            {/* Type */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Question Type *</label>
                <select className="input" value={editing.q_type}
                  onChange={e => setEditing({ ...editing, q_type: e.target.value })}>
                  {Q_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ width: 100 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Required</label>
                <select className="input" value={editing.required ? 'true' : 'false'}
                  onChange={e => setEditing({ ...editing, required: e.target.value === 'true' })}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>

            {/* Options (for SELECT types) */}
            {(editing.q_type === 'SINGLE_SELECT' || editing.q_type === 'MULTI_SELECT') && (
              <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Options</label>
                  <button type="button" onClick={addOption}
                    style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                    + Add
                  </button>
                </div>
                {(editing.options_json || []).map((opt, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                    <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={opt.value}
                      onChange={e => updateOption(i, 'value', e.target.value)} placeholder="value" />
                    <input className="input" style={{ flex: 2, minHeight: 32, fontSize: 12 }} value={opt.label_en}
                      onChange={e => updateOption(i, 'label_en', e.target.value)} placeholder="English label" />
                    <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={opt.label_hi || ''}
                      onChange={e => updateOption(i, 'label_hi', e.target.value)} placeholder="Hindi" />
                    <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={opt.label_te || ''}
                      onChange={e => updateOption(i, 'label_te', e.target.value)} placeholder="Telugu" />
                    <button type="button" onClick={() => removeOption(i)}
                      style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Triage */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Triage Flag (if answer triggers)</label>
                <select className="input" value={editing.triage_flag || ''}
                  onChange={e => setEditing({ ...editing, triage_flag: e.target.value })}>
                  <option value="">None</option>
                  <option value="RED">RED</option>
                  <option value="AMBER">AMBER</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Trigger answer value</label>
                <input className="input" value={editing.triage_answer || ''}
                  onChange={e => setEditing({ ...editing, triage_answer: e.target.value })} placeholder="e.g. yes" />
              </div>
            </div>

            {/* Navigation */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Default next question</label>
              <select className="input" value={editing.next_default || ''}
                onChange={e => setEditing({ ...editing, next_default: e.target.value })}>
                <option value="">None (terminal)</option>
                {allIds.filter(id => id !== editing.id).map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>

            {/* Conditional next rules */}
            <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600 }}>Branching Rules</label>
                <button type="button" onClick={addRule}
                  style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                  + Add Rule
                </button>
              </div>
              <p style={{ fontSize: 10, color: 'var(--text-light)', marginBottom: 6 }}>If answer equals X, go to question Y (overrides default next)</p>
              {(editing.next_rules || []).map((rule, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-light)' }}>If answer =</span>
                  <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={rule.if_answer}
                    onChange={e => updateRule(i, 'if_answer', e.target.value)} placeholder="yes" />
                  <span style={{ fontSize: 11, color: 'var(--text-light)' }}>go to</span>
                  <select className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={rule.go_to}
                    onChange={e => updateRule(i, 'go_to', e.target.value)}>
                    <option value="">--</option>
                    {allIds.filter(id => id !== editing.id).map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                  <button type="button" onClick={() => removeRule(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                </div>
              ))}
            </div>

            {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
            {success && <p style={{ color: 'var(--green)', fontSize: 13 }}>{success}</p>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={saving} style={{ flex: 1 }}>
                {saving ? 'Saving...' : 'Save Question'}
              </button>
              {questions.find(q => q.id === editing.id) && (
                <button type="button" className="btn btn-outline" onClick={() => handleDelete(editing.id)}
                  style={{ borderColor: 'var(--red)', color: 'var(--red)', width: 'auto', padding: '0 16px' }}>
                  Delete
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}


function DepartmentsManager({ depts, onChange }) {
  const [form, setForm] = useState({ code: '', name: '', collect_vitals: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
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
      setForm({ code: '', name: '', collect_vitals: true });
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

  async function handleDelete(code) {
    if (!(await confirm({
      title: `Delete department "${code}"?`,
      message: 'Only possible if no doctors, patients, or questions are linked to it.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    try {
      await api.deleteDepartment(code);
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {dialog}
      {toastView}
      {/* Add form */}
      <div style={{ width: 360, flexShrink: 0, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', height: 'fit-content' }}>
        <h3 style={{ fontSize: 16, marginBottom: 16, color: 'var(--primary)' }}>Add New Department</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Code * (e.g. ORTHO, ENT, DERM)</label>
            <input className="input" required value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
              placeholder="ORTHO" maxLength={16} style={{ textTransform: 'uppercase' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-light)' }}>Display Name *</label>
            <input className="input" required value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Orthopaedics" />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.collect_vitals}
              onChange={e => setForm({ ...form, collect_vitals: e.target.checked })} />
            Collect vitals from patients
          </label>
          {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
          {success && <p style={{ color: 'var(--green)', fontSize: 13 }}>{success}</p>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Adding...' : 'Add Department'}
          </button>
        </form>
        <div style={{ marginTop: 20, padding: 12, background: '#F8F9FA', borderRadius: 8, fontSize: 12, color: 'var(--text-light)', lineHeight: 1.6 }}>
          <p><strong>After adding a department:</strong></p>
          <p>1. Go to <strong>Questionnaires</strong> tab to add questions for it</p>
          <p>2. Go to <strong>Manage Doctors</strong> tab to assign doctors to it</p>
          <p>3. Use the <strong>Copy QR</strong> button to generate a patient entry QR payload</p>
        </div>
      </div>

      {/* Department list */}
      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12, color: 'var(--primary)' }}>Departments ({depts.length})</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <thead>
            <tr style={{ background: 'var(--primary)', color: '#fff', fontSize: 13 }}>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>Code</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>Name</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>Collect Vitals</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>QR Payload</th>
              <th style={{ padding: '10px 12px', textAlign: 'left' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {depts.map(d => {
              const qr = typeof btoa !== 'undefined'
                ? btoa(JSON.stringify({ hospital_id: 'demo_hospital_01', department: d.code, queue_slot: 1 }))
                : '';
              return (
                <tr key={d.code} style={{ borderBottom: '1px solid #F0F0F0' }}>
                  <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 600 }}>{d.code}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14 }}>{d.name}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => handleToggleVitals(d)}
                      title="Toggle whether patients in this department are asked for vitals"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 999, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: d.collect_vitals ? '#D5F5E3' : '#F8F9FA', color: d.collect_vitals ? '#1E8449' : 'var(--text-light)' }}>
                      <span style={{ fontSize: 14 }}>{d.collect_vitals ? '✅' : '⚪'}</span>
                      {d.collect_vitals ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => { navigator.clipboard?.writeText(qr); toast('QR payload copied to clipboard', 'success'); }}
                      style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>
                      Copy QR
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button onClick={() => handleDelete(d.code)}
                      style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
          <button className="btn btn-primary" style={{ fontSize: 13, minHeight: 36, width: 'auto', padding: '0 16px' }}
            onClick={startNew}>+ Add Protocol</button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>{protocols.length} active protocols</p>

        {protocols.map(p => (
          <div key={p.id} onClick={() => startEdit(p)}
            style={{
              background: editing?.id === p.id ? '#EBF5FB' : '#fff',
              border: editing?.id === p.id ? '2px solid var(--secondary)' : '1px solid #E0E0E0',
              borderRadius: 10, padding: 12, marginBottom: 6, cursor: 'pointer',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 10, background: '#F0F0F0', padding: '2px 6px', borderRadius: 4 }}>v{p.version || '1.0'}</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>ID: {p.id}</p>
            {p.required_vitals?.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--secondary)', marginTop: 2 }}>Vitals: {p.required_vitals.join(', ')}</p>
            )}
            {p.required_tests?.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--secondary)', marginTop: 2 }}>Tests: {p.required_tests.join(', ')}</p>
            )}
          </div>
        ))}

        {protocols.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 32, fontSize: 13 }}>
            No protocols for this department. Click "+ Add Protocol" to create one.
          </p>
        )}
      </div>

      {/* Right: editor */}
      <div style={{ flex: 1, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        {!editing ? (
          <div style={{ color: 'var(--text-light)', textAlign: 'center', marginTop: 40 }}>
            <p>Select a protocol to edit, or click "+ Add Protocol"</p>
            <p style={{ fontSize: 12, marginTop: 8 }}>
              Protocols define clinical guardrails: trigger conditions (based on questionnaire answers),
              required vitals/tests, and pre-visit messages for patients.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ fontSize: 16, color: 'var(--primary)', flex: 1 }}>
                {protocols.find(p => p.id === editing.id) ? 'Edit Protocol' : 'New Protocol'}
              </h3>
              <button type="button" onClick={() => setEditing(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>

            {/* ID + Name */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Protocol ID *</label>
                <input className="input" required value={editing.id} placeholder="proto_chest_pain"
                  onChange={e => setEditing({ ...editing, id: e.target.value })}
                  disabled={!!protocols.find(p => p.id === editing.id)} />
              </div>
              <div style={{ width: 100 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Version</label>
                <input className="input" value={editing.version || '1.0'}
                  onChange={e => setEditing({ ...editing, version: e.target.value })} />
              </div>
            </div>

            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Protocol Name *</label>
              <input className="input" required value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                placeholder="Chest Pain Protocol" />
            </div>

            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Authored By</label>
              <input className="input" value={editing.authored_by || ''}
                onChange={e => setEditing({ ...editing, authored_by: e.target.value })}
                placeholder="Dr. Name" />
            </div>

            {/* Trigger Conditions */}
            <div style={{ background: '#F8F9FA', borderRadius: 8, padding: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Trigger Conditions</label>
              <p style={{ fontSize: 10, color: 'var(--text-light)', marginBottom: 8 }}>
                Question ID = expected answer. Protocol activates when any condition matches.
              </p>
              {Object.entries(editing.trigger_conditions || {}).map(([key, val]) => (
                <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={key} disabled />
                  <span style={{ fontSize: 11 }}>=</span>
                  <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} value={val}
                    onChange={e => setCondition(key, e.target.value)} />
                  <button type="button" onClick={() => removeCondition(key)}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} id="new-cond-key" placeholder="question_id" />
                <input className="input" style={{ flex: 1, minHeight: 32, fontSize: 12 }} id="new-cond-val" placeholder="answer" />
                <button type="button" onClick={() => {
                  const k = document.getElementById('new-cond-key').value.trim();
                  const v = document.getElementById('new-cond-val').value.trim();
                  if (k && v) { setCondition(k, v); document.getElementById('new-cond-key').value = ''; document.getElementById('new-cond-val').value = ''; }
                }} style={{ background: 'var(--secondary)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                  + Add
                </button>
              </div>
            </div>

            {/* Required Vitals */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Required Vitals (comma-separated)</label>
              <input className="input" value={(editing.required_vitals || []).join(', ')}
                onChange={e => updateList('required_vitals', e.target.value)}
                placeholder="BP, SpO2, Heart Rate" />
            </div>

            {/* Required Tests */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Required Tests (comma-separated)</label>
              <input className="input" value={(editing.required_tests || []).join(', ')}
                onChange={e => updateList('required_tests', e.target.value)}
                placeholder="Lipid Profile, ECG, Troponin" />
            </div>

            {/* Pre-visit messages */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Pre-visit Message (English)</label>
              <textarea className="input" rows={2} value={editing.pre_visit_msg_en || ''}
                onChange={e => setEditing({ ...editing, pre_visit_msg_en: e.target.value })}
                placeholder="Please bring your recent blood test reports..." />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Hindi</label>
                <textarea className="input" rows={2} value={editing.pre_visit_msg_hi || ''}
                  onChange={e => setEditing({ ...editing, pre_visit_msg_hi: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text-light)' }}>Telugu</label>
                <textarea className="input" rows={2} value={editing.pre_visit_msg_te || ''}
                  onChange={e => setEditing({ ...editing, pre_visit_msg_te: e.target.value })} />
              </div>
            </div>

            {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
            {success && <p style={{ color: 'var(--green)', fontSize: 13 }}>{success}</p>}

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

  const cardStyle = { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', flex: '1 1 200px', minWidth: 200 };
  const thStyle = { padding: '8px 12px', textAlign: 'left', fontSize: 12, background: 'var(--primary)', color: '#fff' };
  const tdStyle = { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid #F0F0F0' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>Period:</span>
        {[6, 12, 24, 48, 168].map(h => (
          <button key={h} className={`btn ${hours === h ? 'btn-primary' : 'btn-outline'}`}
            style={{ fontSize: 12, minHeight: 30, width: 'auto', padding: '0 12px' }}
            onClick={() => setHours(h)}>
            {h <= 24 ? `${h}h` : `${h / 24}d`}
          </button>
        ))}
        <button className="btn btn-outline" style={{ fontSize: 12, minHeight: 30, width: 'auto', padding: '0 12px', marginLeft: 'auto' }}
          onClick={loadData}>Refresh</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={cardStyle}>
          <p style={{ fontSize: 12, color: 'var(--text-light)' }}>Total Sessions</p>
          <p style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)' }}>{data.total_sessions}</p>
        </div>
        <div style={cardStyle}>
          <p style={{ fontSize: 12, color: 'var(--text-light)' }}>Completed</p>
          <p style={{ fontSize: 28, fontWeight: 700, color: 'var(--green)' }}>{data.completed_count}</p>
        </div>
        <div style={cardStyle}>
          <p style={{ fontSize: 12, color: 'var(--text-light)' }}>Avg Total Time</p>
          <p style={{ fontSize: 28, fontWeight: 700, color: 'var(--secondary)' }}>{data.avg_total_minutes} min</p>
        </div>
        {data.by_triage?.map(t => (
          <div key={t.level} style={cardStyle}>
            <p style={{ fontSize: 12, color: 'var(--text-light)' }}>{t.level || 'GREEN'} Triage</p>
            <p style={{ fontSize: 28, fontWeight: 700, color: t.level === 'RED' ? 'var(--red)' : t.level === 'AMBER' ? 'var(--amber)' : 'var(--green)' }}>{t.count}</p>
          </div>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>By Department</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thStyle}>Department</th><th style={thStyle}>Total</th><th style={thStyle}>Completed</th><th style={thStyle}>%</th>
          </tr></thead>
          <tbody>
            {data.by_department?.map(d => (
              <tr key={d.department}>
                <td style={tdStyle}><strong>{d.department}</strong></td>
                <td style={tdStyle}>{d.total}</td>
                <td style={tdStyle}>{d.completed}</td>
                <td style={tdStyle}>{d.total > 0 ? Math.round(d.completed / d.total * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>By Doctor</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={thStyle}>Doctor</th><th style={thStyle}>Dept</th><th style={thStyle}>Total</th><th style={thStyle}>Done</th><th style={thStyle}>RED</th>
          </tr></thead>
          <tbody>
            {data.by_doctor?.map(d => (
              <tr key={d.name}>
                <td style={tdStyle}><strong>{d.name}</strong></td>
                <td style={tdStyle}>{d.department}</td>
                <td style={tdStyle}>{d.total}</td>
                <td style={tdStyle}>{d.completed}</td>
                <td style={{ ...tdStyle, color: d.red_count > 0 ? 'var(--red)' : 'inherit', fontWeight: d.red_count > 0 ? 700 : 400 }}>{d.red_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data.by_doctor || data.by_doctor.length === 0) && (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: 16, fontSize: 13 }}>No doctor-assigned sessions</p>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {data.by_state?.map(s => (
          <div key={s.state} style={{ background: '#fff', borderRadius: 8, padding: '8px 16px', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <p style={{ fontSize: 11, color: 'var(--text-light)' }}>{s.state}</p>
            <p style={{ fontSize: 20, fontWeight: 600 }}>{s.count}</p>
          </div>
        ))}
      </div>

      {data.followups?.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 12 }}>Follow-ups</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {data.followups.map(f => (
              <div key={f.status} style={{ background: '#F8F9FA', borderRadius: 8, padding: '8px 16px', textAlign: 'center' }}>
                <p style={{ fontSize: 11, color: 'var(--text-light)' }}>{f.status}</p>
                <p style={{ fontSize: 20, fontWeight: 600 }}>{f.count}</p>
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

  const label = { fontSize: 12, color: 'var(--text-light)', marginBottom: 3, display: 'block' };
  const field = (key, ph) => (
    <input className="input" value={cfg[key] || ''} placeholder={ph}
      onChange={e => set(key, e.target.value)} style={{ height: 38 }} />
  );
  const Toggle = ({ k, text }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '4px 0' }}>
      <input type="checkbox" checked={!!show[k]} onChange={e => setShow(k, e.target.checked)}
        style={{ width: 16, height: 16, cursor: 'pointer' }} />
      {text}
    </label>
  );
  const sectionHead = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', margin: '16px 0 8px' };

  return (
    <div>
      {toastView}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Config form ── */}
        <div style={{ flex: '1 1 420px', minWidth: 360, background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <h3 style={{ fontSize: 16, color: 'var(--primary)', flex: 1 }}>Prescription Template</h3>
            <button className="btn btn-primary" onClick={save} disabled={saving} style={{ width: 'auto', padding: '0 18px', height: 38, fontSize: 14 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>
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
            <div style={{ gridColumn: '1 / -1' }}><label style={label}>Logo URL (optional)</label>{field('logo_url', 'https://…/logo.png')}</div>
          </div>

          <p style={sectionHead}>Theme</p>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {['classic', 'modern'].map(th => (
              <label key={th} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', textTransform: 'capitalize' }}>
                <input type="radio" name="rx-theme" checked={(cfg.theme || 'classic') === th} onChange={() => set('theme', th)} /> {th}
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginLeft: 'auto' }}>
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
              <input className="input" type="number" min="1" value={cfg.valid_days ?? 30}
                onChange={e => set('valid_days', parseInt(e.target.value) || 0)} style={{ height: 38, width: 120 }} />
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
          <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-light)', marginBottom: 8 }}>Live preview</p>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, boxShadow: '0 4px 20px rgba(0,0,0,.08)' }}>
            <RxDocument rx={RX_SAMPLE} template={cfg} verified={true} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 8 }}>Sample data — this is exactly how a patient's verified prescription will render.</p>
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
  const [drugForm, setDrugForm] = useState({ generic: '', classes: '', aliases: '' });
  const [intForm, setIntForm] = useState({ generic_a: '', generic_b: '', severity: 'warn', description: '' });
  const { confirm, dialog } = useConfirm();
  const { toast, toastView } = useToast();

  async function loadAll() {
    setLoading(true);
    try {
      const [q, d, i, c] = await Promise.all([
        api.reviewQueue().catch(() => []),
        api.formularyDrugs().catch(() => []),
        api.formularyInteractions().catch(() => []),
        api.formularyClassInteractions().catch(() => []),
      ]);
      setQueue(q || []); setDrugs(d || []); setInter(i || []); setClassInter(c || []);
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
  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '.03em' };
  const td = { padding: '6px 8px', fontSize: 13, borderTop: '1px solid #F0F0F0' };
  const sev = (s) => <span style={{ fontWeight: 700, color: s === 'block' ? 'var(--red)' : '#B9770E' }}>{(s || '').toUpperCase()}</span>;

  if (loading) return <div style={{ padding: 24, color: 'var(--text-light)' }}>Loading formulary…</div>;

  return (
    <div>
      {dialog}{toastView}

      {/* Review queue — AI findings awaiting curation */}
      <div style={card}>
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 4 }}>AI Review Queue <span style={{ fontSize: 12, color: 'var(--text-light)' }}>({queue.length} pending)</span></h3>
        <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 10 }}>
          Interactions the AI flagged for drugs not yet in the formulary. Approving adds the drug + a curated interaction; nothing here affects checks until approved.
        </p>
        {queue.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-light)' }}>Nothing pending.</p> : (
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
                              style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                              {open ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td style={td}>{q.ai_confidence != null ? Math.round(q.ai_confidence * 100) + '%' : '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button onClick={() => approve(q)} style={{ background: 'var(--green)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', marginRight: 6 }}>Approve</button>
                    <button onClick={() => dismiss(q)} style={{ background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Curated interactions */}
      <div style={card}>
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 10 }}>Curated Interactions <span style={{ fontSize: 12, color: 'var(--text-light)' }}>({inter.length})</span></h3>
        <form onSubmit={addInteraction} style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" placeholder="drug a (generic)" value={intForm.generic_a} onChange={e => setIntForm({ ...intForm, generic_a: e.target.value })} style={{ width: 150, minHeight: 34 }} />
          <input className="input" placeholder="drug b (generic)" value={intForm.generic_b} onChange={e => setIntForm({ ...intForm, generic_b: e.target.value })} style={{ width: 150, minHeight: 34 }} />
          <select className="input" value={intForm.severity} onChange={e => setIntForm({ ...intForm, severity: e.target.value })} style={{ width: 100, minHeight: 34 }}><option value="warn">warn</option><option value="block">block</option></select>
          <input className="input" placeholder="description" value={intForm.description} onChange={e => setIntForm({ ...intForm, description: e.target.value })} style={{ flex: 1, minWidth: 180, minHeight: 34 }} />
          <button className="btn btn-primary" type="submit" style={{ width: 'auto', minHeight: 34, padding: '0 16px', fontSize: 13 }}>Add</button>
        </form>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>A</th><th style={th}>B</th><th style={th}>Severity</th><th style={th}>Description</th><th style={th}>Src</th><th style={th}></th></tr></thead>
            <tbody>
              {inter.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.generic_a}</td><td style={td}>{r.generic_b}</td><td style={td}>{sev(r.severity)}</td>
                  <td style={{ ...td, maxWidth: 320 }}>{r.description}</td><td style={td}>{r.source}</td>
                  <td style={td}><button onClick={() => delInteraction(r.id)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 14 }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Curated drugs */}
      <div style={card}>
        <h3 style={{ fontSize: 15, color: 'var(--primary)', marginBottom: 10 }}>Formulary Drugs <span style={{ fontSize: 12, color: 'var(--text-light)' }}>({drugs.length})</span></h3>
        <form onSubmit={addDrug} style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" placeholder="generic name" value={drugForm.generic} onChange={e => setDrugForm({ ...drugForm, generic: e.target.value })} style={{ width: 160, minHeight: 34 }} />
          <input className="input" placeholder="classes (comma sep)" value={drugForm.classes} onChange={e => setDrugForm({ ...drugForm, classes: e.target.value })} style={{ width: 200, minHeight: 34 }} />
          <input className="input" placeholder="brand aliases (comma sep)" value={drugForm.aliases} onChange={e => setDrugForm({ ...drugForm, aliases: e.target.value })} style={{ flex: 1, minWidth: 180, minHeight: 34 }} />
          <button className="btn btn-primary" type="submit" style={{ width: 'auto', minHeight: 34, padding: '0 16px', fontSize: 13 }}>Add</button>
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
                  <td style={td}><button onClick={() => delDrug(d.generic)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 14 }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 8 }}>Class-vs-class rules ({classInter.length}) are also active and editable via the API.</p>
      </div>
    </div>
  );
}
