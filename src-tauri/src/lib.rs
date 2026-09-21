use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct ConversionState {
    processes: Mutex<HashMap<String, CommandChild>>,
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    job_id: String,
    out_time_ms: u64,
    speed: String,
    fps: String,
    bitrate: String,
    total_size: u64,
    percent: f64,
    eta_seconds: Option<f64>,
}

#[derive(Clone, serde::Serialize)]
struct CompletePayload {
    job_id: String,
    success: bool,
    message: String,
    output_path: String,
}

/* ============ probe_file ============ */
#[tauri::command]
async fn probe_file(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("File not found: {}", path));
    }
    let sidecar = app.shell().sidecar("ffprobe").map_err(|e| e.to_string())?;
    let output = sidecar
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format", "-show_streams",
            &path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe returned no output. {}", stderr.trim()));
    }
    let json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse ffprobe JSON: {}", e))?;
    Ok(json)
}

/* ============ check_ffmpeg ============ */
#[tauri::command]
async fn check_ffmpeg(app: tauri::AppHandle) -> Result<String, String> {
    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
    let output = sidecar.args(["-version"]).output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/* ============ resolve_output_path ============ */
#[tauri::command]
fn resolve_output_path(desired: String) -> String {
    let path = Path::new(&desired);
    if !path.exists() {
        return desired;
    }
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut n = 2;
    loop {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        n += 1;
        if n > 9999 {
            return desired;
        }
    }
}

/* ============ generate_thumbnail ============ */
#[tauri::command]
async fn generate_thumbnail(
    app: AppHandle,
    input_path: String,
    job_id: String,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let thumb_dir = app_data.join("thumbnails");
    std::fs::create_dir_all(&thumb_dir).map_err(|e| e.to_string())?;
    let thumb_path = thumb_dir.join(format!("{}.jpg", job_id));

    if thumb_path.is_file() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
    let output = sidecar
        .args([
            "-y",
            "-ss", "00:00:01",
            "-i", &input_path,
            "-vframes", "1",
            "-vf", "scale=320:-2",
            "-q:v", "5",
            thumb_path.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to spawn ffmpeg for thumbnail: {}", e))?;

    if !thumb_path.is_file() {
        let sidecar2 = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
        let _ = sidecar2
            .args([
                "-y",
                "-i", &input_path,
                "-vframes", "1",
                "-vf", "scale=320:-2",
                "-q:v", "5",
                thumb_path.to_str().unwrap(),
            ])
            .output()
            .await;

        if !thumb_path.is_file() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Thumbnail failed: {}", stderr.trim()));
        }
    }

    Ok(thumb_path.to_string_lossy().to_string())
}

/* ============ detect_hardware_encoders ============ */
#[tauri::command]
async fn detect_hardware_encoders(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;

    let list_output = sidecar
        .args(["-hide_banner", "-encoders"])
        .output()
        .await
        .map_err(|e| format!("Failed to list encoders: {}", e))?;

    let list_text = String::from_utf8_lossy(&list_output.stdout).to_string();

    let candidates: Vec<(&str, &str)> = vec![
        ("h264_nvenc", "nvenc"),
        ("hevc_nvenc", "nvenc"),
        ("h264_qsv", "qsv"),
        ("hevc_qsv", "qsv"),
        ("h264_amf", "amf"),
        ("hevc_amf", "amf"),
    ];

    let mut available: Vec<serde_json::Value> = Vec::new();

    for (encoder, vendor) in &candidates {
        if !list_text.contains(encoder) {
            continue;
        }

        let trial = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| e.to_string())?
            .args([
                "-hide_banner",
                "-loglevel", "error",
                "-f", "lavfi",
                "-i", "color=c=black:s=128x128:d=1",
                "-c:v", encoder,
                "-frames:v", "1",
                "-f", "null",
                "-",
            ])
            .output()
            .await;

        match trial {
            Ok(out) if out.status.success() => {
                available.push(json!({
                    "encoder": encoder,
                    "vendor": vendor,
                    "working": true,
                }));
            }
            _ => {}
        }
    }

    Ok(json!(available))
}

/* ============ friendly_ffmpeg_error ============ */
/// Translate FFmpeg's stderr into a user-friendly error message.
fn friendly_ffmpeg_error(stderr: &str, exit_code: Option<i32>) -> String {
    let s = stderr.to_lowercase();

    // Corrupted / invalid input
    if s.contains("invalid data found when processing input")
        || s.contains("moov atom not found")
        || s.contains("could not find codec parameters")
        || s.contains("invalid data found")
    {
        return "File is corrupted or not a valid media file.".into();
    }

    // File access
    if s.contains("no such file or directory")
        || s.contains("cannot open")
        || s.contains("error opening input")
        || s.contains("error opening output")
    {
        return "Source file not found or cannot be opened.".into();
    }

    if s.contains("permission denied") {
        return "Permission denied. Try a different output folder.".into();
    }

    if s.contains("no space left on device")
        || s.contains("disk full")
        || s.contains("enospc")
    {
        return "Not enough disk space for the output file.".into();
    }

    // Encoder problems
    if s.contains("unknown encoder")
        || s.contains("encoder not found")
        || s.contains("cannot load")
        || s.contains("failed to initialize")
        || s.contains("no capable devices found")
    {
        return "This encoder isn't supported on your system. Try a different preset.".into();
    }

    if s.contains("10-bit input video is not supported")
        || s.contains("not supported by amf")
        || s.contains("pixel format")
    {
        return "This encoder doesn't support this video format. Try a different preset.".into();
    }

    if s.contains("invalid argument")
        || s.contains("invalid option")
        || s.contains("invalid value")
    {
        return "Invalid encoding settings. Try a different preset.".into();
    }

    // Generic conversion failure
    if s.contains("conversion failed")
        || s.contains("nothing was written")
        || s.contains("could not open encoder")
    {
        return "Conversion failed. Try a different preset or input file.".into();
    }

    if s.contains("subprocess killed")
        || s.contains("terminated")
        || s.contains("signal")
    {
        return "Conversion was interrupted.".into();
    }

    // Fallback with exit code
    match exit_code {
        Some(code) => format!("Conversion failed (error code {}). Try a different preset.", code),
        None => "Conversion failed unexpectedly. Try a different preset.".into(),
    }
}

/* ============ start_conversion ============ */
#[tauri::command]
async fn start_conversion(
    app: AppHandle,
    state: State<'_, ConversionState>,
    job_id: String,
    input_path: String,
    output_path: String,
    args: Vec<String>,
    duration_seconds: f64,
) -> Result<(), String> {
    if !Path::new(&input_path).is_file() {
        return Err(format!("Input file not found: {}", input_path));
    }

    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;

    let mut full_args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input_path.clone(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    full_args.extend(args);
    full_args.push(output_path.clone());

    eprintln!("[VidFlux] Full ffmpeg args: {:?}", full_args);

    let (mut rx, child) = sidecar
        .args(&full_args)
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    state.processes.lock().unwrap().insert(job_id.clone(), child);

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let output_path_clone = output_path.clone();

    tauri::async_runtime::spawn(async move {
        let mut stderr_buffer = String::new();
        let mut progress_map: HashMap<String, String> = HashMap::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    for raw in text.lines() {
                        let line = raw.trim();
                        let Some((key, value)) = line.split_once('=') else { continue };
                        progress_map.insert(key.to_string(), value.to_string());

                        if key == "progress" {
                            let out_time_us = progress_map
                                .get("out_time_us")
                                .or_else(|| progress_map.get("out_time_ms"))
                                .and_then(|v| v.parse::<i64>().ok())
                                .unwrap_or(0);
                            let out_time_s = out_time_us as f64 / 1_000_000.0;

                            let percent = if duration_seconds > 0.0 {
                                (out_time_s / duration_seconds * 100.0).clamp(0.0, 100.0)
                            } else {
                                0.0
                            };

                            let speed_str = progress_map
                                .get("speed")
                                .cloned()
                                .unwrap_or_else(|| "N/A".into());
                            let speed_num = speed_str.trim_end_matches('x').parse::<f64>().ok();
                            let eta_seconds = match (speed_num, duration_seconds) {
                                (Some(s), d) if s > 0.0 && d > 0.0 => {
                                    Some(((d - out_time_s) / s).max(0.0))
                                }
                                _ => None,
                            };

                            let _ = app_clone.emit(
                                "ffmpeg-progress",
                                ProgressPayload {
                                    job_id: job_id_clone.clone(),
                                    out_time_ms: out_time_us as u64,
                                    speed: speed_str,
                                    fps: progress_map.get("fps").cloned().unwrap_or_else(|| "0".into()),
                                    bitrate: progress_map.get("bitrate").cloned().unwrap_or_else(|| "N/A".into()),
                                    total_size: progress_map.get("total_size").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
                                    percent,
                                    eta_seconds,
                                },
                            );
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    stderr_buffer.push_str(&text);
                    stderr_buffer.push('\n');
                    if stderr_buffer.len() > 20_000 {
                        let cut = stderr_buffer.len() - 10_000;
                        stderr_buffer = stderr_buffer.split_off(cut);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let success = payload.code == Some(0);
                    let message = if success {
                        "Conversion complete".to_string()
                    } else {
                        friendly_ffmpeg_error(&stderr_buffer, payload.code)
                    };

                    // Log raw stderr to the dev terminal for debugging
                    if !success {
                        eprintln!("[VidFlux] FFmpeg failed (exit {:?}):", payload.code);
                        let tail: Vec<&str> = stderr_buffer.lines().rev().take(12).collect();
                        for line in tail.into_iter().rev() {
                            eprintln!("  {}", line);
                        }
                    }

                    let _ = app_clone.emit(
                        "ffmpeg-complete",
                        CompletePayload {
                            job_id: job_id_clone.clone(),
                            success,
                            message,
                            output_path: output_path_clone.clone(),
                        },
                    );
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app_clone.emit(
                        "ffmpeg-complete",
                        CompletePayload {
                            job_id: job_id_clone.clone(),
                            success: false,
                            message: format!("Process error: {}", err),
                            output_path: output_path_clone.clone(),
                        },
                    );
                    break;
                }
                _ => {}
            }
        }

        let state: State<ConversionState> = app_clone.state();
        state.processes.lock().unwrap().remove(&job_id_clone);
    });

    Ok(())
}

/* ============ cancel_conversion ============ */
#[tauri::command]
fn cancel_conversion(state: State<'_, ConversionState>, job_id: String) -> Result<(), String> {
    let mut procs = state.processes.lock().unwrap();
    if let Some(child) = procs.remove(&job_id) {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ConversionState::default())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            probe_file,
            resolve_output_path,
            generate_thumbnail,
            detect_hardware_encoders,
            start_conversion,
            cancel_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}