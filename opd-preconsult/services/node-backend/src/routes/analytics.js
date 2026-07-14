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
// Dashboard-wide lifecycle vocabulary (identical wording everywhere in HIS):
//   Registered = got past the scan into registration (state <> 'INIT')
//   Ready      = finished the AI pre-consult (state = 'COMPLETE') — waiting for a doctor
//   Started    = a doctor opened the visit (consulted_at set) — consultation in progress
//   Completed  = doctor finished (dispatched_at set: Save & Generate QR / prescription)
//   waiting    = Ready but not yet picked up (live; matches the public board)
//   wait time  = arrival (created_at) → started (consulted_at)
//   consult    = started (consulted_at) → completed (dispatched_at)
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
          COUNT(*) FILTER (WHERE dispatched_at IS NOT NULL) AS dispatched,
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
        FROM sessions WHERE created_at >= ${since} AND department IS NOT NULL
        GROUP BY department ORDER BY total DESC`),

      // Per-doctor productivity: seen (opened) + avg consult time + workload
      pool.query(`
        SELECT d.name, d.department,
          COUNT(s.id) AS total,
          COUNT(*) FILTER (WHERE s.consulted_at IS NOT NULL) AS seen,
          COUNT(*) FILTER (WHERE s.dispatched_at IS NOT NULL) AS completed,
          COUNT(*) FILTER (WHERE s.triage_level = 'RED') AS red_count,
          COUNT(*) FILTER (WHERE s.triage_level = 'AMBER') AS amber_count,
          COUNT(*) FILTER (WHERE s.triage_level = 'GREEN') AS green_count,
          AVG(EXTRACT(EPOCH FROM (s.dispatched_at - s.consulted_at)) / 60.0)
            FILTER (WHERE s.dispatched_at IS NOT NULL AND s.consulted_at IS NOT NULL) AS avg_consult_minutes
        FROM sessions s JOIN doctors d ON s.assigned_doctor_id = d.id
        WHERE s.created_at >= ${since}
        GROUP BY d.id, d.name, d.department ORDER BY seen DESC, total DESC`),

      // Avg total journey: arrival (created_at) → completed consultation
      // (dispatched_at). Uses the finish stamp, NOT updated_at — which drifts on any
      // later edit (e.g. a report regen), inflating the number — so this is a true
      // end-to-end time for patients who actually reached "Completed".
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (s.dispatched_at - s.created_at)) / 60.0)
                    FILTER (WHERE s.dispatched_at IS NOT NULL) AS avg_total_minutes,
                  COUNT(*) FILTER (WHERE s.dispatched_at IS NOT NULL) AS completed_count
                  FROM sessions s WHERE s.created_at >= ${since}`),

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
      completed: parseInt(tp.completed || 0),        // reached pre-consult done -> "Ready"
      consulted: parseInt(tp.consulted || 0),        // doctor opened the visit  -> "Started"
      dispatched: parseInt(tp.dispatched || 0),      // doctor finished          -> "Completed"
      waiting: parseInt(tp.waiting || 0),
      avg_wait_minutes: num(tp.avg_wait_minutes),
      by_state: byStateResult.rows.map(r => ({ state: r.state, count: parseInt(r.count) })),
      // Preserve untriaged (no triage_level) as its own bucket — do NOT fold it
      // into GREEN. An untriaged session isn't "mild", it just never finished the
      // interview; merging the two produced a duplicate "GREEN" card on the dash.
      by_triage: byTriageResult.rows.map(r => ({ level: r.triage_level || 'NONE', count: parseInt(r.count) })),
      by_department: byDeptResult.rows.map(r => ({
        department: r.department,
        total: parseInt(r.total), registered: parseInt(r.registered),
        completed: parseInt(r.completed), consulted: parseInt(r.consulted),
        waiting: parseInt(r.waiting), avg_wait_minutes: num(r.avg_wait_minutes),
      })),
      by_doctor: byDoctorResult.rows.map(r => ({
        name: r.name, department: r.department,
        total: parseInt(r.total), seen: parseInt(r.seen), completed: parseInt(r.completed),
        red_count: parseInt(r.red_count), amber_count: parseInt(r.amber_count), green_count: parseInt(r.green_count),
        avg_consult_minutes: num(r.avg_consult_minutes),
      })),
      by_hour: byHourResult.rows.map(r => ({ hour: parseInt(r.hour), registrations: parseInt(r.registrations) })),
      avg_total_minutes: num(avgTimesResult.rows[0]?.avg_total_minutes),
      completed_count: parseInt(avgTimesResult.rows[0]?.completed_count || 0),
      followups: followupResult.rows.map(r => ({ status: r.status, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('analytics error:', err);
    sendServerError(res, err);
  }
});

module.exports = router;
