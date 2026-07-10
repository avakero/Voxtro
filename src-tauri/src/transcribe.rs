//! Whisper.cpp バイナリを subprocess として呼び出して音声文字起こしを行う。
//!
//! whisper-rs の FFI バインディングは MSVC/LLVM の ABI 差異による
//! struct サイズ不一致問題があるため、公式バイナリ (`whisper-cli`) を使用する。
//!
//! バイナリとモデルは app_data_dir/ に格納される。
//! - Windows: %APPDATA%\voxtro\
//! - macOS:   ~/Library/Application Support/voxtro/

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

/// 実行中ダウンロードのキャンセルフラグ（同時に走るダウンロードは1つの想定）
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn cancel_active_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── モデル情報 ───────────────────────────────────────────────────────────

struct ModelInfo {
    filename: &'static str,
    url: &'static str,
    size_mb: u32,
}

fn get_model_info(model: &str) -> ModelInfo {
    match model {
        "large" => ModelInfo {
            filename: "ggml-large-v3.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
            size_mb: 2900,
        },
        "medium" => ModelInfo {
            filename: "ggml-medium.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
            size_mb: 1500,
        },
        _ => ModelInfo {
            filename: "ggml-small.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
            size_mb: 466,
        },
    }
}

// ─── whisper.cpp バイナリ情報 ─────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn whisper_bin_name() -> &'static str {
    "whisper-cli.exe"
}

#[cfg(not(target_os = "windows"))]
fn whisper_bin_name() -> &'static str {
    "whisper-cli"
}

/// whisper-cli バイナリのダウンロード URL (GitHub Releases)。
/// https://github.com/ggml-org/whisper.cpp/releases
#[cfg(target_os = "windows")]
fn whisper_bin_url() -> &'static str {
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip"
}

#[cfg(target_os = "macos")]
fn whisper_bin_url() -> &'static str {
    // macOS: ソースからビルドが必要（公式バイナリなし）
    // Homebrew: brew install whisper-cpp
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip"
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn whisper_bin_url() -> &'static str {
    // Linux 向け公式バイナリは無い。CI 等でのコンパイルを通すためのフォールバック
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip"
}

// ─── パス解決 ─────────────────────────────────────────────────────────────

fn voxtro_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn model_path(app: &tauri::AppHandle, model: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let info = get_model_info(model);
    Ok(voxtro_data_dir(app)?.join("models").join(info.filename))
}

fn bin_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(voxtro_data_dir(app)?.join("bin").join(whisper_bin_name()))
}

/// セットアップ状況を返す: (whisper-cli バイナリの有無, 選択中モデルの有無)
pub fn check_setup(app: &tauri::AppHandle) -> (bool, bool) {
    let has_bin = bin_path(app).map(|p| p.exists()).unwrap_or(false);
    let model_name = read_model_name(app);
    let has_model = model_path(app, &model_name)
        .map(|p| p.exists())
        .unwrap_or(false);
    (has_bin, has_model)
}

// ─── ダウンロード ─────────────────────────────────────────────────────────

/// Whisper ggml モデルをダウンロードする。
/// 進捗は "model-download-progress" イベントで通知 (0.0〜100.0)。
pub async fn download_model(
    app: &tauri::AppHandle,
    model: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let info = get_model_info(model);
    let dest = {
        let dir = voxtro_data_dir(app)?.join("models");
        std::fs::create_dir_all(&dir)?;
        dir.join(info.filename)
    };

    if dest.exists() {
        let _ = app.emit("model-download-progress", 100.0f64);
        return Ok(());
    }

    download_file_with_progress(app, info.url, &dest, "model-download-progress").await
}

/// whisper-cli バイナリをダウンロード・展開する。
pub async fn download_whisper_bin(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dest = bin_path(app)?;
    let bin_dir = dest.parent().ok_or("展開先ディレクトリが不明")?;
    // exe と必須 DLL が揃っているかチェック
    let has_all = dest.exists() && bin_dir.join("whisper.dll").exists();
    if has_all {
        return Ok(());
    }

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let zip_path = voxtro_data_dir(app)?.join("bin").join("whisper-bin.zip");
    download_file_with_progress(app, whisper_bin_url(), &zip_path, "bin-download-progress").await?;

    // ZIP を展開して whisper-cli を取り出す
    extract_whisper_bin(&zip_path, &dest)?;

    // ダウンロードした ZIP は削除
    let _ = std::fs::remove_file(&zip_path);

    Ok(())
}

/// 汎用ファイルダウンロード (進捗イベント付き)。
async fn download_file_with_progress(
    app: &tauri::AppHandle,
    url: &str,
    dest: &PathBuf,
    event: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    let response = reqwest::get(url).await?;
    if !response.status().is_success() {
        return Err(format!(
            "ダウンロード失敗: HTTP {} — URL: {}",
            response.status(), url
        ).into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();

    let mut file = tokio::fs::File::create(dest).await?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            let _ = app.emit(&format!("{event}-cancelled"), ());
            return Err("ダウンロードをキャンセルしました".into());
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;

        if total > 0 {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            let _ = app.emit(event, pct);
        }
    }

    file.flush().await?;

    // ダウンロードサイズが異常に小さい場合はエラー（404等のHTMLが保存された可能性）
    if downloaded < 1000 {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(format!(
            "ダウンロードファイルが小さすぎます ({downloaded} bytes)。URLが無効か、ネットワークエラーの可能性があります。"
        ).into());
    }

    let _ = app.emit(event, 100.0f64);
    Ok(())
}

/// ZIP ファイルから whisper-cli バイナリと必要な DLL を展開する。
fn extract_whisper_bin(zip_path: &PathBuf, dest: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    let bin_name = whisper_bin_name();
    let bin_dir = dest.parent().ok_or("展開先ディレクトリが不明")?;
    let mut found_bin = false;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let entry_name = entry.name().to_string();

        // ファイル名部分を取得（Release/whisper-cli.exe → whisper-cli.exe）
        let file_name = entry_name.rsplit('/').next().unwrap_or(&entry_name);

        // whisper-cli 本体、または .dll ファイルを展開
        let should_extract = file_name.ends_with(bin_name)
            || file_name == bin_name
            || file_name.ends_with(".dll");

        if should_extract && !entry.is_dir() {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            let out_path = bin_dir.join(file_name);
            std::fs::write(&out_path, buf)?;

            if file_name.ends_with(bin_name) || file_name == bin_name {
                found_bin = true;
            }

            // macOS/Linux では実行権限を付与
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }

    if !found_bin {
        return Err(format!("ZIPの中に {} が見つかりません", bin_name).into());
    }
    Ok(())
}

// ─── 文字起こし ───────────────────────────────────────────────────────────

/// WAV ファイルを whisper-cli で文字起こしする。
/// モデルは config.json の "model" キーから決定する（デフォルト: small）。
pub async fn run_whisper(
    wav_path: &PathBuf,
    app: &tauri::AppHandle,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let model_name = read_model_name(app);
    let model = model_path(app, &model_name)
        .map_err(|e| format!("モデルパス取得失敗: {e}"))?;
    let bin = bin_path(app)
        .map_err(|e| format!("バイナリパス取得失敗: {e}"))?;

    if !model.exists() {
        return Err(format!(
            "Whisperモデルが見つかりません: {}\n設定画面からダウンロードしてください。",
            model.display()
        ).into());
    }

    if !bin.exists() {
        return Err(format!(
            "whisper-cli が見つかりません: {}\n設定画面から「バイナリをダウンロード」してください。",
            bin.display()
        ).into());
    }

    let wav = wav_path.clone();
    let output_txt = wav.with_extension("txt");

    // whisper-cli は CPU バウンドなので blocking スレッドで実行
    tokio::task::spawn_blocking(move || -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        // whisper-cli -m model.bin -l ja --output-txt -f audio.wav
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-m").arg(&model)
           .arg("-l").arg("ja")
           .arg("-f").arg(&wav)
           .arg("--output-txt")
           .arg("--no-timestamps")
           // 出力ファイルを同じディレクトリに作成
           .arg("-of").arg(wav.with_extension(""));

        // Windows の場合、黒いコマンドプロンプト画面が開かないように CREATE_NO_WINDOW フラグ (0x08000000) を設定
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd.output().map_err(|e| format!("whisper-cli 起動失敗: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "whisper-cli が終了コード {:?} で失敗\nstderr: {}\nstdout: {}",
                output.status.code(), stderr, stdout
            ).into());
        }

        // .txt ファイルを読む (whisper-cli は {output_prefix}.txt を生成する)
        let text = std::fs::read_to_string(&output_txt)
            .map_err(|e| format!("出力テキスト読み込み失敗: {e}"))?;

        // 一時ファイルを削除
        let _ = std::fs::remove_file(&output_txt);
        let _ = std::fs::remove_file(&wav);

        Ok(text.trim().to_string())
    })
    .await?
}

// ─── ストア読み取り ───────────────────────────────────────────────────────

fn read_model_name(app: &tauri::AppHandle) -> String {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("model"))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "small".to_string())
}
