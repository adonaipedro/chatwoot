// Pure helpers for the webcam video recorder (WebcamRecorder.vue).
//
// MediaRecorder defaults to WebM (VP8/VP9 + Opus), which WhatsApp frequently
// will not play. Prefer an MP4/H.264 + AAC container when the browser can encode
// it (modern Chrome with a hardware H.264 encoder), falling back to WebM. The
// support probe is injected so the candidate ordering is unit-testable without a
// real MediaRecorder.

// Backend (sales-ai whatsapp_web pipeline) silently drops videos over 16 MB, so
// the recorder guards against it: auto-stop near 15 MB, hard-block above 16 MB.
export const VIDEO_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const VIDEO_STOP_MARGIN_BYTES = 15 * 1024 * 1024;

// First supported wins. H.264 baseline + AAC is the most broadly playable on
// phones; main profile and bare mp4 next; WebM is the fallback.
export const RECORDER_MIME_CANDIDATES = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', isMp4: true },
  { mimeType: 'video/mp4;codecs=avc1.4D401E,mp4a.40.2', ext: 'mp4', isMp4: true },
  { mimeType: 'video/mp4', ext: 'mp4', isMp4: true },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm', isMp4: false },
  { mimeType: 'video/webm', ext: 'webm', isMp4: false },
];

const defaultIsSupported = mt =>
  typeof MediaRecorder !== 'undefined' &&
  typeof MediaRecorder.isTypeSupported === 'function' &&
  MediaRecorder.isTypeSupported(mt);

// Returns { mimeType, ext, isMp4 } for the best supported container, or null if
// none match (caller then lets MediaRecorder choose and reads the Blob's type).
export function pickRecorderMimeType(isSupported) {
  const probe = typeof isSupported === 'function' ? isSupported : defaultIsSupported;
  const match = RECORDER_MIME_CANDIDATES.find(c => probe(c.mimeType));
  return match ? { ...match } : null;
}

// Filename for the recorded clip. The `recado-de-video-` prefix is the signal
// the sales-ai backend uses to send this webcam recording to WhatsApp as a
// "Recado de Vídeo" (PTV / video note) instead of a regular video — see
// chatwoot_webhook._is_recado. Chatwoot itself classifies the attachment by MIME
// prefix (video/*), not extension; the extension just keeps the name honest.
// `tsString` is injected so this stays pure (no Date.now() here).
export function filenameFor(mime, tsString) {
  const ext = String(mime || '').includes('mp4') ? 'mp4' : 'webm';
  const ts = tsString ? String(tsString) : '';
  return ts ? `recado-de-video-${ts}.${ext}` : `recado-de-video.${ext}`;
}
