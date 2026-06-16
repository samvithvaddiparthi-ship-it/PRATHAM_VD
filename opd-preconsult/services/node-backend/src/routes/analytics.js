const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');

const router = Router();

// OPD analytics dashboard data
router.get('/summary', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = `NOW() - INTERVAL '${hours} hours'`;

    // Run all queries in parallel
    const [
      totalResult,
      byStateResult,
      byTriageResult,
      byDeptResult,
      byDoctorResult,
      avgTimesResult,
      followupResult,
    ] = await Promise.all([
      // Total sessions
      pool.query(`SELECT COUNT(*) as total FROM sessions WHERE created_at >= ${since}`),

      // Sessions by state
      pool.query(`SELECT state, COUNT(*) as count FROM sessions WHERE created_at >= ${since} GROUP BY state ORDER BY count DESC`),

      // Sessions by triage
      pool.query(`SELECT triage_level, COUNT(*) as count FROM sessions WHERE created_at >= ${since} GROUP BY triage_level ORDER BY count DESC`),

      // Sessions by department
      pool.query(`SELECT department, COUNT(*) as count, COUNT(*) FILTER (WHERE state = 'COMPLETE') as completed FROM sessions WHERE created_at >= ${since} GROUP BY department ORDER BY count DESC`),

      // Sessions per doctor (with avg consultation info)
      pool.query(`SELECT d.name, d.department, COUNT(s.id) as total, COUNT(*) FILTER (WHERE s.state = 'COMPLETE') as completed, COUNT(*) FILTER (WHERE s.triage_level = 'RED') as red_count FROM sessions s JOIN doctors d ON s.assigned_doctor_id = d.id WHERE s.created_at >= ${since} GROUP BY d.id, d.name, d.department ORDER BY total DESC`),

      // Average wait time (created_at to when doctor assigned) and total time (created_at to complete)
      pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (s.updated_at - s.created_at))) / 60 as avg_total_minutes, COUNT(*) as completed_count FROM sessions s WHERE s.state = 'COMPLETE' AND s.created_at >= ${since}`),

      // Follow-up stats
      pool.query(`SELECT status, COUNT(*) as count FROM scheduled_followups WHERE created_at >= ${since} GROUP BY status`).catch(() => ({ rows: [] })),
    ]);

    res.json({
      period_hours: hours,
      total_sessions: parseInt(totalResult.rows[0]?.total || 0),
      by_state: byStateResult.rows.map(r => ({ state: r.state, count: parseInt(r.count) })),
      by_triage: byTriageResult.rows.map(r => ({ level: r.triage_level || 'GREEN', count: parseInt(r.count) })),
      by_department: byDeptResult.rows.map(r => ({ department: r.department, total: parseInt(r.count), completed: parseInt(r.completed) })),
      by_doctor: byDoctorResult.rows.map(r => ({
        name: r.name, department: r.department,
        total: parseInt(r.total), completed: parseInt(r.completed),
        red_count: parseInt(r.red_count),
      })),
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
