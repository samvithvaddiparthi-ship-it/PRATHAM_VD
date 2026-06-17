-- Per-answer voice recordings.
--
-- When a patient answers a free-text question by voice, we now keep the ACTUAL
-- audio (not just the transcribed text) so the doctor can listen back. The audio
-- bytes live in MinIO (object_key); this table is the index linking each clip to
-- its session + question, with the transcript captured at record time.
--
-- This is also the foundation for Bhashini: later, server-side transcription
-- runs on these same stored clips instead of the browser's speech engine.
CREATE TABLE IF NOT EXISTS answer_audio (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL,
  question_id TEXT,
  object_key  TEXT NOT NULL,
  mime        TEXT,
  duration_ms INTEGER,
  transcript  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_answer_audio_session ON answer_audio(session_id);
