-- Per-department display icon (an emoji) for the patient department picker.
-- Set by the OPD admin in HIS → Departments so a newly-added department shows a
-- meaningful picture instead of the generic fallback — important for low-literacy
-- patients who recognise the destination by image, not text.
--
-- Optional: NULL falls back in the frontend to a code-based guess (e.g. CARD → 🫀)
-- and then to a generic hospital symbol, so existing departments keep working.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS icon VARCHAR(16);
