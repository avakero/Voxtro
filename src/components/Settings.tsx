import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import {
  getApiKey,
  saveApiKey,
  getShortcut,
  saveShortcut,
  getModel,
  saveModel,
  getAccentColor,
  saveAccentColor,
  testGeminiKey,
} from "../lib/gemini";
import { useTheme } from "../lib/ThemeContext";
import { THEMES, ThemeId } from "../lib/themes";

interface Props {
  onBack: () => void;
  isFirstRun?: boolean;
}

type WhisperModel = "small" | "medium" | "large";

export default function Settings({ onBack, isFirstRun }: Props) {
  const { theme, setTheme } = useTheme();
  const [apiKey, setApiKey] = useState("");
  const [shortcut, setShortcut] = useState("Ctrl+Shift+K");
  const [model, setModel] = useState<WhisperModel>("small");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [binDownloading, setBinDownloading] = useState(false);
  const [binProgress, setBinProgress] = useState<number | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [isMsgError, setIsMsgError] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [accentColor, setAccentColor] = useState("ocean");
  const [apiKeyExpanded, setApiKeyExpanded] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [setupStatus, setSetupStatus] = useState<{ hasBin: boolean; hasModel: boolean } | null>(null);
  const flashTimerRef = useRef<number | undefined>(undefined);

  const isCyberpunk = theme === "cyberpunk";
  const isPop = theme === "pop";
  const isRetro = theme === "retro";
  const hasScanline = isCyberpunk || isRetro;
  const labels = THEMES[theme].labels;

  const colorPresets: Record<string, { label: string; colors: [string, string] }> = {
    ocean: { label: "オーシャン", colors: ["#00f0ff", "#a855f7"] },
    sunset: { label: "サンセット", colors: ["#ff6b35", "#ff00aa"] },
    forest: { label: "フォレスト", colors: ["#00ff88", "#00f0ff"] },
    lavender: { label: "ラベンダー", colors: ["#a855f7", "#ff00aa"] },
    neon: { label: "ネオン", colors: ["#00f0ff", "#ff00aa"] },
  };

  const refreshSetup = async (): Promise<{ hasBin: boolean; hasModel: boolean } | null> => {
    try {
      const [hasBin, hasModel] = await invoke<[boolean, boolean]>("check_setup");
      const next = { hasBin, hasModel };
      setSetupStatus(next);
      return next;
    } catch (e) {
      console.error("Setup check failed:", e);
      return null;
    }
  };

  useEffect(() => {
    getApiKey().then((k) => { if (k) setApiKey(k); });
    getShortcut().then((k) => setShortcut(k));
    getModel().then((m) => setModel(m));
    getAccentColor().then((c) => setAccentColor(c));
    refreshSetup();

    const unlisteners = Promise.all([
      listen<number>("model-download-progress", ({ payload }) => {
        setDownloadProgress(payload);
        if (payload >= 100) { setDownloading(false); refreshSetup(); }
      }),
      listen<number>("bin-download-progress", ({ payload }) => {
        setBinProgress(payload);
        if (payload >= 100) { setBinDownloading(false); refreshSetup(); }
      }),
      listen("model-download-progress-cancelled", () => {
        setDownloading(false);
        setDownloadProgress(null);
      }),
      listen("bin-download-progress-cancelled", () => {
        setBinDownloading(false);
        setBinProgress(null);
      }),
    ]);
    return () => {
      unlisteners.then((fns) => fns.forEach((fn) => fn()));
      window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  // ─── ショートカットキャプチャ ─────────────────────────────────────────

  const handleKeyCapture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    // グローバルショートカットの誤爆防止のため Ctrl / Alt / Cmd を必須にする
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      flash("Ctrl / Alt / Cmd キーとの組み合わせを指定してください", true);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");

    const keyMap: Record<string, string> = {
      " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down",
      "ArrowLeft": "Left", "ArrowRight": "Right",
      "Enter": "Enter", "Backspace": "Backspace",
      "Delete": "Delete", "Tab": "Tab",
    };

    let keyName = keyMap[e.key] || e.key;
    if (keyName.length === 1 && /[a-zA-Z]/.test(keyName)) {
      keyName = keyName.toUpperCase();
    }

    parts.push(keyName);
    const newShortcut = parts.join("+");
    setShortcut(newShortcut);
    setCapturing(false);
    applyShortcut(newShortcut);
  };

  const applyShortcut = async (value: string) => {
    try {
      await saveShortcut(value);
      await invoke("update_shortcut", { shortcut: value });
      flash(`ショートカットを ${value} に更新しました`);
    } catch (e) {
      flash(`ショートカット更新エラー: ${e}`, true);
    }
  };

  // ─── ダウンロード ─────────────────────────────────────────────────────

  const downloadBin = async (): Promise<boolean> => {
    setBinDownloading(true);
    setBinProgress(0);
    try {
      await invoke("download_whisper_bin");
      // 既にダウンロード済みの場合は進捗イベントが来ないため、ここで完了を確定させる
      setBinDownloading(false);
      setBinProgress(100);
      refreshSetup();
      return true;
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("キャンセル")) {
        flash(`音声エンジンのダウンロードエラー: ${e}`, true);
      }
      setBinDownloading(false);
      setBinProgress(null);
      return false;
    }
  };

  const downloadModel = async (): Promise<boolean> => {
    setDownloading(true);
    setDownloadProgress(0);
    try {
      await saveModel(model);
      await invoke("download_model", { model });
      setDownloading(false);
      setDownloadProgress(100);
      refreshSetup();
      return true;
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("キャンセル")) {
        flash(`モデルのダウンロードエラー: ${e}`, true);
      }
      setDownloading(false);
      setDownloadProgress(null);
      return false;
    }
  };

  /** 未取得のものをバイナリ → モデルの順に一括ダウンロードする */
  const handleSetupAll = async () => {
    const current = (await refreshSetup()) ?? { hasBin: false, hasModel: false };
    if (!current.hasBin) {
      const ok = await downloadBin();
      if (!ok) return;
    }
    if (!current.hasModel) {
      const ok = await downloadModel();
      if (!ok) return;
    }
    await refreshSetup();
    flash("セットアップが完了しました！");
  };

  const handleCancelDownload = async () => {
    try {
      await invoke("cancel_download");
    } catch (e) {
      console.error("キャンセル失敗:", e);
    }
  };

  // ─── APIキー ─────────────────────────────────────────────────────────

  const handleApiKeySave = async () => {
    await saveApiKey(apiKey);
    flash("APIキーを保存しました");
  };

  const handleApiKeyTest = async () => {
    setTestingKey(true);
    try {
      await testGeminiKey(apiKey);
      flash("接続テスト成功！AI整形が利用できます");
    } catch (e) {
      flash(`接続テスト失敗: ${e}`, true);
    } finally {
      setTestingKey(false);
    }
  };

  const flash = (msg: string, isError = false) => {
    setSaveMsg(msg);
    setIsMsgError(isError);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setSaveMsg("");
      setIsMsgError(false);
    }, isError ? 10000 : 3000);
  };

  // ─── スタイル ─────────────────────────────────────────────────────────

  const sectionStyle: React.CSSProperties = {
    background: "var(--t-bg-card)",
    border: "1px solid var(--t-border)",
    borderRadius: "var(--t-radius-lg)",
    padding: 16,
    marginBottom: 16,
    backdropFilter: "var(--t-section-backdrop)",
    position: "relative",
    overflow: "hidden",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--t-label-size)",
    fontFamily: "var(--t-font-display)",
    fontWeight: 600,
    color: "var(--t-primary)",
    textTransform: (isCyberpunk || isRetro) ? "uppercase" as const : "none" as const,
    letterSpacing: "var(--t-label-spacing)",
    marginBottom: 8,
    display: "block",
  };

  const thStyle: React.CSSProperties = {
    padding: "6px 8px",
    fontWeight: 700,
    color: "var(--t-primary)",
    fontFamily: "var(--t-font-display)",
    fontSize: "var(--t-label-size)",
    letterSpacing: "var(--t-label-spacing)",
  };

  const setupComplete = setupStatus?.hasBin && setupStatus?.hasModel;
  const anyDownloading = downloading || binDownloading;

  const renderProgress = (progress: number | null, active: boolean) => {
    if (progress === null) return null;
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: "var(--t-border)", borderRadius: "var(--t-radius)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${progress}%`,
                background: "var(--t-gradient-button)",
                transition: "width 0.3s",
                boxShadow: isCyberpunk ? "0 0 10px rgba(0,240,255,0.5)" : "none",
              }}
            />
          </div>
          {active && (
            <button
              onClick={handleCancelDownload}
              style={{ fontSize: 10, padding: "3px 10px", borderRadius: "var(--t-radius)", color: "var(--t-danger)", border: "1px solid var(--t-danger)", background: "transparent" }}
            >
              キャンセル
            </button>
          )}
        </div>
        <p style={{ fontSize: 11, color: "var(--t-text-dim)", marginTop: 4, fontFamily: "var(--t-font-display)" }}>
          {progress < 100 ? `${progress.toFixed(1)}%` : "完了"}
        </p>
      </div>
    );
  };

  const stepBadge = (done: boolean) => (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: 22,
        height: 22,
        borderRadius: "50%",
        fontSize: 12,
        border: `1px solid ${done ? "var(--t-success)" : "var(--t-warning)"}`,
        color: done ? "var(--t-success)" : "var(--t-warning)",
      }}
    >
      {done ? "✓" : "!"}
    </span>
  );

  return (
    <div style={{ padding: 24, maxWidth: 480, margin: "0 auto", position: "relative" }}>
      {/* Scanline overlay — cyberpunk & retro */}
      {hasScanline && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: "none",
            zIndex: 100,
            background: "repeating-linear-gradient(0deg, transparent, transparent 2px, var(--t-scanline) 2px, var(--t-scanline) 4px)",
          }}
        />
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <button
          onClick={onBack}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            border: "1px solid var(--t-border)",
            color: "var(--t-primary)",
            borderRadius: "var(--t-radius)",
          }}
        >
          {labels.back}
        </button>
        <h2 style={{
          fontFamily: "var(--t-font-display)",
          fontSize: isRetro ? 14 : 18,
          fontWeight: 700,
          background: "var(--t-gradient)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          letterSpacing: isCyberpunk ? 3 : isRetro ? 4 : 1,
        }}>{labels.settingsTitle}</h2>
      </div>

      {/* Flash message */}
      {saveMsg && (
        <div
          role="status"
          className={isMsgError ? "flash-error" : "flash-success"}
          style={{
            borderRadius: "var(--t-radius)",
            padding: "8px 14px",
            marginBottom: 16,
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            animation: "fadeIn 0.2s ease-out",
            fontFamily: "var(--t-font-body)",
          }}
        >
          {isMsgError ? "⚠ " : "✓ "}{saveMsg}
        </div>
      )}

      {/* First-run setup wizard */}
      {isFirstRun && setupStatus && (
        <div style={{
          background: "var(--t-bg-card)",
          border: `2px solid ${setupComplete ? "var(--t-success)" : "var(--t-primary)"}`,
          borderRadius: "var(--t-radius-lg)",
          padding: 20,
          marginBottom: 20,
          boxShadow: setupComplete ? "none" : "var(--t-glow)",
          animation: "fadeIn 0.4s ease-out",
        }}>
          <div style={{
            fontSize: 16,
            fontWeight: 700,
            fontFamily: "var(--t-font-display)",
            background: "var(--t-gradient)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginBottom: 6,
          }}>
            {isCyberpunk ? "▸ INITIAL SETUP" : isRetro ? "> INIT_SETUP" : "🚀 初回セットアップ"}
          </div>
          {!setupComplete ? (
            <>
              <p style={{ fontSize: 12, color: "var(--t-text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
                Voxtro を使い始めるには、音声エンジンとモデルのダウンロードが必要です。
                下のボタンでまとめてダウンロードできます（個別の操作は「セットアップ」セクションから）。
              </p>
              <button
                onClick={handleSetupAll}
                disabled={anyDownloading}
                style={{
                  width: "100%",
                  padding: "10px 16px",
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--t-button-text-on-gradient)",
                  background: "var(--t-gradient-button)",
                  border: "none",
                  borderRadius: "var(--t-radius)",
                  boxShadow: "var(--t-glow)",
                }}
              >
                {anyDownloading ? "ダウンロード中..." : "⬇ まとめてダウンロードして始める"}
              </button>
            </>
          ) : (
            <div style={{
              marginTop: 8,
              padding: "10px 16px",
              borderRadius: "var(--t-radius)",
              fontSize: 13,
              fontWeight: 600,
              textAlign: "center",
              animation: "fadeIn 0.3s ease-out",
            }} className="flash-success">
              ✨ セットアップ完了！「{labels.back.replace(/^[←>]\s*/, "")}」ボタンで使い始めましょう
            </div>
          )}
        </div>
      )}

      {/* セットアップ: 音声エンジン + モデル（この順にダウンロードする） */}
      <div style={sectionStyle}>
        <span style={labelStyle}>{isCyberpunk ? "SETUP — ENGINE & MODEL" : isRetro ? "> SETUP" : "セットアップ（音声エンジン & モデル）"}</span>
        <p style={{ fontSize: 12, color: "var(--t-text-dim)", marginBottom: 12, lineHeight: 1.6 }}>
          文字起こしには 2 つのダウンロードが必要です。初回のみで、いずれも App データフォルダに保存されます。
        </p>

        {/* Step 1: whisper-cli バイナリ */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
          {stepBadge(Boolean(setupStatus?.hasBin))}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t-text)", marginBottom: 2 }}>
              1. 音声エンジン（whisper-cli）
            </div>
            <p style={{ fontSize: 11, color: "var(--t-text-dim)", marginBottom: 6 }}>
              音声認識エンジン本体。約 10〜30 MB。
              {setupStatus?.hasBin ? " — ダウンロード済み" : ""}
            </p>
            {!setupStatus?.hasBin && (
              <button onClick={downloadBin} disabled={anyDownloading} style={{ fontSize: 12, padding: "6px 14px" }}>
                {binDownloading ? "ダウンロード中..." : "⬇ ダウンロード"}
              </button>
            )}
            {renderProgress(binProgress, binDownloading)}
          </div>
        </div>

        {/* Step 2: Whisper モデル */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          {stepBadge(Boolean(setupStatus?.hasModel))}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t-text)", marginBottom: 2 }}>
              2. Whisper モデル
            </div>
            <p style={{ fontSize: 11, color: "var(--t-text-dim)", marginBottom: 6 }}>
              認識精度とサイズのバランスで選べます。
              {setupStatus?.hasModel ? " — ダウンロード済み" : ""}
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as WhisperModel)}
                style={{ flex: 1 }}
                aria-label="Whisper モデルを選択"
              >
                <option value="small">small — 466 MB</option>
                <option value="medium">medium — 1.5 GB</option>
                <option value="large">large — 2.9 GB</option>
              </select>
              <button onClick={downloadModel} disabled={anyDownloading} style={{ fontSize: 12 }}>
                {downloading ? "ダウンロード中..." : "⬇ ダウンロード"}
              </button>
            </div>
            {renderProgress(downloadProgress, downloading)}
            <table style={{ width: "100%", fontSize: 11, color: "var(--t-text-dim)", borderCollapse: "collapse", marginTop: 8 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--t-border)", textAlign: "left" }}>
                  <th style={thStyle}>{isCyberpunk ? "MODEL" : "モデル"}</th>
                  <th style={thStyle}>{isCyberpunk ? "ACCURACY" : "精度"}</th>
                  <th style={thStyle}>{isCyberpunk ? "SPEED" : "速度"}</th>
                  <th style={thStyle}>RAM</th>
                  <th style={thStyle}>GPU</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid var(--t-border)" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600, color: "var(--t-text)" }}>small</td>
                  <td style={{ padding: "6px 8px" }}>日常会話に十分</td>
                  <td style={{ padding: "6px 8px", color: "var(--t-success)" }}>▲ 高速</td>
                  <td style={{ padding: "6px 8px" }}>~1 GB</td>
                  <td style={{ padding: "6px 8px" }}>RTX 2060相当</td>
                </tr>
                <tr style={{ borderBottom: "1px solid var(--t-border)" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600, color: "var(--t-text)" }}>medium</td>
                  <td style={{ padding: "6px 8px" }}>専門用語に強い</td>
                  <td style={{ padding: "6px 8px", color: "var(--t-warning)" }}>◆ 普通</td>
                  <td style={{ padding: "6px 8px" }}>~2.5 GB</td>
                  <td style={{ padding: "6px 8px" }}>RTX 3060相当</td>
                </tr>
                <tr>
                  <td style={{ padding: "6px 8px", fontWeight: 600, color: "var(--t-text)" }}>large</td>
                  <td style={{ padding: "6px 8px" }}>最高精度</td>
                  <td style={{ padding: "6px 8px", color: "var(--t-danger)" }}>▼ 低速</td>
                  <td style={{ padding: "6px 8px" }}>~5 GB</td>
                  <td style={{ padding: "6px 8px" }}>RTX 3080相当</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Shortcut */}
      <div style={sectionStyle}>
        <span style={labelStyle}>{isCyberpunk ? "Global Shortcut" : isRetro ? "> SHORTCUT" : isPop ? "⌨ ショートカット" : "ショートカットキー"}</span>
        <p style={{ fontSize: 12, color: "var(--t-text-dim)", marginBottom: 10, lineHeight: 1.6 }}>
          録音開始/停止のショートカットキー。下の枠を押してからキーを入力すると自動保存されます（Esc でキャンセル）。
          Ctrl / Alt / Cmd キーとの組み合わせが必要です。
        </p>
        <div
          role="button"
          tabIndex={0}
          aria-label={`ショートカットキーを変更。現在は ${shortcut}`}
          onKeyDown={(e) => {
            if (capturing) {
              handleKeyCapture(e);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCapturing(true);
            }
          }}
          onBlur={() => setCapturing(false)}
          onClick={() => setCapturing(true)}
          style={{
            padding: "10px 14px",
            borderRadius: "var(--t-radius)",
            border: capturing ? "1px solid var(--t-primary)" : "1px solid var(--t-border)",
            background: capturing ? (isCyberpunk ? "rgba(0,240,255,0.08)" : isPop ? "rgba(236,72,153,0.06)" : "rgba(37,99,235,0.04)") : "var(--t-input-bg)",
            fontSize: 14,
            fontFamily: "var(--t-font-display)",
            fontWeight: 600,
            textAlign: "center",
            cursor: "pointer",
            outline: "none",
            color: capturing ? "var(--t-primary)" : "var(--t-text)",
            transition: "all 0.2s",
            userSelect: "none",
            boxShadow: capturing ? "var(--t-glow)" : "none",
            letterSpacing: isCyberpunk ? 1 : 0,
          }}
        >
          {capturing ? "⌨ キーを入力...（Esc でキャンセル）" : shortcut}
        </div>
      </div>

      {/* Theme selector */}
      <div style={sectionStyle}>
        <span style={labelStyle}>{isCyberpunk ? "UI THEME" : isRetro ? "> THEME" : isPop ? "🎨 テーマ" : "テーマ"}</span>
        <p style={{ fontSize: 12, color: "var(--t-text-dim)", marginBottom: 12 }}>
          アプリ全体の見た目を切り替えられます。
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }} role="radiogroup" aria-label="テーマ">
          {(Object.keys(THEMES) as ThemeId[]).map((id) => {
            const t = THEMES[id];
            const colors = t.preview;
            const isActive = theme === id;
            return (
              <button
                key={id}
                className="card-btn"
                role="radio"
                aria-checked={isActive}
                onClick={async () => {
                  await setTheme(id);
                  await emit("theme-changed", id);
                  flash(`テーマを「${t.label}」に変更しました`);
                }}
                style={{
                  flex: "1 1 0",
                  minWidth: 120,
                  padding: 12,
                  borderRadius: "var(--t-radius-lg)",
                  background: colors.bg,
                  border: isActive ? `2px solid ${colors.border}` : "2px solid transparent",
                  boxShadow: isActive ? `0 0 12px ${colors.accent}40` : "0 1px 4px rgba(0,0,0,0.1)",
                  cursor: "pointer",
                  transition: "all 0.25s ease",
                  textAlign: "center",
                }}
              >
                {/* Mini preview bar */}
                <div style={{
                  height: 4,
                  borderRadius: 2,
                  background: `linear-gradient(90deg, ${colors.accent}, ${colors.accent}88)`,
                  marginBottom: 8,
                }} />
                <div style={{
                  fontSize: 12,
                  fontWeight: isActive ? 700 : 500,
                  color: colors.text,
                  fontFamily: "var(--t-font-body)",
                }}>
                  {t.label}
                </div>
                <div style={{
                  fontSize: 10,
                  color: colors.text,
                  opacity: 0.7,
                  marginTop: 2,
                }}>
                  {t.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent color */}
      <div style={sectionStyle}>
        <span style={labelStyle}>{isCyberpunk ? "Accent Color" : isPop ? "🌈 アクセントカラー" : "アクセントカラー"}</span>
        <p style={{ fontSize: 12, color: "var(--t-text-dim)", marginBottom: 12 }}>
          フローティングモードのビジュアライザーの色を変更できます。
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }} role="radiogroup" aria-label="アクセントカラー">
          {Object.entries(colorPresets).map(([key, { label, colors: [c1, c2] }]) => (
            <button
              key={key}
              className="card-btn"
              role="radio"
              aria-checked={accentColor === key}
              onClick={async () => {
                setAccentColor(key);
                await saveAccentColor(key);
                await emit("accent-color-changed", key);
                flash(`カラーを「${label}」に変更しました`);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
                background: "transparent",
                border: "none",
                padding: 2,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: isPop ? 18 : "var(--t-radius)",
                  background: `linear-gradient(135deg, ${c1}, ${c2})`,
                  border: accentColor === key ? `2px solid ${c1}` : "1px solid rgba(255,255,255,0.1)",
                  boxShadow: accentColor === key ? `0 0 12px ${c1}60` : "none",
                  transition: "all 0.2s",
                }}
              />
              <span style={{
                fontSize: 10,
                fontFamily: "var(--t-font-display)",
                color: accentColor === key ? "var(--t-text)" : "var(--t-text-dim)",
                fontWeight: accentColor === key ? 700 : 400,
                letterSpacing: 0.5,
              }}>
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Gemini API Key */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div>
            <span style={{ ...labelStyle, marginBottom: 4 }}>{isCyberpunk ? "Gemini API Key" : "Gemini APIキー"}</span>
            <p style={{ fontSize: 12, color: "var(--t-text-dim)", margin: 0, lineHeight: 1.65 }}>
              音声認識後の文章をLLMで整える機能を使う場合だけ設定します。
              通常の文字起こしだけなら入力しなくて大丈夫です。
            </p>
          </div>
          <button
            onClick={() => setApiKeyExpanded((open) => !open)}
            style={{
              flexShrink: 0,
              padding: "7px 10px",
              fontSize: 11,
              fontWeight: 700,
              border: "1px solid var(--t-border-active)",
              color: "var(--t-primary)",
              borderRadius: "var(--t-radius)",
              background: "var(--t-input-bg)",
            }}
          >
            {apiKeyExpanded ? "閉じる" : apiKey ? "変更" : "入力"}
          </button>
        </div>

        {apiKeyExpanded && (
          <div style={{ marginTop: 14, animation: "fadeIn 0.2s ease-out" }}>
            <div
              style={{
                padding: "10px 12px",
                border: "1px solid var(--t-warning)",
                borderRadius: "var(--t-radius)",
                background: "rgba(245, 158, 11, 0.10)",
                color: "var(--t-text)",
                fontSize: 12,
                lineHeight: 1.65,
                marginBottom: 10,
              }}
            >
              LLM整形を使うと、認識されたテキストがGemini APIへ送信されます。
              機密情報や外部送信したくない内容を扱う場合は、APIキーを設定しないでください。
            </div>
            <p style={{ fontSize: 12, color: "var(--t-text-dim)", margin: "0 0 10px", lineHeight: 1.6 }}>
              APIキーはGoogle AI Studioで作成できます。保存すると、次回以降の文字起こしでLLM整形が有効になります。
              <br />
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--t-primary)", fontWeight: 700 }}
              >
                Google AI StudioでAPIキーを作成
              </a>
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza..."
              aria-label="Gemini APIキー"
              style={{ marginBottom: 8 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleApiKeySave}>{isCyberpunk ? "SAVE" : "保存"}</button>
              <button onClick={handleApiKeyTest} disabled={testingKey || !apiKey}>
                {testingKey ? "テスト中..." : "接続テスト"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
