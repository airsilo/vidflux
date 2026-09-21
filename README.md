# VidFlux

**Fast, easy, offline video conversion. Made by [AirSilo](https://airsilo.pages.dev).**

VidFlux is a 100% offline video converter for Windows. Convert MP4, MKV, WebM, MOV, AVI, WMV, MP3, FLAC, GIF, and more — no internet required, no telemetry, no uploads. Files never leave your device.

![VidFlux screenshot](docs/screenshot.png)

---

## Features

- **100% offline** — bundled FFmpeg, no network calls ever
- **Hardware acceleration** — AMD AMF, NVIDIA NVENC, Intel QSV auto-detected
- **Batch queue** — add multiple files, convert sequentially
- **Per-file presets** — mix formats in one queue
- **Bitrate slider** — 0–200% of source, floor 6 Mbps, cap 90 Mbps
- **Resolution presets** — 480p, 720p, 1080p, 1440p, 4K, plus platform targets (YouTube, Instagram, TikTok, Twitter/X)
- **Trim, remux, extract audio** — one-click presets
- **10-bit source support** — auto-converts to 8-bit for H.264, native 10-bit for H.265
- **Persistent queue** — survives app restart, resumable
- **No tracking, no analytics** — verifiably zero external requests

---

## Installation

### Windows 10 / 11

Download the latest **`VidFlux_x.x.x_x64-setup.exe`** from [Releases](https://github.com/airsilo/vidflux/releases) and run it.

- **First launch warning:** Windows SmartScreen may show "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**. This fades as more people install it.
- **No admin required** — installs per-user.
- **WebView2** — pre-installed on Windows 10/11. If missing, the installer offers to fetch it.

### System requirements

- Windows 10 (1809+) or Windows 11
- x64 CPU
- ~150 MB disk space (mostly FFmpeg)

---

## How to use

1. **Add files** — click **Add Videos** in the sidebar, or drag files onto the window.
2. **Pick a preset** — the sidebar's **Default Output** applies to new files; each queue row has its own dropdown to override.
3. **Fine-tune** (optional) — click the tune icon on any row to adjust bitrate and resolution.
4. **Convert** — click **Convert All** or the play button on a single row.

---

## Supported formats

**Input:** MP4, MKV, MOV, WebM, AVI, M4V, WMV, FLV, MPG, TS, M2TS, MP3, AAC, FLAC, WAV, OGG, Opus, M4A

**Output:** MP4 (H.264/H.265/AV1), MKV, MOV (H.264/ProRes), WebM (VP9/AV1), M4V, FLV, TS, WMV, AVI, 3GP, MP3, M4A, FLAC, WAV, OGG, GIF

---

## Hardware acceleration

VidFlux auto-detects working hardware encoders at launch:

| GPU | Encoder | 8-bit H.264 | 8-bit H.265 | 10-bit H.265 |
|---|---|---|---|---|
| NVIDIA GTX 1000+ | NVENC | ✅ | ✅ | ✅ |
| AMD RX 6000+ | AMF | ✅ | ✅ | ✅ |
| AMD RX 5000 or older | AMF | ✅ | ✅ | ❌ |
| Intel Ice Lake+ | QSV | ✅ | ✅ | ✅ |
| No GPU | libx264/x265 | ✅ | ✅ | ✅ (slower) |

You can force CPU encoding in the sidebar if hardware output doesn't meet your quality standards.

---

## Known limitations

- **Drag-and-drop from "Recent Files" in Explorer doesn't work** — known Tauri/WebView2 bug on Windows 11. Use the file picker instead, or drag from a normal folder.
- **No trimming yet** — planned for v2.0.
- **No subtitle burn-in yet** — planned for v2.0.
- **One job at a time** — concurrent conversions planned for v2.0.

---

## Development

Built with Tauri 2 + Rust + React + TypeScript.

```bash
# Install dependencies
npm install

# Run dev server
npm run tauri dev

# Build installers
npm run tauri build
```

**Project structure:**

```
src/                 React frontend
  App.tsx            Main UI
  index.css          All styles
  store/             Zustand state
  hooks/             Custom hooks
src-tauri/           Rust backend
  src/lib.rs         Tauri commands
  binaries/          Bundled FFmpeg/ffprobe
  tauri.conf.json    App config
```

---

## License

**GNU General Public License v3.0** — see [LICENSE](LICENSE).

VidFlux bundles FFmpeg with GPL components (x264, x265), which requires the entire distribution to be GPL-licensed.

---

## Credits

- [FFmpeg](https://ffmpeg.org) — the engine
- [Tauri](https://tauri.app) — the app framework
- [Roboto](https://fonts.google.com/specimen/Roboto) + [Material Symbols](https://fonts.google.com/icons) — typography and icons
- [Zustand](https://github.com/pmndrs/zustand) — state management

---

Made with ❤️ by [AirSilo](https://airsilo.pages.dev)