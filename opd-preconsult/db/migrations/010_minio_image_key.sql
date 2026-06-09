-- Migration 010: Add image_key column to session_documents
-- Stores the MinIO object key (path) for the original uploaded image.
-- NULL means the document was uploaded before MinIO wiring was added.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'session_documents' AND column_name = 'image_key'
    ) THEN
        ALTER TABLE session_documents ADD COLUMN image_key TEXT;
        RAISE NOTICE 'Added image_key column to session_documents';
    ELSE
        RAISE NOTICE 'image_key column already exists, skipping';
    END IF;
END $$;
