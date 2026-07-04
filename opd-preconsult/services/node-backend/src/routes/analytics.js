const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = Router();

// OPD analytics dashboard data — admin only (aggregate operational data).
//
// Tier 1 "the basics" an OPD administrator acts on: throughput, live queue load
// & wait time, triage mix, doctor productivity, peak-hour load. All computed from
// data we already store on sessions (created_at, state, triage_level, department,
// consulted_at, dispatched_at, assigned_doctor_id) + doctors.
//
// Definitions used below:
//   registered = got past the scan into registration (state <> 'INIT')
//   consulted  = a doctor opened the visit (consulted_at set)
//   waiting    = finished pre-consult, not yet picked up (matches the public board)
//   wait time  = arrival (created_at) → seen (consulted_at)
//   consult    = lock (consulted_at) → Save & Generate QR (dispatched_at)
router.get('/summary', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;   // integer — safe to inline
    const since = `NOW() - INTERVAL '${hours} hours'`;

    // Reusable FILTER fragments so the same definitions apply everywhere.
    const WAITING = `state = 'COMPLETE' AND consulted_at IS NULL AND dispatched_at IS NULL AND removed_at IS NULL`;

    const [
      throughputResult,
      byStateResult,
      byTriageResult,
      byDeptResult,
      byDoctorResult,
      avgTimesResult,
      byHourResult,
      followupResult,
    ] = await Promise.all([
      // Overall throughput + live queue load + avg arrival→seen wait
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE state <> 'INIT') AS registered,
          COUNT(*) FILTER (WHERE state = 'COMPLETE') AS completed,
          COUNT(*) FILTER (WHERE consulted_at IS NOT NULL) AS consulted,
          COUNT(*) FILTER (WHERE ${WAITING}) AS waiting,
          AVG(EXTRACT(EPOCH FROM (consulted_at - created_at)) / 60.0)
            FILTER (WHERE consulted_at IS NOT NULL) AS avg_wait_minutes
        FROM sessions WHERE created_at >= ${since}`),

      // Sessions by state (raw funnel)
      pool.query(`SELECT state, COUNT(*) as count FROM sessions WHERE created_at >= ${since} GROUP BY state ORDER BY count DESC`),

      // Triage mix
      pool.query(`SELECT triage_level, COUNT(*) as count FROM sessions WHERE created_at >= ${since} GROUP BY triage_level ORDER BY count DESC`),

      // Per-department throughput + live load + wait
      pool.query(`
        SELECT department,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE state <> 'INIT') AS registered,
          COUNT(*) FILTER (WHERE state = 'COMPLETE') AS completed,
          COUNT(*) FILTER (WHERE consulted_at IS NOT NULL) AS consulted,
          COUNT(*) FILTER (WHERE ${WAITING}) AS waiting,
          AVG(EXTRACT(EPOCH FROM (consulted_at - created_at)) / 60.0)
            FILTER (WHERE consulted_at IS NOT NULL) AS avg_wait_minutes
        FROM sessions WHERE created_at >= ${since}
        GROUP BY department ORDER BY total DESC`),

      // Per-doctor productivity: seen (opened) + avg consult time + workload
      pool.query(`
        SELECT d.name, d.department,
          COUNT(s.id) AS total,
          COUNT(*) FILTER (WHERE s.consulted_at IS NOT NULL) AS seen,
          COUNT(*) FILTER (WHERE s.state = 'COMPLETE') AS completed,
          COUNT(*) FILTER (WHERE s.triage_level = 'RED') AS red_count,
          AVG(EXTRACT(EPOCH FROM (s.dispatched_at - s.consulted_at)) / 60.0)
            FILTER (WHERE s.dispatched_at IS NOT NULL AND s.consulted_at IS NOT NULL) AS avg_consult_minutes
        FROM sessions s JOIN doctors d ON s.assigned_doctor_id = d.id
        WHERE s.created_at >= ${since}
        GROUP BY d.id, d.name, d.department ORDER BY seen DESC, total DESC`),

      // Avg total time (arrival → complete) — kept for back-compat
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (s.updated_at - s.created_at))) / 60 as avg_total_minutes, COUNT(*) as completed_count FROM sessions s WHERE s.state = 'COMPLETE' AND s.created_at >= ${since}`),

      // Peak-hour histogram: registrations by hour of day (0–23)
      pool.query(`
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
          COUNT(*) FILTER (WHERE state <> 'INIT') AS registrations
        FROM sessions WHERE created_at >= ${since}
        GROUP BY hour ORDER BY hour`),

      // Follow-up stats (optional table)
      pool.query(`SELECT status, COUNT(*) as count FROM scheduled_followups WHERE created_at >= ${since} GROUP BY status`).catch(() => ({ rows: [] })),
    ]);

    const tp = throughputResult.rows[0] || {};
    const num = (v) => (v == null ? null : parseFloat(parseFloat(v).toFixed(1)));

    res.json({
      period_hours: hours,
      // Overall throughput + queue load
      total_sessions: parseInt(tp.total || 0),
      registered: parseInt(tp.registered || 0),
      completed: parseInt(tp.completed || 0),
      consulted: parseInt(tp.consulted || 0),
      waiting: parseInt(tp.waiting || 0),
      avg_wait_minutes: num(tp.avg_wait_minutes),
      by_state: byStateResult.rows.map(r => ({ state: r.state, count: parseInt(r.count) })),
      by_triage: byTriageResult.rows.map(r => ({ level: r.triage_level || 'GREEN', count: parseInt(r.count) })),
      by_department: byDeptResult.rows.map(r => ({
        department: r.department,
        total: parseInt(r.total), registered: parseInt(r.registered),
        completed: parseInt(r.completed), consulted: parseInt(r.consulted),
        waiting: parseInt(r.waiting), avg_wait_minutes: num(r.avg_wait_minutes),
      })),
      by_doctor: byDoctorResult.rows.map(r => ({
        name: r.name, department: r.department,
        total: parseInt(r.total), seen: parseInt(r.seen), completed: parseInt(r.completed),
        red_count: parseInt(r.red_count), avg_consult_minutes: num(r.avg_consult_minutes),
      })),
      by_hour: byHourResult.rows.map(r => ({ hour: parseInt(r.hour), registrations: parseInt(r.registrations) })),
      avg_total_minutes: parseFloat(avgTimesResult.rows[0]?.avg_total_minutes || 0).toFixed(1),
      completed_count: parseInt(avgTimesResult.rows[0]?.completed_count || 0),
      followups: followupResult.rows.map(r => ({ status: r.status, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('analytics error:', err);
    sendServerError(res, err);
  }
});

module.exports = router;
