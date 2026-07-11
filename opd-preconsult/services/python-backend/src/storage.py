"""
MinIO object storage helper.
Handles connection, bucket creation, and file uploads.
All other code should use this module — never import minio directly.
"""
import os
import io
import logging
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)

_client = None
_bucket = None


def _get_client():
    """Get or create the MinIO client (lazy init)."""
    global _client, _bucket

    if _client is not None:
        return _client, _bucket

    endpoint = os.getenv("MINIO_ENDPOINT", "minio")
    port = int(os.getenv("MINIO_PORT", "9000"))
    access_key = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    secret_key = os.getenv("MINIO_SECRET_KEY", "changeme_in_production")
    bucket = os.getenv("MINIO_BUCKET", "opd-documents")

    from minio import Minio
    client = Minio(
        f"{endpoint}:{port}",
        access_key=access_key,
        secret_key=secret_key,
        secure=False,  # no HTTPS locally
    )

    # Auto-create bucket if it doesn't exist
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
        logger.info("storage created bucket: %s", bucket)
    else:
        logger.info("storage bucket ready: %s", bucket)

    _maybe_enable_encryption(client, bucket)

    _client = client
    _bucket = bucket
    return _client, _bucket


def _maybe_enable_encryption(client, bucket: str) -> None:
    """B1 — encryption at rest for uploaded PHI (prescriptions, reports, audio).

    When a KMS key is configured on the MinIO server (`MINIO_KMS_SECRET_KEY`, set
    by docker-compose.prod.yml), turn on the bucket's DEFAULT encryption to
    SSE-S3 so every newly uploaded object is encrypted on disk transparently —
    PUT/GET are unchanged (MinIO encrypts on write, decrypts on read). Existing
    objects stay readable (they're just unencrypted).

    Guarded by the env var so dev (no KMS) is untouched: without a KMS key on the
    server, requesting SSE would make uploads fail, so we only enable it when the
    key is present. Best-effort + non-fatal — a failure here must never break
    uploads.
    """
    if not (os.getenv("MINIO_KMS_SECRET_KEY") or "").strip():
        return
    try:
        from minio.sseconfig import Rule, SSEConfig
        client.set_bucket_encryption(bucket, SSEConfig(Rule.new_sse_s3_rule()))
        logger.info("storage encryption at rest (SSE-S3) ensured on bucket: %s", bucket)
    except Exception:
        logger.warning("storage could not set bucket encryption (non-fatal)", exc_info=True)


def upload_document(file_bytes: bytes, filename: str, session_id: str, content_type: str = "image/jpeg") -> str:
    """
    Upload a document image to MinIO.
    Returns the object key (path inside the bucket) to store in the DB.

    Object key format: sessions/<session_id>/<timestamp>_<uuid>_<filename>
    Example: sessions/abc-123/20260605_143022_a1b2c3_prescription.jpg
    """
    try:
        client, bucket = _get_client()

        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        safe_filename = filename.replace(" ", "_")
        object_key = f"sessions/{session_id}/{timestamp}_{unique_id}_{safe_filename}"

        client.put_object(
            bucket_name=bucket,
            object_name=object_key,
            data=io.BytesIO(file_bytes),
            length=len(file_bytes),
            content_type=content_type,
        )

        logger.info("storage uploaded: %s (%d bytes)", object_key, len(file_bytes))
        return object_key

    except Exception:
        # Storage failure should NOT break OCR — log and continue
        logger.warning("storage upload failed (non-fatal)", exc_info=True)
        return None


def get_url(object_key: str, expires_hours: int = 24) -> str:
    """
    Get a temporary signed URL to view/download a stored document.
    URL expires after expires_hours (default 24h).
    Returns None if MinIO is unavailable.
    """
    if not object_key:
        return None
    try:
        from datetime import timedelta
        client, bucket = _get_client()
        url = client.presigned_get_object(bucket, object_key, expires=timedelta(hours=expires_hours))
        return url
    except Exception:
        logger.warning("storage URL generation failed", exc_info=True)
        return None


def get_bytes(object_key: str):
    """
    Fetch the raw bytes of a stored object (used to stream audio back through the
    backend, since MinIO itself isn't exposed to the browser). Returns None on
    any failure.
    """
    if not object_key:
        return None
    try:
        client, bucket = _get_client()
        resp = client.get_object(bucket, object_key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()
    except Exception:
        logger.warning("storage get_bytes failed", exc_info=True)
        return None


def storage_available() -> bool:
    """Check if MinIO is reachable. Used for health checks."""
    try:
        _get_client()
        return True
    except Exception:
        return False
