import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQueueStore, QueueJob, CropMode } from "./store/queueStore";
import { usePersistedState } from "./hooks/usePersistedState";
import { APP_VERSION } from "./version";
import "./index.css";

/* ==================== MODULE-LEVEL CANCEL TRACKER ==================== */
const CANCELLED_JOBS: Set<string> = new Set();

/* ==================== TYPES ==================== */
interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  pix_fmt?: string;
  [k: string]: unknown;
}
interface FfprobeResult {
  format: { duration: string; size: string; bit_rate?: string };
  streams: FfprobeStream[];
}
interface ProgressEvent {
  job_id: string;
  percent: number;
  speed: string;
  fps: string;
  bitrate: string;
  eta_seconds: number | null;
}
interface CompleteEvent {
  job_id: string;
  success: boolean;
  message: string;
  output_path: string;
}
interface HwEncoder {
  encoder: string;
  vendor: string;
  working: boolean;
}

/* ==================== CONSTANTS ==================== */
const MIN_BITRATE_FLOOR_BPS = 100_000;
const HIGH_QUALITY_FLOOR_BPS = 6_000_000;
const ABSOLUTE_CEILING_BPS = 90_000_000;

const MEDIA_EXTENSIONS = new Set([
  "mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv",
  "mpg", "mpeg", "ts", "m2ts", "mp3", "aac", "flac", "wav",
  "ogg", "opus", "m4a",
]);

interface ResolutionOption {
  id: string;
  label: string;
  width: number;
  height: number;
  recommendedBps: number;
  note?: string;
}
const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { id: "original", label: "Original", width: 0, height: 0, recommendedBps: 0 },
  { id: "480p",  label: "480p (854×480)",   width: 854,  height: 480,  recommendedBps: 1_500_000 },
  { id: "720p",  label: "720p (1280×720)",  width: 1280, height: 720,  recommendedBps: 2_500_000 },
  { id: "1080p", label: "1080p (1920×1080)",width: 1920, height: 1080, recommendedBps: 5_000_000 },
  { id: "1440p", label: "1440p (2560×1440)",width: 2560, height: 1440, recommendedBps: 6_000_000 },
  { id: "4k",    label: "4K (3840×2160)",   width: 3840, height: 2160, recommendedBps: 20_000_000 },
  { id: "yt-1080p", label: "YouTube 1080p",  width: 1920, height: 1080, recommendedBps: 6_000_000 },
  { id: "yt-4k",    label: "YouTube 4K",     width: 3840, height: 2160, recommendedBps: 40_000_000 },
  { id: "ig-feed",  label: "Instagram Feed (1:1)",   width: 1080, height: 1080, recommendedBps: 3_500_000 },
  { id: "ig-story", label: "Instagram Story/Reel (9:16)", width: 1080, height: 1920, recommendedBps: 3_500_000 },
  { id: "twitter",  label: "Twitter/X (720p)", width: 1280, height: 720,  recommendedBps: 5_000_000 },
  { id: "tiktok",   label: "TikTok (9:16)",    width: 1080, height: 1920, recommendedBps: 3_000_000 },
];

function getResolutionOption(id: string): ResolutionOption {
  return RESOLUTION_OPTIONS.find((r) => r.id === id) || RESOLUTION_OPTIONS[0];
}

const ASPECT_CHANGING_PRESETS = new Set(["ig-feed", "ig-story", "tiktok"]);

/* ==================== HELPERS ==================== */
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function formatBitrate(bps: number): string {
  if (!bps || bps <= 0) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
  return `${bps} bps`;
}
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.substring(0, idx) : p;
}
function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.substring(0, i) : name;
}
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function computeTargetBitrate(sourceBps: number, percent: number): number {
  const base = sourceBps > 0 ? sourceBps : HIGH_QUALITY_FLOOR_BPS;
  let target = Math.round(base * (percent / 50));
  if (percent < 50) {
    if (target < MIN_BITRATE_FLOOR_BPS) target = MIN_BITRATE_FLOOR_BPS;
  } else {
    if (target < HIGH_QUALITY_FLOOR_BPS) target = HIGH_QUALITY_FLOOR_BPS;
  }
  if (target > ABSOLUTE_CEILING_BPS) target = ABSOLUTE_CEILING_BPS;
  return target;
}

/* ==================== PRESETS ==================== */
interface Preset {
  id: string;
  name: string;
  shortName: string;
  ext: string;
  description: string;
  category: string;
  swArgs: string[];
  hwArgs: Record<string, string[]>;
  ignoreBitrateSlider?: boolean;
  ignoreResolution?: boolean;
  hasCustomScale?: boolean;
}

const PRESETS: Preset[] = [
  {
    id: "mp4-h264",
    name: "MP4 — H.264 + AAC (Universal)",
    shortName: "MP4 H.264",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "Best compatibility. Works everywhere.",
    swArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "mp4-h264-10bit",
    name: "MP4 — H.264 + AAC (10-bit source, CPU)",
    shortName: "MP4 H.264 (10-bit)",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "For 10-bit sources. Uses CPU encoding.",
    swArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {},
  },
  {
    id: "mp4-h264-fast",
    name: "MP4 — H.264 + AAC (Fast)",
    shortName: "MP4 Fast",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "Faster encode, slightly larger file.",
    swArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "fast", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "mp4-h264-copy",
    name: "MP4 — H.264 (keep original audio)",
    shortName: "MP4 Keep Audio",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "Fastest — no audio re-encode.",
    swArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "fast", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"],
      amf:   ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"],
    },
  },
  {
    id: "mp4-h265",
    name: "MP4 — H.265 + AAC (Smaller)",
    shortName: "MP4 H.265",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "Smaller files. Slower encode.",
    swArgs: ["-c:v", "libx265", "-preset", "fast", "-crf", "28", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "hevc_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "26", "-b:v", "0", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "26", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "hevc_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "24", "-qp_p", "26", "-tag:v", "hvc1", "-preanalysis", "0", "-smart_access_video", "1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "mp4-h265-10bit-gpu",
    name: "MP4 — H.265 10-bit (auto GPU)",
    shortName: "MP4 H.265 10-bit GPU",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "10-bit HEVC with hardware. Auto-picks your GPU.",
    swArgs: ["-c:v", "libx265", "-preset", "fast", "-crf", "28", "-pix_fmt", "yuv420p10le", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "hevc_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "26", "-b:v", "0", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "26", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "hevc_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "24", "-qp_p", "26", "-tag:v", "hvc1", "-preanalysis", "0", "-smart_access_video", "1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "mp4-av1",
    name: "MP4 — AV1 + Opus (next-gen)",
    shortName: "MP4 AV1",
    ext: "mp4",
    category: "MP4 & Universal",
    description: "AV1. Smallest files. Playback support growing.",
    swArgs: ["-c:v", "libsvtav1", "-preset", "6", "-crf", "35", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k", "-movflags", "+faststart"],
    hwArgs: {},
  },
  {
    id: "mov-h264",
    name: "MOV — H.264 + AAC (QuickTime)",
    shortName: "MOV H.264",
    ext: "mov",
    category: "Apple & Pro",
    description: "QuickTime container. Premiere/Final Cut friendly.",
    swArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "mov-prores",
    name: "MOV — Apple ProRes 422 HQ (editing)",
    shortName: "ProRes 422 HQ",
    ext: "mov",
    category: "Apple & Pro",
    description: "Professional editing format. Large files.",
    swArgs: ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le", "-ar", "48000"],
    hwArgs: {},
    ignoreBitrateSlider: true,
  },
  {
    id: "m4v",
    name: "M4V — iTunes / Apple TV",
    shortName: "M4V",
    ext: "m4v",
    category: "Apple & Pro",
    description: "iTunes-compatible MP4 variant.",
    swArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      amf:   ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    },
  },
  {
    id: "webm-vp9",
    name: "WebM — VP9 + Opus (10-bit, best quality)",
    shortName: "WebM VP9",
    ext: "webm",
    category: "Web & Streaming",
    description: "Best quality VP9. Slower.",
    swArgs: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-pix_fmt", "yuv420p10le", "-cpu-used", "2", "-row-mt", "1", "-threads", "0", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"],
    hwArgs: {},
  },
  {
    id: "webm-vp9-8bit",
    name: "WebM — VP9 + Opus (8-bit, faster)",
    shortName: "WebM VP9 8-bit",
    ext: "webm",
    category: "Web & Streaming",
    description: "8-bit WebM. Much faster than 10-bit.",
    swArgs: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-pix_fmt", "yuv420p", "-cpu-used", "4", "-row-mt", "1", "-threads", "0", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"],
    hwArgs: {},
  },
  {
    id: "webm-vp9-fast",
    name: "WebM — VP9 (fastest, lower quality)",
    shortName: "WebM VP9 Fast",
    ext: "webm",
    category: "Web & Streaming",
    description: "Fastest VP9. Quality tradeoff.",
    swArgs: ["-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-pix_fmt", "yuv420p", "-cpu-used", "5", "-row-mt", "1", "-threads", "0", "-deadline", "realtime", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"],
    hwArgs: {},
  },
  {
    id: "webm-av1",
    name: "WebM — AV1 + Opus (next-gen)",
    shortName: "WebM AV1",
    ext: "webm",
    category: "Web & Streaming",
    description: "AV1 in WebM. Royalty-free.",
    swArgs: ["-c:v", "libsvtav1", "-preset", "6", "-crf", "35", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"],
    hwArgs: {},
  },
  {
    id: "flv",
    name: "FLV — H.264 + AAC (Flash/legacy web)",
    shortName: "FLV",
    ext: "flv",
    category: "Web & Streaming",
    description: "Flash Video. Legacy streaming.",
    swArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-ar", "44100"],
    hwArgs: {},
  },
  {
    id: "ts",
    name: "TS — MPEG Transport Stream",
    shortName: "TS",
    ext: "ts",
    category: "Web & Streaming",
    description: "Broadcast / streaming container.",
    swArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-bsf:v", "h264_mp4toannexb"],
    hwArgs: {
      nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-bsf:v", "h264_mp4toannexb"],
      qsv:   ["-c:v", "h264_qsv", "-preset", "fast", "-global_quality", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-bsf:v", "h264_mp4toannexb"],
      amf:   ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-preanalysis", "0", "-smart_access_video", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-bsf:v", "h264_mp4toannexb"],
    },
  },
  {
    id: "wmv",
    name: "WMV — Windows Media Video",
    shortName: "WMV",
    ext: "wmv",
    category: "Legacy Formats",
    description: "Windows Media Video. Legacy compatibility.",
    swArgs: ["-c:v", "wmv2", "-c:a", "wmav2", "-b:a", "192k"],
    hwArgs: {},
  },
  {
    id: "avi",
    name: "AVI — MPEG-4 + MP3 (legacy)",
    shortName: "AVI",
    ext: "avi",
    category: "Legacy Formats",
    description: "Legacy AVI container. Wide hardware support.",
    swArgs: ["-c:v", "mpeg4", "-vtag", "XVID", "-c:a", "libmp3lame", "-b:a", "192k"],
    hwArgs: {},
  },
  {
    id: "3gp",
    name: "3GP — Mobile (H.263 + AAC)",
    shortName: "3GP",
    ext: "3gp",
    category: "Legacy Formats",
    description: "Very small. Old mobile phones.",
    swArgs: ["-c:v", "h263", "-b:v", "300k", "-s", "352x288", "-r", "15", "-c:a", "aac", "-b:a", "64k", "-ar", "8000", "-ac", "1"],
    hwArgs: {},
    hasCustomScale: true,
    ignoreResolution: true,
  },
  {
    id: "mkv-remux",
    name: "MKV — Remux (no re-encode)",
    shortName: "MKV Remux",
    ext: "mkv",
    category: "Remux",
    description: "Instant. Changes container only.",
    swArgs: ["-c", "copy"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "mp3-audio",
    name: "MP3 — Audio Only (320k)",
    shortName: "MP3 320k",
    ext: "mp3",
    category: "Audio Only",
    description: "High-quality MP3.",
    swArgs: ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "m4a-aac",
    name: "M4A — AAC Audio (iTunes)",
    shortName: "M4A AAC",
    ext: "m4a",
    category: "Audio Only",
    description: "AAC audio in MP4 container.",
    swArgs: ["-vn", "-c:a", "aac", "-b:a", "256k"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "flac-audio",
    name: "FLAC — Lossless Audio",
    shortName: "FLAC",
    ext: "flac",
    category: "Audio Only",
    description: "Lossless audio. Perfect for archiving.",
    swArgs: ["-vn", "-c:a", "flac", "-compression_level", "8"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "wav-audio",
    name: "WAV — Uncompressed Audio",
    shortName: "WAV",
    ext: "wav",
    category: "Audio Only",
    description: "Uncompressed PCM audio.",
    swArgs: ["-vn", "-c:a", "pcm_s16le", "-ar", "48000"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "ogg-vorbis",
    name: "OGG — Vorbis Audio",
    shortName: "OGG",
    ext: "ogg",
    category: "Audio Only",
    description: "Open audio format. Good for web.",
    swArgs: ["-vn", "-c:a", "libvorbis", "-q:a", "6"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    ignoreResolution: true,
  },
  {
    id: "gif",
    name: "GIF — Animated",
    shortName: "GIF",
    ext: "gif",
    category: "Image",
    description: "Animated GIF at reduced size.",
    swArgs: ["-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0"],
    hwArgs: {},
    ignoreBitrateSlider: true,
    hasCustomScale: true,
  },
];

function getPreset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

function groupPresets(): { category: string; presets: Preset[] }[] {
  const order = ["MP4 & Universal", "Apple & Pro", "Web & Streaming", "Legacy Formats", "Remux", "Audio Only", "Image"];
  const map = new Map<string, Preset[]>();
  for (const p of PRESETS) {
    if (!map.has(p.category)) map.set(p.category, []);
    map.get(p.category)!.push(p);
  }
  return order.filter((c) => map.has(c)).map((c) => ({ category: c, presets: map.get(c)! }));
}

/* ==================== ARG RESOLUTION ==================== */
interface ResolveInput {
  preset: Preset;
  accel: "auto" | "cpu" | "gpu";
  availableEncoders: HwEncoder[];
  bitratePercent: number;
  sourceBitrate: number;
  targetResolution: string;
  cropMode: CropMode;
  sourceWidth: number;
  sourceHeight: number;
}

function buildConvertArgs(input: ResolveInput): string[] {
  const {
    preset, accel, availableEncoders,
    bitratePercent, sourceBitrate,
    targetResolution, cropMode,
  } = input;

  let args: string[];
  if (accel === "cpu") {
    args = [...preset.swArgs];
  } else {
    const vendors = availableEncoders.map((e) => e.vendor);
    let picked: string[] | null = null;
    for (const v of ["nvenc", "qsv", "amf"]) {
      if (vendors.includes(v) && preset.hwArgs[v]) { picked = [...preset.hwArgs[v]]; break; }
    }
    args = picked ?? [...preset.swArgs];
  }

  const bitrateActive = !preset.ignoreBitrateSlider && bitratePercent !== 50;
  if (bitrateActive) {
    const targetBps = computeTargetBitrate(sourceBitrate, bitratePercent);
    const stripFlags = new Set(["-crf", "-global_quality", "-cq", "-qp_i", "-qp_p", "-qp_b", "-rc", "-b:v"]);
    const cleaned: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (stripFlags.has(a)) { i++; continue; }
      cleaned.push(a);
    }
    args = cleaned;
    const maxBps = Math.min(targetBps * 2, ABSOLUTE_CEILING_BPS);
    const bufBps = Math.max(targetBps * 2, 4_000_000);
    args.push("-b:v", String(targetBps), "-maxrate", String(maxBps), "-bufsize", String(bufBps));
  }

  const ignoreRes = preset.ignoreResolution || preset.hasCustomScale;
  if (!ignoreRes && targetResolution !== "original") {
    const res = getResolutionOption(targetResolution);
    const targetW = res.width;
    const targetH = res.height;
    const stripFilters = (arr: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === "-vf" || a === "-s") { i++; continue; }
        out.push(a);
      }
      return out;
    };
    args = stripFilters(args);
    let filter: string;
    if (ASPECT_CHANGING_PRESETS.has(targetResolution)) {
      filter = cropMode === "crop"
        ? `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1`
        : `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    } else {
      filter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
    }
    args.push("-vf", filter);
  }

  return args;
}

/* ==================== OUTPUT PATH ==================== */
function computeOutputPath(inputPath: string, outputDir: string, ext: string, takenPaths: string[]): string {
  const base = stripExt(basename(inputPath));
  const dir = outputDir || dirname(inputPath);
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  let candidate = `${dir}${sep}${base}.${ext}`;
  if (pathsEqual(candidate, inputPath)) candidate = `${dir}${sep}${base} (VidFlux).${ext}`;
  let n = 2;
  while (takenPaths.some((p) => pathsEqual(p, candidate))) {
    candidate = `${dir}${sep}${base} (${n}).${ext}`;
    n++;
  }
  return candidate;
}

/* ==================== CUSTOM TITLE BAR ==================== */
function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const setup = async () => {
      const win = getCurrentWindow();
      const check = async () => {
        try {
          const maximized = await win.isMaximized();
          if (mounted) setIsMaximized(maximized);
        } catch (e) {
          console.warn("isMaximized failed:", e);
        }
      };
      await check();
      unlisten = await win.onResized(() => { check(); });
    };

    setup();
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = async () => {
    await getCurrentWindow().minimize();
  };
  const handleToggleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
  };
  const handleClose = async () => {
    try { await getCurrentWindow().close(); }
    catch { await getCurrentWindow().destroy(); }
  };

  return (
    <div className="titlebar">
  <div className="titlebar-drag" data-tauri-drag-region>
    <svg
      viewBox="0 0 64 64"
      width="16"
      height="16"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="titlebar-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#C4B5FD" />
          <stop offset="0.5" stopColor="#6EE7B7" />
          <stop offset="1" stopColor="#FBCFE8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#titlebar-brand)" />
      <path d="M24 20 L44 32 L24 44 Z" fill="#0B0A0F" stroke="#0B0A0F" strokeWidth="2" strokeLinejoin="round" />
      <path d="M46 22 A 10 10 0 0 1 54 32" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M54 32 L58 28 M54 32 L50 28" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M18 42 A 10 10 0 0 1 10 32" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M10 32 L6 36 M10 32 L14 36" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
    <span className="titlebar-title">VidFlux</span>
  </div>
  <div className="titlebar-controls">
        <button
          className="titlebar-btn minimize"
          onClick={handleMinimize}
          aria-label="Minimize"
          title="Minimize"
        >
          <span className="ms">remove</span>
        </button>
        <button
          className="titlebar-btn maximize"
          onClick={handleToggleMaximize}
          aria-label={isMaximized ? "Restore" : "Maximize"}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          <span className="ms">
            {isMaximized ? "filter_none" : "crop_square"}
          </span>
        </button>
        <button
          className="titlebar-btn close"
          onClick={handleClose}
          aria-label="Close"
          title="Close"
        >
          <span className="ms">close</span>
        </button>
      </div>
    </div>
  );
}

/* ==================== TOP BAR ==================== */
interface TopBarProps {
  onOpenFiles: () => void;
  onQuit: () => void;
  onAbout: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
  onResetSettings: () => void;
}
function TopBar({
  onOpenFiles, onQuit, onAbout,
  onStartAll, onStopAll, onClearCompleted, onClearAll,
  onResetSettings,
}: TopBarProps) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setActiveMenu(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const toggle = (m: string) => setActiveMenu(activeMenu === m ? null : m);
  const hover = (m: string) => { if (activeMenu) setActiveMenu(m); };
  const close = () => setActiveMenu(null);

  return (
    <div className="top-bar">
      <div className="menu-bar" ref={menuRef}>
        <div className={`menu-item ${activeMenu === "file" ? "active" : ""}`}
          onClick={() => toggle("file")} onMouseEnter={() => hover("file")}>
          File
          {activeMenu === "file" && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="dropdown-item" onClick={() => { close(); onOpenFiles(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>folder_open</span> Add Files…
              </div>
              <div className="dropdown-divider" />
              <div className="dropdown-item" onClick={() => { close(); onResetSettings(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>restart_alt</span> Reset Settings…
              </div>
              <div className="dropdown-divider" />
              <div className="dropdown-item danger" onClick={() => { close(); onQuit(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>exit_to_app</span> Quit VidFlux
              </div>
            </div>
          )}
        </div>
        <div className={`menu-item ${activeMenu === "queue" ? "active" : ""}`}
          onClick={() => toggle("queue")} onMouseEnter={() => hover("queue")}>
          Queue
          {activeMenu === "queue" && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="dropdown-item" onClick={() => { close(); onStartAll(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>play_arrow</span> Convert All
              </div>
              <div className="dropdown-item" onClick={() => { close(); onStopAll(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>stop</span> Stop All
              </div>
              <div className="dropdown-divider" />
              <div className="dropdown-item" onClick={() => { close(); onClearCompleted(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>cleaning_services</span> Clear Completed
              </div>
              <div className="dropdown-item danger" onClick={() => { close(); onClearAll(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>delete</span> Clear All
              </div>
            </div>
          )}
        </div>
        <div className={`menu-item ${activeMenu === "help" ? "active" : ""}`}
          onClick={() => toggle("help")} onMouseEnter={() => hover("help")}>
          Help
          {activeMenu === "help" && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="dropdown-item" onClick={() => { close(); onAbout(); }}>
                <span className="ms" style={{ fontSize: "16px" }}>info</span> About VidFlux
              </div>
              <div className="dropdown-item"
                onClick={() => {
                  close();
                  openUrl("https://airsilo.pages.dev").catch((e) => {
                  console.error("Failed to open AirSilo website:", e);
                });
                }}>
                <span className="ms" style={{ fontSize: "16px" }}>language</span> AirSilo Website
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="top-bar-right">
        <div className="privacy-badge">
          <span className="ms" style={{ fontSize: "14px" }}>shield</span>
          100% offline · Files never leave your device
        </div>
        <button className="btn btn-outlined"
          style={{ padding: "6px", minHeight: "auto", borderRadius: "999px" }}
          aria-label="About VidFlux" onClick={onAbout} title="About VidFlux">
          <span className="ms" style={{ fontSize: "18px" }}>info</span>
        </button>
      </div>
    </div>
  );
}

/* ==================== BRAND LOGO ==================== */
function VidFluxLogo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="vidflux-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#C4B5FD" />
          <stop offset="0.5" stopColor="#6EE7B7" />
          <stop offset="1" stopColor="#FBCFE8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#vidflux-brand)" />
      <path d="M24 20 L44 32 L24 44 Z" fill="#0B0A0F" stroke="#0B0A0F" strokeWidth="2" strokeLinejoin="round" />
      <path d="M46 22 A 10 10 0 0 1 54 32" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M54 32 L58 28 M54 32 L50 28" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M18 42 A 10 10 0 0 1 10 32" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M10 32 L6 36 M10 32 L14 36" stroke="#0B0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/* ==================== MAIN APP ==================== */
function App() {
  const jobs = useQueueStore((s) => s.jobs);
  const runningJobId = useQueueStore((s) => s.runningJobId);
  const addJobs = useQueueStore((s) => s.addJobs);
  const updateJob = useQueueStore((s) => s.updateJob);
  const removeJob = useQueueStore((s) => s.removeJob);
  const clearCompleted = useQueueStore((s) => s.clearCompleted);
  const clearAll = useQueueStore((s) => s.clearAll);
  const setRunningJobId = useQueueStore((s) => s.setRunningJobId);
  const setStartRequested = useQueueStore((s) => s.setStartRequested);

  const [defaultPresetId, setDefaultPresetId] = usePersistedState<string>("defaultPresetId", PRESETS[0].id);
  const [outputDir, setOutputDir] = usePersistedState<string>("outputDir", "");
  const [error, setError] = useState<string>("");
  const [lastError, setLastError] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [expandedJobId, setExpandedJobId] = usePersistedState<string | null>("expandedJobId", null);

  const [hwEncoders, setHwEncoders] = useState<HwEncoder[]>([]);
  const [accelMode, setAccelMode] = usePersistedState<"auto" | "cpu" | "gpu">("accelMode", "auto");
  const [hwProbed, setHwProbed] = useState(false);

  useEffect(() => {
    let unProgress: UnlistenFn | null = null;
    let unComplete: UnlistenFn | null = null;
    (async () => {
      unProgress = await listen<ProgressEvent>("ffmpeg-progress", (e) => {
        updateJob(e.payload.job_id, {
          progress: e.payload.percent,
          speed: e.payload.speed,
          fps: e.payload.fps,
          bitrate: e.payload.bitrate,
          etaSeconds: e.payload.eta_seconds,
        });
      });
      unComplete = await listen<CompleteEvent>("ffmpeg-complete", (e) => {
        const current = useQueueStore.getState().jobs.find((j) => j.id === e.payload.job_id);
        const wasCancelled =
          current?.status === "cancelled" ||
          CANCELLED_JOBS.has(e.payload.job_id);

        if (wasCancelled) {
          CANCELLED_JOBS.delete(e.payload.job_id);
          setRunningJobId(null);
          return;
        }

        updateJob(e.payload.job_id, {
          status: e.payload.success ? "done" : "error",
          progress: e.payload.success ? 100 : 0,
          error: e.payload.success ? undefined : e.payload.message,
          finishedAt: Date.now(),
          startRequested: false,
        });
        setRunningJobId(null);
        if (!e.payload.success) {
          setLastError(e.payload.message);
        }
      });
    })();
    return () => {
      if (unProgress) unProgress();
      if (unComplete) unComplete();
    };
  }, [updateJob, setRunningJobId]);

  useEffect(() => {
    (async () => {
      try {
        const result = await invoke<HwEncoder[]>("detect_hardware_encoders");
        setHwEncoders(result);
        console.log("[VidFlux] Detected hardware encoders:", result);
      } catch (e) {
        console.warn("[VidFlux] Hardware detection failed:", e);
        setHwEncoders([]);
      } finally {
        setHwProbed(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (runningJobId) return;
    const next = jobs.find((j) => j.status === "queued" && j.startRequested);
    if (!next) return;
    (async () => {
      const preset = getPreset(next.presetId);
      const args = buildConvertArgs({
        preset,
        accel: accelMode,
        availableEncoders: hwEncoders,
        bitratePercent: next.bitratePercent,
        sourceBitrate: next.sourceBitrate,
        targetResolution: next.targetResolution,
        cropMode: next.cropMode,
        sourceWidth: next.videoWidth,
        sourceHeight: next.videoHeight,
      });
      console.log("[VidFlux] Converting with args:", args);
      setRunningJobId(next.id);
      updateJob(next.id, { status: "running", progress: 0, error: undefined, startRequested: false });
      let finalOutPath = next.outputPath;
      try {
        const resolved = await invoke<string>("resolve_output_path", { desired: next.outputPath });
        if (resolved !== next.outputPath) {
          finalOutPath = resolved;
          updateJob(next.id, { outputPath: resolved });
        }
      } catch (e) { console.warn("resolve_output_path failed:", e); }
      invoke("start_conversion", {
        jobId: next.id,
        inputPath: next.inputPath,
        outputPath: finalOutPath,
        args,
        durationSeconds: next.duration,
      }).catch((e) => {
        updateJob(next.id, { status: "error", error: String(e) });
        setRunningJobId(null);
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningJobId, jobs, accelMode, hwEncoders]);

  async function addFilesToQueue(paths: string[]) {
    if (paths.length === 0) return;
    setIsAdding(true);
    setError("");
    const taken: string[] = jobs.map((j) => j.outputPath);
    const newJobs: QueueJob[] = [];
    for (const path of paths) {
      try {
        const res = await invoke<FfprobeResult>("probe_file", { path });
        const duration = parseFloat(res.format.duration) || 0;
        const fileSize = parseInt(res.format.size, 10) || 0;
        const videoStream = res.streams.find((s) => s.codec_type === "video");
        const hasVideo = !!videoStream;
        const width = videoStream?.width || 0;
        const height = videoStream?.height || 0;
        const resolution = width && height ? `${width}×${height}` : "";
        const videoCodec = videoStream?.codec_name || "";
        const streamBr = parseInt(videoStream?.bit_rate || "0", 10) || 0;
        const formatBr = parseInt(res.format.bit_rate || "0", 10) || 0;
        const sourceBitrate = streamBr > 0 ? streamBr : formatBr;
        let presetId = defaultPresetId;
        if (!hasVideo) presetId = "mp3-audio";
        const preset = getPreset(presetId);
        const outPath = computeOutputPath(path, outputDir, preset.ext, taken);
        taken.push(outPath);
        newJobs.push({
          id: generateJobId(), inputPath: path, outputPath: outPath,
          inputBasename: basename(path), duration, fileSize, resolution,
          videoWidth: width, videoHeight: height, sourceBitrate, videoCodec, hasVideo,
          status: "queued", presetId, startRequested: false, progress: 0,
          speed: "", fps: "", bitrate: "", etaSeconds: null, addedAt: Date.now(),
          bitratePercent: 50, targetResolution: "original", cropMode: "crop",
        });
      } catch (e) {
        newJobs.push({
          id: generateJobId(), inputPath: path, outputPath: "",
          inputBasename: basename(path), duration: 0, fileSize: 0, resolution: "",
          videoWidth: 0, videoHeight: 0, sourceBitrate: 0, videoCodec: "", hasVideo: false,
          status: "error", presetId: defaultPresetId, startRequested: false,
          progress: 0, speed: "", fps: "", bitrate: "", etaSeconds: null,
          error: `Failed to probe: ${String(e)}`, addedAt: Date.now(), finishedAt: Date.now(),
          bitratePercent: 50, targetResolution: "original", cropMode: "crop",
        });
      }
    }
    addJobs(newJobs);
    if (!outputDir && paths.length > 0) setOutputDir(dirname(paths[0]));
    setIsAdding(false);
    newJobs.forEach(async (job) => {
      if (job.status === "error" || !job.hasVideo) return;
      try {
        const thumbPath = await invoke<string>("generate_thumbnail", { inputPath: job.inputPath, jobId: job.id });
        updateJob(job.id, { thumbnailPath: thumbPath });
      } catch (e) { console.warn("Thumbnail failed for", job.inputBasename, e); }
    });
  }

  async function handleSelectFiles() {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Media", extensions: Array.from(MEDIA_EXTENSIONS) },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await addFilesToQueue(paths);
    } catch (e) { setError(String(e)); }
  }

  async function handlePickOutputDir() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setOutputDir(selected);
        const taken: string[] = [];
        jobs.forEach((job) => {
          if (job.status === "queued") {
            const preset = getPreset(job.presetId);
            const newPath = computeOutputPath(job.inputPath, selected, preset.ext, taken);
            taken.push(newPath);
            updateJob(job.id, { outputPath: newPath });
          }
        });
      }
    } catch (e) { setError(String(e)); }
  }

  function handleStartAll() {
    const queuedIds = jobs.filter((j) => j.status === "queued").map((j) => j.id);
    if (queuedIds.length === 0) return;
    setStartRequested(queuedIds, true);
  }
  function handleStartOne(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "queued") return;
    setStartRequested([id], true);
  }

  async function handleStopAll() {
    if (runningJobId) {
      const jobIdToCancel = runningJobId;
      CANCELLED_JOBS.add(jobIdToCancel);
      updateJob(jobIdToCancel, {
        status: "cancelled",
        error: "Cancelled by user",
        finishedAt: Date.now(),
        startRequested: false,
      });
      setRunningJobId(null);
      try {
        await invoke("cancel_conversion", { jobId: jobIdToCancel });
      } catch (e) {
        setError(String(e));
      }
    }
    const queuedIds = jobs.filter((j) => j.status === "queued").map((j) => j.id);
    if (queuedIds.length > 0) setStartRequested(queuedIds, false);
  }

  async function handleRemoveJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.status === "running") {
      CANCELLED_JOBS.add(id);
      updateJob(id, {
        status: "cancelled",
        error: "Cancelled by user",
        finishedAt: Date.now(),
        startRequested: false,
      });
      setRunningJobId(null);
      try {
        await invoke("cancel_conversion", { jobId: id });
      } catch (e) {
        setError(String(e));
      }
    }
    removeJob(id);
  }

  async function handleChangeJobPreset(id: string, presetId: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "queued") return;
    const preset = getPreset(presetId);
    const taken = jobs.filter((j) => j.id !== id && j.status !== "cancelled").map((j) => j.outputPath);
    const newPath = computeOutputPath(job.inputPath, outputDir, preset.ext, taken);
    updateJob(id, { presetId, outputPath: newPath });
  }

  async function handleReveal(path: string) {
    if (!path) return;
    try { await revealItemInDir(path); } catch (e) { setError(`Could not reveal file: ${String(e)}`); }
  }
  async function handleQuit() {
    try { await getCurrentWindow().close(); }
    catch (e) {
      try { await getCurrentWindow().destroy(); }
      catch (e2) { console.error("Quit failed:", e, e2); }
    }
  }
  async function handleAbout() {
    try {
      await message(
        `VidFlux v${APP_VERSION}\n\nFast, easy, offline video conversion.\nMade by AirSilo.\n\n100% offline — files never leave your device.`,
        { title: "About VidFlux", kind: "info" }
      );
    } catch (e) { setError(`Dialog error: ${String(e)}`); }
  }
  async function handleResetSettings() {
    try {
      await message(
        "This will clear the queue and reset all settings to defaults.",
        { title: "Reset Settings", kind: "warning" }
      );
    } catch {
      return;
    }
    const keys = [
      "vidflux:queue",
      "vidflux:defaultPresetId",
      "vidflux:outputDir",
      "vidflux:accelMode",
      "vidflux:expandedJobId",
    ];
    keys.forEach((k) => localStorage.removeItem(k));
    location.reload();
  }

  const counts = {
    queued: jobs.filter((j) => j.status === "queued").length,
    running: jobs.filter((j) => j.status === "running").length,
    done: jobs.filter((j) => j.status === "done").length,
    error: jobs.filter((j) => j.status === "error").length,
  };
  const totalInputSize = jobs.reduce((sum, j) => sum + (j.fileSize || 0), 0);
  const preset = getPreset(defaultPresetId);

  const accelLabel = !hwProbed ? "Detecting GPUs…"
    : hwEncoders.length === 0 ? "No hardware encoder detected — using CPU."
    : `Detected: ${Array.from(new Set(hwEncoders.map((e) => e.vendor.toUpperCase()))).join(", ")}`;

  return (
  <div className="app-shell">
    <TitleBar />
    <TopBar
      onOpenFiles={handleSelectFiles} onQuit={handleQuit} onAbout={handleAbout}
      onStartAll={handleStartAll} onStopAll={handleStopAll}
      onClearCompleted={clearCompleted}
      onClearAll={clearAll}
      onResetSettings={handleResetSettings}
    />

    <div className="workspace">
        <aside className="sidebar">
          <div className="brand-block">
            <VidFluxLogo size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span className="brand-name">VidFlux</span>
                <span className="brand-version">v{APP_VERSION}</span>
              </div>
              <span className="brand-sub">by AirSilo</span>
            </div>
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title"><span className="ms">upload_file</span> Import</div>
            <button className="btn btn-filled" style={{ width: "100%", justifyContent: "center" }}
              onClick={handleSelectFiles} disabled={isAdding}>
              <span className="ms">{isAdding ? "hourglass_top" : "add"}</span>
              {isAdding ? "Analyzing…" : "Add Videos"}
            </button>
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title"><span className="ms">analytics</span> Queue Stats</div>
            <div className="sidebar-stat-row">
              <span className="label"><span className="ms" style={{ fontSize: "14px" }}>video_library</span>Videos</span>
              <span className="value">{jobs.length}</span>
            </div>
            <div className="sidebar-stat-row">
              <span className="label"><span className="ms" style={{ fontSize: "14px" }}>storage</span>Total size</span>
              <span className="value">{formatBytes(totalInputSize)}</span>
            </div>
            <div className="sidebar-stat-row">
              <span className="label"><span className="ms" style={{ fontSize: "14px" }}>schedule</span>Queued</span>
              <span className="value" style={{ color: "var(--on-surface-variant)" }}>{counts.queued}</span>
            </div>
            <div className="sidebar-stat-row">
              <span className="label"><span className="ms" style={{ fontSize: "14px" }}>autorenew</span>Running</span>
              <span className="value" style={{ color: "var(--primary)" }}>{counts.running}</span>
            </div>
            <div className="sidebar-stat-row">
              <span className="label"><span className="ms" style={{ fontSize: "14px" }}>check_circle</span>Done</span>
              <span className="value" style={{ color: "var(--secondary)" }}>{counts.done}</span>
            </div>
            {counts.error > 0 && (
              <div className="sidebar-stat-row">
                <span className="label"><span className="ms" style={{ fontSize: "14px" }}>error</span>Failed</span>
                <span className="value" style={{ color: "var(--error)" }}>{counts.error}</span>
              </div>
            )}
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title"><span className="ms">tune</span> Default Output</div>
            <div className="field" style={{ marginBottom: "12px" }}>
              <label className="field-label" htmlFor="preset">Format for new files</label>
              <select id="preset" className="field-select" value={defaultPresetId}
                onChange={(e) => setDefaultPresetId(e.target.value)}>
                {groupPresets().map((group) => (
                  <optgroup key={group.category} label={group.category}>
                    {group.presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div style={{ fontSize: "0.72rem", color: "var(--on-surface-variant)", marginTop: "4px" }}>
                {preset.description}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="outdir">Output folder</label>
              <div className="field-row">
                <input id="outdir" className="field-input" type="text" value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)} placeholder="Same as source" />
                <button className="icon-btn" onClick={handlePickOutputDir}
                  aria-label="Pick output folder" title="Choose folder">
                  <span className="ms" style={{ fontSize: "20px" }}>folder</span>
                </button>
              </div>
            </div>
            <div className="field" style={{ marginTop: "12px" }}>
              <label className="field-label" htmlFor="accel">Hardware Acceleration</label>
              <select id="accel" className="field-select" value={accelMode}
                onChange={(e) => setAccelMode(e.target.value as "auto" | "cpu" | "gpu")}>
                <option value="auto">Auto {hwEncoders.length > 0 ? `(${hwEncoders[0].vendor.toUpperCase()})` : ""}</option>
                <option value="gpu">GPU only</option>
                <option value="cpu">CPU only (best quality)</option>
              </select>
              <div style={{ fontSize: "0.72rem", color: "var(--on-surface-variant)", marginTop: "4px" }}>
                {accelLabel}
              </div>
            </div>
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title"><span className="ms">bolt</span> Actions</div>
            <div className="sidebar-actions">
              <button className="btn btn-filled" onClick={handleStartAll}
                disabled={counts.queued === 0 && !runningJobId}>
                <span className="ms">play_arrow</span>
                Convert All ({counts.queued + counts.running})
              </button>
              {(runningJobId || counts.queued > 0) && (
                <button className="btn btn-outlined" onClick={handleStopAll}>
                  <span className="ms">stop</span> Stop
                </button>
              )}
              {(counts.done > 0 || counts.error > 0) && (
                <button className="btn btn-outlined" onClick={clearCompleted}>
                  <span className="ms">cleaning_services</span> Clear Completed
                </button>
              )}
              {jobs.length > 0 && (
                <button className="btn btn-outlined" onClick={clearAll}
                  style={{ color: "var(--error)", borderColor: "rgba(252, 165, 165, 0.4)" }}>
                  <span className="ms">delete</span> Clear All
                </button>
              )}
            </div>
          </div>
        </aside>

        <section className="main-panel">
          {error && (
            <div className="error-msg" style={{ marginBottom: "16px" }}>
              <strong>Error:</strong> {error}
              <button className="btn btn-outlined"
                style={{ marginTop: "10px", padding: "6px 14px", minHeight: "auto" }}
                onClick={() => setError("")}>
                <span className="ms" style={{ fontSize: "16px" }}>close</span> Dismiss
              </button>
            </div>
          )}

          {lastError && (
            <div className="error-msg" style={{ marginBottom: "16px" }}>
              <strong>Conversion failed:</strong> {lastError}
              <button className="btn btn-outlined"
                style={{ marginTop: "10px", padding: "6px 14px", minHeight: "auto" }}
                onClick={() => setLastError("")}>
                <span className="ms" style={{ fontSize: "16px" }}>close</span> Dismiss
              </button>
            </div>
          )}

          {jobs.length === 0 ? (
            <div className="list-empty" onClick={handleSelectFiles}>
              <span className="ms">video_library</span>
              <h3>No videos in queue</h3>
              <p style={{ color: "var(--on-surface-variant)", marginTop: "4px" }}>
                Click here to add files, or use the sidebar
              </p>
            </div>
          ) : (
            <div className="video-list">
              {jobs.map((job) => {
                const isQueued = job.status === "queued";
                const isRunning = job.status === "running";
                const isDone = job.status === "done";
                const isError = job.status === "error";
                const jobPreset = getPreset(job.presetId);
                const willUseGpu =
                  accelMode !== "cpu" &&
                  hwEncoders.length > 0 &&
                  Object.keys(jobPreset.hwArgs).length > 0;
                const isExpanded = expandedJobId === job.id;
                const effectiveTargetBps =
                  job.bitratePercent === 50 && !jobPreset.ignoreBitrateSlider
                    ? Math.max(job.sourceBitrate || 0, HIGH_QUALITY_FLOOR_BPS)
                    : computeTargetBitrate(job.sourceBitrate, job.bitratePercent);
                const resOption = getResolutionOption(job.targetResolution);
                const showCropToggle = ASPECT_CHANGING_PRESETS.has(job.targetResolution);

                const showReveal = (isDone || (isError && job.outputPath)) && !isRunning;

                return (
                  <div key={job.id} className={`video-row ${job.status}`}>
                    <div className={`video-icon ${job.thumbnailPath ? "has-thumb" : ""}`}>
                      {job.thumbnailPath ? (
                        <img src={convertFileSrc(job.thumbnailPath)} alt="" className="video-thumb"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="video-thumb-placeholder">
                          <span className="ms">
                            {isDone ? "check_circle" :
                             isError ? "error" :
                             isRunning ? "autorenew" :
                             job.status === "cancelled" ? "block" :
                             job.hasVideo ? "movie" : "music_note"}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="video-info">
                      <div className="video-name" title={job.inputBasename}>{job.inputBasename}</div>
                      <div className="video-meta-line">
                        {isRunning ? (
                          <>
                            <span>{job.progress.toFixed(1)}%</span>
                            {job.speed && <span>· {job.speed}</span>}
                            {job.etaSeconds != null && <span>· ETA {formatDuration(job.etaSeconds)}</span>}
                          </>
                        ) : isError ? (
                          <span className="err" title={job.error || "Failed"}>
                            {job.error || "Failed"}
                          </span>
                        ) : job.status === "cancelled" ? (
                          <span>Cancelled</span>
                        ) : (
                          <>
                            {job.resolution && <span>{job.resolution}</span>}
                            {job.duration > 0 && <span>· {formatDuration(job.duration)}</span>}
                            {job.fileSize > 0 && <span>· {formatBytes(job.fileSize)}</span>}
                            {job.sourceBitrate > 0 && <span>· {formatBitrate(job.sourceBitrate)}</span>}
                            {job.videoCodec && (
                              <span style={{ textTransform: "uppercase" }}>· {job.videoCodec}</span>
                            )}
                            {isQueued && willUseGpu && (
                              <span style={{
                                fontSize: "0.6rem", fontWeight: 700, color: "var(--secondary)",
                                textTransform: "uppercase", letterSpacing: "0.05em",
                                border: "1px solid rgba(110, 231, 183, 0.4)",
                                borderRadius: "var(--r-full)", padding: "1px 6px",
                              }}>
                                GPU
                              </span>
                            )}
                            {isDone && (
                              <span style={{ color: "var(--secondary)" }}>
                                → {basename(job.outputPath)}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      {isRunning && (
                        <div className="video-progress-track">
                          <div className="video-progress-fill" style={{ width: `${job.progress}%` }} />
                        </div>
                      )}
                    </div>

                    <div className="video-controls">
                      <select className="video-preset-select"
                        value={job.presetId}
                        onChange={(e) => handleChangeJobPreset(job.id, e.target.value)}
                        disabled={!isQueued}
                        title={isQueued ? "Choose output format" : "Locked while running/done"}>
                        {groupPresets().map((group) => (
                          <optgroup key={group.category} label={group.category}>
                            {group.presets.map((p) => (
                              <option key={p.id} value={p.id}>{p.shortName}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>

                      {isQueued && job.hasVideo && (
                        <button
                          className={`row-tune-btn ${isExpanded ? "active" : ""}`}
                          title="Bitrate & resolution"
                          onClick={() => setExpandedJobId(isExpanded ? null : job.id)}
                        >
                          <span className="ms">tune</span>
                        </button>
                      )}

                      {isQueued && (
                        <button className="video-action-btn primary"
                          title="Convert this file" onClick={() => handleStartOne(job.id)}>
                          <span className="ms">play_arrow</span>
                        </button>
                      )}

                      {showReveal && (
                        <button className="video-action-btn"
                          title="Show in folder" onClick={() => handleReveal(job.outputPath)}>
                          <span className="ms">folder_open</span>
                        </button>
                      )}

                      <button className="video-action-btn danger"
                        title={isRunning ? "Cancel" : "Remove"}
                        onClick={() => handleRemoveJob(job.id)}>
                        <span className="ms">{isRunning ? "stop" : "close"}</span>
                      </button>
                    </div>

                    {isQueued && isExpanded && job.hasVideo && (
                      <div className="row-overrides-wrap">
                        <div className="row-overrides">
                          <div className="override-field">
                            <div className="override-label">
                              <span>Bitrate</span>
                              <span className="override-value">
                                {jobPreset.ignoreBitrateSlider
                                  ? "N/A for this preset"
                                  : `${formatBitrate(effectiveTargetBps)} (${job.bitratePercent}%)`}
                              </span>
                            </div>
                            <input type="range" className="bitrate-slider"
                              min={0} max={200} step={1}
                              value={job.bitratePercent}
                              disabled={jobPreset.ignoreBitrateSlider}
                              onChange={(e) => updateJob(job.id, { bitratePercent: parseInt(e.target.value, 10) })} />
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.65rem", color: "var(--on-surface-variant)" }}>
                              <span>0%</span>
                              <span>50% = source</span>
                              <span>200% (up to 90 Mbps)</span>
                            </div>
                          </div>

                          <div className="override-field">
                            <div className="override-label">
                              <span>Resolution</span>
                              {resOption.recommendedBps > 0 && (
                                <span className="override-value">
                                  rec. {formatBitrate(resOption.recommendedBps)}
                                </span>
                              )}
                            </div>
                            <select className="override-select"
                              value={job.targetResolution}
                              disabled={jobPreset.ignoreResolution}
                              onChange={(e) => updateJob(job.id, { targetResolution: e.target.value })}>
                              <optgroup label="Standard">
                                {RESOLUTION_OPTIONS.filter((r) => !r.id.includes("-") || r.id === "original").map((r) => (
                                  <option key={r.id} value={r.id}>{r.label}</option>
                                ))}
                              </optgroup>
                              <optgroup label="Platform">
                                {RESOLUTION_OPTIONS.filter((r) =>
                                  ["yt-1080p", "yt-4k", "ig-feed", "ig-story", "twitter", "tiktok"].includes(r.id)
                                ).map((r) => (
                                  <option key={r.id} value={r.id}>{r.label}</option>
                                ))}
                              </optgroup>
                            </select>
                            {showCropToggle && (
                              <div className="crop-toggle">
                                <button className={`crop-btn ${job.cropMode === "crop" ? "active" : ""}`}
                                  onClick={() => updateJob(job.id, { cropMode: "crop" })}
                                  title="Crop to fill — edges cut off">
                                  Crop
                                </button>
                                <button className={`crop-btn ${job.cropMode === "pad" ? "active" : ""}`}
                                  onClick={() => updateJob(job.id, { cropMode: "pad" })}
                                  title="Pad — full video visible, black bars">
                                  Pad
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default App;