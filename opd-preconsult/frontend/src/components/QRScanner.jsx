'use client';
import { useState, useRef, useEffect } from 'react';
import { useDialogA11y } from './ui/useDialogA11y';

export default function QRScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(true);
  const scanInterval = useRef(null);
  // Escape closes; the unmount cleanup below stops the camera, so onClose alone
  // is enough. Focus is trapped so a keyboard user cannot tab to the page under
  // a full-screen camera view.
  const panelRef = useDialogA11y(onClose);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          startScanning();
        };
      }
    } catch (err) {
      setError('Camera access denied. Please allow camera permission or enter the QR code manually.');
    }
  }

  function stopCamera() {
    if (scanInterval.current) clearInterval(scanInterval.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
  }

  function startScanning() {
    // Try native BarcodeDetector first (Chrome/Edge/Android)
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      scanInterval.current = setInterval(async () => {
        if (!videoRef.current || !scanning) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const value = barcodes[0].rawValue;
            handleDetected(value);
          }
        } catch {}
      }, 300);
    } else {
      // Fallback: capture frame and try to parse base64 from any text content
      // For browsers without BarcodeDetector, show manual input option
      setError('QR scanning not supported in this browser. Use the manual input below.');
    }
  }

  function handleDetected(rawValue) {
    setScanning(false);
    stopCamera();

    // QR may contain a URL like http://..?qr=BASE64 or just the base64 payload
    let payload = rawValue;
    try {
      const url = new URL(rawValue);
      const qrParam = url.searchParams.get('qr');
      if (qrParam) payload = qrParam;
    } catch {
      // Not a URL — assume it's the base64 payload directly
    }

    // Verify it's valid base64 JSON
    try {
      const decoded = JSON.parse(atob(payload));
      if (decoded.hospital_id && decoded.department) {
        onScan(payload);
        return;
      }
    } catch {}

    // Maybe the raw value IS the base64
    try {
      const decoded = JSON.parse(atob(rawValue));
      if (decoded.hospital_id) {
        onScan(rawValue);
        return;
      }
    } catch {}

    setError('Invalid QR code. Please scan an OPD registration QR.');
    setScanning(true);
    startCamera();
  }

  return (
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Scan QR code" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 1000,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: 400 }}>
        {/* Close button */}
        <button type="button" aria-label="Close scanner" onClick={() => { stopCamera(); onClose(); }}
          style={{ position: 'absolute', top: -40, right: 8, background: 'none', border: 'none', color: '#fff', fontSize: 28, cursor: 'pointer', zIndex: 2 }}>
          ✕
        </button>

        {/* Camera feed */}
        <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: '#000' }}>
          <video ref={videoRef} style={{ width: '100%', display: 'block' }} playsInline muted />
          {/* Scan guide overlay */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 220, height: 220, border: '3px solid var(--accent)', borderRadius: 16,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
            }} />
          </div>
        </div>

        <canvas ref={canvasRef} style={{ display: 'none' }} />

        <p style={{ color: '#fff', textAlign: 'center', marginTop: 16, fontSize: 14 }}>
          Point camera at the QR code
        </p>

        {error && (
          <p style={{ color: '#F39C12', textAlign: 'center', marginTop: 8, fontSize: 13, padding: '0 16px' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
