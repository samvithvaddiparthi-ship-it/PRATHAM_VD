-- Report tickets — a channel from the doctor (clinic floor) to HIS (the people who
-- maintain the questionnaires/prompts).
--
-- The doctor already marks each AI summary Accurate/Inaccurate and can edit it. That
-- covers "wrong for THIS patient." A ticket is the separate, systemic channel: "this
-- is a questionnaire/prompt problem" (a missing question, a wrong extraction, etc.)
-- that HIS should review and fix — then Publish via the questionnaire editor.
--
-- ON DELETE CASCADE: tickets are operational metadata, not clinical records, so when
-- a session is erased (DPDP) its tickets go with it automatically.
CREATE TABLE IF NOT EXISTS report_tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID REFERENCES sessions(id) ON DELETE CASCADE,
  department     VARCHAR(32),
  raised_by      UUID,               -- doctors.id (null if raised by an admin)
  raised_by_name VARCHAR(128),
  category       VARCHAR(48) NOT NULL,
  note           TEXT,
  status         VARCHAR(16) NOT NULL DEFAULT 'open',  -- open | triaged | resolved
  resolution     TEXT,
  resolved_by    VARCHAR(128),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_tickets_status ON report_tickets(status);
CREATE INDEX IF NOT EXISTS idx_report_tickets_created ON report_tickets(created_at DESC);
