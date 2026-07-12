import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTheme } from "../lib/ThemeContext";

type UpdateState = "idle" | "available" | "downloading" | "ready";

interface Props {
  /** 録音・文字起こし処理中は true。更新の適用ボタンを無効化する */
  busy?: boolean;
}

export default function UpdateChecker({ busy = false }: Props) {
  const { theme } = useTheme();
  const [state, setState] = useState<UpdateState>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");

  const isCyberpunk = theme === "cyberpunk";

  useEffect(() => {
    const timer = setTimeout(() => checkForUpdate(), 3000);
    return () => clearTimeout(timer);
  }, []);

  const checkForUpdate = async () => {
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setVersion(found.version);
        setState("available");
      }
    } catch (err) {
      console.warn("更新チェック失敗:", err);
    }
  };

  const startDownload = async () => {
    if (!update) return;
    try {
      setError("");
      setState("downloading");
      let totalBytes = 0;
      let downloadedBytes = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            setProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        }
      });

      setState("ready");
    } catch (err) {
      console.warn("更新ダウンロード失敗:", err);
      setError(String(err));
      setState("available");
    }
  };

  if (state === "idle") return null;

  const smallBtnStyle: React.CSSProperties = {
    fontSize: 11,
    padding: "5px 12px",
    borderRadius: "var(--t-radius)",
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        left: 16,
        padding: "12px 18px",
        borderRadius: "var(--t-radius-lg)",
        background: "var(--t-bg-card)",
        border: "1px solid var(--t-border)",
        backdropFilter: "var(--t-section-backdrop)",
        fontSize: 12,
        fontFamily: "var(--t-font-body)",
        fontWeight: 600,
        color: "var(--t-primary)",
        zIndex: 1000,
        animation: "fadeIn 0.3s ease-out",
        boxShadow: "var(--t-glow)",
      }}
    >
      {state === "available" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ letterSpacing: isCyberpunk ? 0.5 : 0, flex: 1 }}>
            {isCyberpunk && <span style={{ fontFamily: "var(--t-font-display)", fontSize: 9, marginRight: 8, color: "var(--t-accent)" }}>NEW</span>}
            新しいバージョン v{version} が利用できます
          </span>
          <button onClick={startDownload} disabled={busy} style={{ ...smallBtnStyle, fontWeight: 700 }}>
            今すぐ更新
          </button>
          <button onClick={() => setState("idle")} style={{ ...smallBtnStyle, color: "var(--t-text-dim)" }}>
            後で
          </button>
        </div>
      )}
      {state === "downloading" && (
        <div>
          <div style={{ marginBottom: 6 }}>
            {isCyberpunk && <span style={{ fontFamily: "var(--t-font-display)", fontSize: 9, marginRight: 8, color: "var(--t-warning)" }}>DL</span>}
            v{version} をダウンロード中... <span style={{ fontFamily: "var(--t-font-display)" }}>{progress}%</span>
          </div>
          <div
            style={{
              height: 3,
              borderRadius: "var(--t-radius)",
              background: "var(--t-border)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "var(--t-gradient-button)",
                transition: "width 0.3s",
                boxShadow: isCyberpunk ? "0 0 8px rgba(0,240,255,0.5)" : "none",
              }}
            />
          </div>
        </div>
      )}
      {state === "ready" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "var(--t-success)", flex: 1 }}>
            {isCyberpunk && <span style={{ fontFamily: "var(--t-font-display)", fontSize: 9, marginRight: 8 }}>OK</span>}
            更新の準備ができました
          </span>
          <button
            onClick={() => relaunch()}
            disabled={busy}
            title={busy ? "処理が終わってから再起動できます" : undefined}
            style={{ ...smallBtnStyle, fontWeight: 700 }}
          >
            再起動して適用
          </button>
        </div>
      )}
      {error && (
        <div style={{ fontSize: 10, color: "var(--t-danger)", marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}
