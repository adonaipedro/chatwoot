<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  pickRecorderMimeType,
  filenameFor,
  VIDEO_HARD_MAX_BYTES,
  VIDEO_STOP_MARGIN_BYTES,
} from './utils/videoRecorderUtils';

// Records webcam + microphone in a modal and emits the finished clip as a File
// in the SAME shape AudioRecorder uses ({ name, type, size, file }), so the
// parent (ReplyBox) can push it through onFileUpload — identical to a paperclip
// attachment. Strings are pt-BR (this is a pt-BR operation fork).
const props = defineProps({
  maxDurationSec: { type: Number, default: 60 },
});
const emit = defineEmits(['finishRecord', 'close']);

const MB = 1024 * 1024;
// Side of the square clip we record (a video note renders in a round bubble).
const RECORD_SIZE = 720;

const previewRef = ref(null);
const status = ref('starting'); // starting | idle | recording | recorded | error
const oversize = ref(false);
const message = ref('Iniciando a câmera…');
const messageType = ref(''); // '' | 'warn' | 'error'
const elapsed = ref(0);
const sizeBytes = ref(0);

let stream = null;
let recorder = null;
let chunks = [];
let chosen = null;
let recordedFile = null;
let playbackUrl = null;
let tickHandle = null;
let startedAt = 0;
// Square-recording pipeline: a canvas fed by an offscreen <video> of the camera,
// center-cropped to RECORD_SIZE². squareStream is what we actually record.
let squareStream = null;
let squareVideo = null;
let rafHandle = null;

const msgClass = computed(() => {
  if (messageType.value === 'error') return 'text-n-ruby-11';
  if (messageType.value === 'warn') return 'text-n-amber-11';
  return 'text-n-slate-11';
});

const fmtTime = totalSec => {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const sizeText = computed(() => `${(sizeBytes.value / MB).toFixed(1)} / 16 MB`);

const stopStream = () => {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
};

// Produce a guaranteed-square (RECORD_SIZE²) MediaStream by center-cropping the
// camera into a canvas, so the clip fits WhatsApp's round "Recado de Vídeo"
// bubble without losing the sides. Returns null — and the caller records the raw
// camera stream instead — whenever the browser can't drive a canvas stream, so
// recording itself can never break.
const buildSquareStream = src => {
  try {
    if (!src || !src.getVideoTracks?.().length) return null;
    const canvas = document.createElement('canvas');
    canvas.width = RECORD_SIZE;
    canvas.height = RECORD_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') return null;

    squareVideo = document.createElement('video');
    squareVideo.muted = true;
    squareVideo.playsInline = true;
    squareVideo.srcObject = src;
    squareVideo.play().catch(() => {});

    const draw = () => {
      const vw = squareVideo?.videoWidth || 0;
      const vh = squareVideo?.videoHeight || 0;
      if (vw && vh) {
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        ctx.drawImage(squareVideo, sx, sy, side, side, 0, 0, RECORD_SIZE, RECORD_SIZE);
      }
      rafHandle = requestAnimationFrame(draw);
    };
    rafHandle = requestAnimationFrame(draw);

    const out = canvas.captureStream(30);
    const audio = src.getAudioTracks?.()[0];
    if (audio) out.addTrack(audio); // reuse the live mic track (shared with `stream`)
    return out;
  } catch (e) {
    return null;
  }
};

const stopSquareStream = () => {
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (squareStream) {
    // Stop only the canvas video track; the audio track is owned by `stream`.
    squareStream.getVideoTracks().forEach(t => t.stop());
    squareStream = null;
  }
  if (squareVideo) {
    squareVideo.srcObject = null;
    squareVideo = null;
  }
};
const clearPlayback = () => {
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
  }
};

const attachLivePreview = () => {
  clearPlayback();
  const el = previewRef.value;
  if (el) {
    el.srcObject = stream;
    el.muted = true;
    el.controls = false;
    el.removeAttribute('src');
    if (el.play) el.play().catch(() => {});
  }
};

const setError = error => {
  status.value = 'error';
  messageType.value = 'error';
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    message.value =
      'Permissão de câmera/microfone negada. Permita o acesso e tente de novo.';
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    message.value = 'Nenhuma câmera/microfone encontrada neste computador.';
  } else if (name === 'NotReadableError') {
    message.value =
      'A câmera está em uso por outro programa. Feche-o e tente de novo.';
  } else {
    message.value = `Não foi possível acessar a câmera: ${error?.message || name || 'erro'}`;
  }
};

const startCamera = async () => {
  status.value = 'starting';
  messageType.value = '';
  message.value = 'Iniciando a câmera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // A "Recado de Vídeo" (PTV) renders in a round bubble, so we want a square
      // clip. Ask the camera for square (ideal, never `exact`, so it can't throw
      // OverconstrainedError); the canvas pipeline in startRecording guarantees
      // an exact 720×720 even when the camera ignores the hint.
      video: {
        width: { ideal: RECORD_SIZE },
        height: { ideal: RECORD_SIZE },
        aspectRatio: { ideal: 1 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    });
  } catch (error) {
    setError(error);
    return;
  }
  attachLivePreview();
  status.value = 'idle';
  message.value = `Pronto para gravar (limite ${props.maxDurationSec}s / 16 MB).`;
};

const stopRecording = () => {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (recorder && recorder.state !== 'inactive') recorder.stop();
};

const finalize = () => {
  stopSquareStream(); // recording captured — stop the canvas draw loop
  const mime =
    chosen?.mimeType || (chunks[0] && chunks[0].type) || 'video/webm';
  const blob = new Blob(chunks, { type: mime });
  const ts = String(Date.now());
  recordedFile = new File([blob], filenameFor(mime, ts), { type: mime });

  clearPlayback();
  playbackUrl = URL.createObjectURL(blob);
  const el = previewRef.value;
  if (el) {
    el.srcObject = null;
    el.src = playbackUrl;
    el.muted = false;
    el.controls = true;
  }

  status.value = 'recorded';
  const sizeMb = (recordedFile.size / MB).toFixed(1);
  if (recordedFile.size > VIDEO_HARD_MAX_BYTES) {
    oversize.value = true;
    messageType.value = 'error';
    message.value = `A gravação ficou com ${sizeMb} MB (acima de 16 MB). Refaça um clipe mais curto.`;
    return;
  }
  oversize.value = false;
  if (chosen?.isMp4 || /mp4/.test(mime)) {
    messageType.value = '';
    message.value = `Gravação pronta — ${sizeMb} MB (MP4/H.264). Revise e clique em "Usar gravação".`;
  } else {
    messageType.value = 'warn';
    message.value = `Gravação pronta — ${sizeMb} MB (WebM). Atenção: alguns celulares podem não tocar WebM no WhatsApp.`;
  }
};

const startRecording = () => {
  if (!stream) return;
  chunks = [];
  sizeBytes.value = 0;
  elapsed.value = 0;
  oversize.value = false;
  chosen = pickRecorderMimeType();
  const opts = { videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000 };
  if (chosen) opts.mimeType = chosen.mimeType;

  // Record the square canvas stream; fall back to the raw camera if unavailable.
  squareStream = buildSquareStream(stream);
  const recordStream = squareStream || stream;

  try {
    recorder = new MediaRecorder(recordStream, opts);
  } catch (e) {
    try {
      recorder = new MediaRecorder(recordStream);
      chosen = null;
    } catch (e2) {
      setError(e2);
      return;
    }
  }

  recorder.ondataavailable = ev => {
    if (ev.data && ev.data.size) {
      chunks.push(ev.data);
      sizeBytes.value += ev.data.size;
      if (sizeBytes.value >= VIDEO_STOP_MARGIN_BYTES) {
        messageType.value = 'warn';
        message.value = 'Limite de tamanho atingido — encerrando a gravação.';
        stopRecording();
      }
    }
  };
  recorder.onstop = finalize;

  recorder.start(1000);
  startedAt = Date.now();
  status.value = 'recording';
  messageType.value = '';
  message.value = 'Gravando…';

  tickHandle = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsed.value >= props.maxDurationSec) {
      messageType.value = 'warn';
      message.value = 'Duração máxima atingida — encerrando a gravação.';
      stopRecording();
    }
  }, 250);
};

const redo = () => {
  stopSquareStream();
  recordedFile = null;
  attachLivePreview();
  status.value = 'idle';
  messageType.value = '';
  message.value = `Pronto para gravar (limite ${props.maxDurationSec}s / 16 MB).`;
};

const useRecording = () => {
  if (!recordedFile) return;
  stopStream();
  emit('finishRecord', {
    name: recordedFile.name,
    type: recordedFile.type,
    size: recordedFile.size,
    file: recordedFile,
  });
};

const onClose = () => {
  stopRecording();
  stopSquareStream();
  stopStream();
  clearPlayback();
  emit('close');
};

onMounted(startCamera);
onBeforeUnmount(() => {
  stopRecording();
  stopSquareStream();
  stopStream();
  clearPlayback();
});
</script>

<template>
  <Teleport to="body">
    <div
      class="flex fixed inset-0 z-[9999] justify-center items-center bg-black/60"
      @click.self="onClose"
    >
      <div
        class="flex flex-col w-[min(560px,92vw)] h-[min(640px,90vh)] rounded-xl shadow-xl overflow-hidden bg-n-solid-2"
      >
        <div
          class="flex justify-between items-center px-4 py-3 border-b border-n-weak"
        >
          <h3 class="text-base font-medium text-n-slate-12">
            {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_TITLE') }}
          </h3>
          <button
            type="button"
            class="text-xl leading-none text-n-slate-11 hover:text-n-slate-12"
            @click="onClose"
          >
            ✕
          </button>
        </div>

        <div
          class="flex relative flex-1 justify-center items-center min-h-0 bg-black"
        >
          <video ref="previewRef" playsinline class="max-w-full max-h-full" />
          <div
            v-if="status === 'recording'"
            class="flex absolute top-3 left-3 gap-1.5 items-center px-2 py-1 text-xs font-medium text-white rounded-full bg-black/60"
          >
            <span class="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            {{ fmtTime(elapsed) }}
          </div>
          <div
            v-if="status === 'recording'"
            class="absolute top-3 right-3 px-2 py-1 text-xs text-white rounded-full bg-black/60"
          >
            {{ sizeText }}
          </div>
        </div>

        <div class="px-4 py-3 border-t border-n-weak">
          <p class="mb-2 text-sm min-h-[1.25rem]" :class="msgClass">
            {{ message }}
          </p>
          <div class="flex gap-2">
            <button
              v-if="status === 'idle'"
              type="button"
              class="flex-1 px-3 py-2 text-sm font-medium text-white bg-red-500 rounded-lg hover:bg-red-600"
              @click="startRecording"
            >
              {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_RECORD') }}
            </button>
            <button
              v-if="status === 'recording'"
              type="button"
              class="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-n-slate-3 text-n-slate-12 hover:bg-n-slate-4"
              @click="stopRecording"
            >
              {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_STOP') }}
            </button>
            <button
              v-if="status === 'recorded'"
              type="button"
              class="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-n-slate-3 text-n-slate-12 hover:bg-n-slate-4"
              @click="redo"
            >
              {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_REDO') }}
            </button>
            <button
              v-if="status === 'recorded' && !oversize"
              type="button"
              class="flex-1 px-3 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700"
              @click="useRecording"
            >
              {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_USE') }}
            </button>
            <button
              v-if="status === 'error'"
              type="button"
              class="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-n-slate-3 text-n-slate-12 hover:bg-n-slate-4"
              @click="startCamera"
            >
              {{ $t('CONVERSATION.REPLYBOX.VIDEORECORDER_RETRY') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
