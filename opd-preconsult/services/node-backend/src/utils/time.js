// The timezone that defines a "service day" for daily counters — the queue-token
// counter (queue_counters.service_date) rolls over at LOCAL midnight in this zone,
// not at the DB server's midnight (which is UTC in most deployments → 05:30 IST).
// Indian hospitals run on IST; override with APP_TIMEZONE if deployed elsewhere.
// Used in SQL as: (NOW() AT TIME ZONE $tz)::date  (pass APP_TIMEZONE as the param).
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

module.exports = { APP_TIMEZONE };
