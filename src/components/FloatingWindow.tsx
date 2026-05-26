import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Store } from "@tauri-apps/plugin-store";
import { useTheme } from "../lib/ThemeContext";
import { ThemeId } from "../lib/themes";

type FloatingStatus = "idle" | "recording" | "transcribing" | "formatting" | "done" | "error";
type ViewMode = "circle" | "waveform";

type Palette = {
    bg0: string;
    bg1: string;
    panel: string;
    grid: string;
    line: string;
    line2: string;
    bars: string;
    accent: string;
    danger: string;
    text: string;
    dim: string;
};

const COLOR_PRESETS: Record<string, [string, string]> = {
    ocean: ["#00d5ff", "#7c3aed"],
    sunset: ["#ff7a3d", "#ff2d9d"],
    forest: ["#22c55e", "#14b8a6"],
    lavender: ["#a855f7", "#f472b6"],
    neon: ["#00f5d4", "#fb37ff"],
};

const PALETTES: Record<ThemeId, Palette> = {
    cyberpunk: {
        bg0: "#070711",
        bg1: "#11142a",
        panel: "rgba(10, 12, 28, 0.86)",
        grid: "rgba(0, 213, 255, 0.14)",
        line: "#00d5ff",
        line2: "#fb37ff",
        bars: "#8b5cf6",
        accent: "#22ffb6",
        danger: "#ff3366",
        text: "#eef6ff",
        dim: "rgba(238, 246, 255, 0.58)",
    },
    simple: {
        bg0: "#eef4ff",
        bg1: "#dceafe",
        panel: "rgba(255, 255, 255, 0.78)",
        grid: "rgba(37, 99, 235, 0.12)",
        line: "#2563eb",
        line2: "#06b6d4",
        bars: "#3b82f6",
        accent: "#10b981",
        danger: "#dc2626",
        text: "#172033",
        dim: "rgba(23, 32, 51, 0.54)",
    },
    pop: {
        bg0: "#fff1f8",
        bg1: "#f1e7ff",
        panel: "rgba(255, 255, 255, 0.74)",
        grid: "rgba(236, 72, 153, 0.13)",
        line: "#ec4899",
        line2: "#8b5cf6",
        bars: "#f472b6",
        accent: "#06b6d4",
        danger: "#f43f5e",
        text: "#42163e",
        dim: "rgba(66, 22, 62, 0.55)",
    },
    natural: {
        bg0: "#f7f2e8",
        bg1: "#dce8d7",
        panel: "rgba(255, 252, 245, 0.76)",
        grid: "rgba(67, 112, 91, 0.13)",
        line: "#43705b",
        line2: "#c67a4a",
        bars: "#729b73",
        accent: "#2f9e8f",
        danger: "#c05746",
        text: "#312a22",
        dim: "rgba(49, 42, 34, 0.54)",
    },
    midnight: {
        bg0: "#11111f",
        bg1: "#24233a",
        panel: "rgba(19, 19, 32, 0.83)",
        grid: "rgba(212, 168, 83, 0.12)",
        line: "#e8c06a",
        line2: "#7dd3fc",
        bars: "#d4a853",
        accent: "#f97316",
        danger: "#ef4444",
        text: "#f4efe7",
        dim: "rgba(244, 239, 231, 0.56)",
    },
    retro: {
        bg0: "#061006",
        bg1: "#102410",
        panel: "rgba(5, 16, 5, 0.88)",
        grid: "rgba(51, 255, 51, 0.13)",
        line: "#33ff33",
        line2: "#ffb000",
        bars: "#66ff66",
        accent: "#ff8c00",
        danger: "#ff3333",
        text: "#ccffcc",
        dim: "rgba(204, 255, 204, 0.5)",
    },
};

const VIEW_SIZE: Record<ViewMode, { width: number; height: number }> = {
    circle: { width: 104, height: 104 },
    waveform: { width: 360, height: 112 },
};

const MENU_SIZE = { width: 300, height: 260 };

const STATUS_LABEL: Record<FloatingStatus, string> = {
    idle: "READY",
    recording: "LIVE",
    transcribing: "TEXT",
    formatting: "MAKE",
    done: "DONE",
    error: "ERR",
};

function isTauriRuntime(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function FloatingWindow() {
    const { theme, setTheme } = useTheme();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [status, setStatus] = useState<FloatingStatus>("idle");
    const [errorMsg, setErrorMsg] = useState("");
    const [colors, setColors] = useState<[string, string]>(COLOR_PRESETS.ocean);
    const [viewMode, setViewMode] = useState<ViewMode>("waveform");
    const [menuOpen, setMenuOpen] = useState(false);
    const [winW, setWinW] = useState(() => window.innerWidth);
    const [winH, setWinH] = useState(() => window.innerHeight);

    const audioLevelRef = useRef(0);
    const smoothLevelRef = useRef(0);
    const timeRef = useRef(0);
    const animIdRef = useRef(0);
    const barsRef = useRef<number[]>(new Array(96).fill(0));
    const waveRef = useRef<number[]>(new Array(96).fill(0));
    const peakRef = useRef(0);

    useEffect(() => {
        const onResize = () => {
            setWinW(window.innerWidth);
            setWinH(window.innerHeight);
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const resizeWindow = useCallback(async (open: boolean, mode: ViewMode) => {
        if (!isTauriRuntime()) return;
        const size = open ? MENU_SIZE : VIEW_SIZE[mode];
        try {
            await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
        } catch (e) {
            console.error("floating resize failed:", e);
        }
    }, []);

    useEffect(() => {
        resizeWindow(menuOpen, viewMode);
    }, [menuOpen, resizeWindow, viewMode]);

    useEffect(() => {
        (async () => {
            try {
                const store = await Store.load("config.json");
                const preset = await store.get<string>("accentColor");
                if (preset && COLOR_PRESETS[preset]) setColors(COLOR_PRESETS[preset]);

                const savedMode = await store.get<ViewMode>("floatingViewMode");
                if (savedMode === "circle" || savedMode === "waveform") {
                    setViewMode(savedMode);
                }
            } catch {
                // Defaults are fine when config is unavailable.
            }
        })();
    }, []);

    const saveViewMode = useCallback(async (mode: ViewMode) => {
        setViewMode(mode);
        try {
            const store = await Store.load("config.json");
            await store.set("floatingViewMode", mode);
            await store.save();
        } catch {
            // Visual preference persistence is non-critical.
        }
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        const unlisten = listen<string>("accent-color-changed", ({ payload }) => {
            if (COLOR_PRESETS[payload]) setColors(COLOR_PRESETS[payload]);
        });
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        const unlisten = listen<number>("audio-level", ({ payload }) => {
            audioLevelRef.current = Math.max(0, Math.min(payload, 1));
        });
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        const unlisteners = Promise.all([
            listen("recording-started", () => setStatus("recording")),
            listen("recording-stopped", () => setStatus("transcribing")),
            listen("transcribing", () => setStatus("transcribing")),
            listen("formatting", () => setStatus("formatting")),
            listen("transcription-complete", () => {
                setStatus("done");
                window.setTimeout(() => setStatus("idle"), 1800);
            }),
            listen<string>("transcription-error", ({ payload }) => {
                setErrorMsg(payload);
                setStatus("error");
                window.setTimeout(() => {
                    setStatus("idle");
                    setErrorMsg("");
                }, 8000);
            }),
        ]);
        return () => {
            unlisteners.then((fns) => fns.forEach((fn) => fn()));
        };
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || menuOpen) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(winW * dpr);
        canvas.height = Math.round(winH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const palette = withAccent(PALETTES[theme] ?? PALETTES.cyberpunk, colors);

        const frame = () => {
            timeRef.current += 1;
            const amplified = Math.min(audioLevelRef.current * 28, 1);
            const targetLevel = status === "recording" ? Math.pow(amplified, 0.55) : 0;
            smoothLevelRef.current += (targetLevel - smoothLevelRef.current) * 0.28;
            peakRef.current = Math.max(smoothLevelRef.current, peakRef.current * 0.965);

            if (viewMode === "waveform") {
                drawWaveform(ctx, winW, winH, palette, status, smoothLevelRef.current, peakRef.current, timeRef.current, barsRef.current, waveRef.current);
            } else {
                drawOrb(ctx, winW, winH, palette, status, smoothLevelRef.current, peakRef.current, timeRef.current, barsRef.current);
            }

            animIdRef.current = window.requestAnimationFrame(frame);
        };

        frame();
        return () => window.cancelAnimationFrame(animIdRef.current);
    }, [colors, menuOpen, status, theme, viewMode, winH, winW]);

    const handleClick = useCallback(async () => {
        if (!isTauriRuntime()) {
            setStatus((current) => {
                const next = current === "recording" ? "idle" : "recording";
                audioLevelRef.current = next === "recording" ? 0.08 : 0;
                return next;
            });
            return;
        }
        try {
            await invoke("toggle_recording_command");
        } catch (e) {
            console.error("toggle recording failed:", e);
        }
    }, []);

    const handleClose = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (!isTauriRuntime()) return;
        try {
            await invoke("switch_to_main");
        } catch (err) {
            console.error("close floating failed:", err);
        }
    }, []);

    const handleThemeChange = useCallback(async (id: ThemeId) => {
        await setTheme(id);
        if (!isTauriRuntime()) return;
        const { emit } = await import("@tauri-apps/api/event");
        await emit("theme-changed", id);
    }, [setTheme]);

    const preventFocus = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
    }, []);

    const palette = PALETTES[theme] ?? PALETTES.cyberpunk;
    const isWaveform = viewMode === "waveform";
    const controlSize = menuOpen ? 24 : isWaveform ? 24 : 22;

    return (
        <div
            style={{
                position: "relative",
                width: "100vw",
                height: "100vh",
                overflow: "hidden",
                borderRadius: menuOpen ? 0 : isWaveform ? 22 : 52,
                background: palette.bg0,
                fontFamily: "'Inter', 'Segoe UI', sans-serif",
            }}
        >
            <div data-tauri-drag-region style={{ position: "absolute", inset: 0, zIndex: 1 }} />

            <div style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 5, zIndex: 30 }}>
                <IconButton
                    label={menuOpen ? "閉じる" : "設定"}
                    size={controlSize}
                    onClick={() => setMenuOpen((open) => !open)}
                    onMouseDown={preventFocus}
                >
                    {menuOpen ? "×" : "⚙"}
                </IconButton>
                {!menuOpen && (
                    <IconButton label="メイン画面へ" size={controlSize} onClick={handleClose} onMouseDown={preventFocus}>
                        ↗
                    </IconButton>
                )}
            </div>

            {menuOpen ? (
                <FloatingMenu
                    palette={palette}
                    theme={theme}
                    viewMode={viewMode}
                    onThemeChange={handleThemeChange}
                    onViewModeChange={saveViewMode}
                    onMouseDown={preventFocus}
                />
            ) : (
                <>
                    <canvas ref={canvasRef} style={{ width: winW, height: winH, display: "block", pointerEvents: "none" }} />
                    <button
                        onClick={handleClick}
                        onMouseDown={preventFocus}
                        tabIndex={-1}
                        aria-label="録音の開始または停止"
                        title="録音の開始 / 停止"
                        style={{
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -50%)",
                            width: isWaveform ? "72%" : "64%",
                            height: isWaveform ? "68%" : "64%",
                            borderRadius: isWaveform ? 16 : "50%",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            zIndex: 10,
                            padding: 0,
                        }}
                    />
                </>
            )}

            {status === "error" && errorMsg && !menuOpen && (
                <div
                    title={errorMsg}
                    style={{
                        position: "absolute",
                        left: 12,
                        right: 48,
                        bottom: 9,
                        zIndex: 25,
                        color: "#fff",
                        background: "rgba(220, 38, 38, 0.88)",
                        border: "1px solid rgba(255, 255, 255, 0.25)",
                        borderRadius: 7,
                        padding: "3px 7px",
                        fontSize: 10,
                        fontWeight: 700,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {errorMsg}
                </div>
            )}
        </div>
    );
}

function FloatingMenu({
    palette,
    theme,
    viewMode,
    onThemeChange,
    onViewModeChange,
    onMouseDown,
}: {
    palette: Palette;
    theme: ThemeId;
    viewMode: ViewMode;
    onThemeChange: (id: ThemeId) => void;
    onViewModeChange: (mode: ViewMode) => void;
    onMouseDown: (e: React.MouseEvent) => void;
}) {
    const themes: { id: ThemeId; label: string; color: string }[] = [
        { id: "cyberpunk", label: "Cyber", color: PALETTES.cyberpunk.line },
        { id: "simple", label: "Simple", color: PALETTES.simple.line },
        { id: "pop", label: "Pop", color: PALETTES.pop.line },
        { id: "natural", label: "Natural", color: PALETTES.natural.line },
        { id: "midnight", label: "Night", color: PALETTES.midnight.line },
        { id: "retro", label: "Retro", color: PALETTES.retro.line },
    ];

    return (
        <div
            style={{
                position: "absolute",
                inset: 0,
                zIndex: 20,
                boxSizing: "border-box",
                padding: "38px 14px 14px",
                background: `linear-gradient(145deg, ${palette.bg0}, ${palette.bg1})`,
                color: palette.text,
            }}
        >
            <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 900, marginBottom: 4 }}>フローティング表示</div>
                <div style={{ fontSize: 10, color: palette.dim, lineHeight: 1.45 }}>
                    見た目とカラーテーマを切り替えます。設定中もウィンドウはドラッグできます。
                </div>
            </div>

            <div style={{ fontSize: 9, color: palette.dim, fontWeight: 900, marginBottom: 7 }}>表示モード</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                {(["waveform", "circle"] as ViewMode[]).map((mode) => (
                    <button
                        key={mode}
                        onClick={() => onViewModeChange(mode)}
                        onMouseDown={onMouseDown}
                        tabIndex={-1}
                        style={menuButtonStyle(viewMode === mode, palette)}
                    >
                        <span style={{ fontSize: 14 }}>{mode === "waveform" ? "▥" : "○"}</span>
                        {mode === "waveform" ? "ラインとバー" : "リング"}
                    </button>
                ))}
            </div>

            <div style={{ fontSize: 9, color: palette.dim, fontWeight: 900, marginBottom: 7 }}>カラーテーマ</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {themes.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => onThemeChange(item.id)}
                        onMouseDown={onMouseDown}
                        tabIndex={-1}
                        style={menuButtonStyle(theme === item.id, { ...palette, line: item.color })}
                    >
                        <span style={{ width: 8, height: 8, borderRadius: 8, background: item.color, boxShadow: `0 0 10px ${item.color}` }} />
                        {item.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function IconButton({
    children,
    label,
    size,
    onClick,
    onMouseDown,
}: {
    children: React.ReactNode;
    label: string;
    size: number;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onMouseDown: (e: React.MouseEvent) => void;
}) {
    return (
        <button
            onClick={onClick}
            onMouseDown={onMouseDown}
            tabIndex={-1}
            aria-label={label}
            title={label}
            style={{
                width: size,
                height: size,
                borderRadius: 7,
                border: "1px solid rgba(255, 255, 255, 0.22)",
                background: "rgba(12, 14, 24, 0.42)",
                color: "rgba(255, 255, 255, 0.9)",
                backdropFilter: "blur(8px)",
                boxShadow: "0 8px 20px rgba(0, 0, 0, 0.16)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                fontSize: Math.max(13, size * 0.58),
                lineHeight: 1,
                padding: 0,
            }}
        >
            {children}
        </button>
    );
}

function menuButtonStyle(active: boolean, palette: Palette): React.CSSProperties {
    return {
        minHeight: 34,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderRadius: 8,
        border: active ? `1px solid ${hexToRgba(palette.line, 0.72)}` : "1px solid rgba(255, 255, 255, 0.12)",
        background: active ? hexToRgba(palette.line, 0.16) : "rgba(255, 255, 255, 0.06)",
        color: active ? palette.text : palette.dim,
        fontSize: 10,
        fontWeight: 800,
        cursor: "pointer",
        padding: "0 8px",
    };
}

function drawWaveform(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    palette: Palette,
    status: FloatingStatus,
    level: number,
    peak: number,
    t: number,
    bars: number[],
    wave: number[],
) {
    const live = status === "recording";
    const danger = status === "error";
    const activity = live ? level : status === "idle" ? 0.08 : 0.24;
    const radius = Math.min(22, height / 3);

    drawRoundedGradientPanel(ctx, width, height, radius, palette, danger);
    drawGrid(ctx, width, height, palette, t);

    const left = 18;
    const right = width - 18;
    const top = 24;
    const bottom = height - 17;
    const areaW = Math.max(80, right - left);
    const midY = (top + bottom) / 2;
    const maxH = (bottom - top) * 0.92;
    const gap = width < 280 ? 2 : 3;
    const desiredBarW = width < 280 ? 4 : 5;
    const barCount = Math.max(18, Math.min(54, Math.floor((areaW + gap) / (desiredBarW + gap))));
    const barW = Math.max(2.5, (areaW - gap * (barCount - 1)) / barCount);

    for (let i = 0; i < barCount; i += 1) {
        const center = 1 - Math.abs(i - (barCount - 1) / 2) / ((barCount - 1) / 2);
        const pulse = Math.sin(t * 0.08 + i * 0.62) * 0.5 + 0.5;
        const randomBeat = live ? Math.random() * 0.42 : 0;
        const target = Math.max(4, maxH * (0.08 + activity * (0.28 + center * 0.52 + pulse * 0.24 + randomBeat)));
        bars[i] += (target - bars[i]) * (live ? 0.24 : 0.12);

        const x = left + i * (barW + gap);
        const h = Math.min(maxH, bars[i]);
        const y = midY - h / 2;
        const intensity = h / maxH;
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, danger ? palette.danger : hexToRgba(palette.line2, 0.86));
        grad.addColorStop(0.55, hexToRgba(danger ? palette.danger : palette.bars, 0.68 + intensity * 0.28));
        grad.addColorStop(1, hexToRgba(palette.line, 0.38 + intensity * 0.26));

        ctx.save();
        ctx.shadowColor = danger ? palette.danger : palette.line;
        ctx.shadowBlur = live ? 7 + intensity * 12 : 2;
        ctx.fillStyle = grad;
        roundRect(ctx, x, y, barW, h, Math.min(6, barW));
        ctx.fill();
        ctx.restore();
    }

    const wavePoints = Math.max(64, Math.round(areaW / 2.5));
    while (wave.length < wavePoints) wave.push(level || 0.05);
    while (wave.length > wavePoints) wave.shift();
    for (let i = 0; i < wavePoints; i += 1) {
        const xRatio = i / Math.max(1, wavePoints - 1);
        const carrier = Math.sin(t * 0.16 + xRatio * Math.PI * 18);
        const harmonic = Math.sin(t * 0.055 + xRatio * Math.PI * 7.5);
        const target = (live ? level : 0.09) * (0.62 + carrier * 0.24 + harmonic * 0.14);
        wave[i] += (Math.max(0.03, target) - wave[i]) * (live ? 0.18 : 0.08);
    }
    drawWaveLine(ctx, wave, left, right, top, bottom, palette.line, t, 1);
    drawWaveLine(ctx, wave, left, right, top + 9, bottom - 9, palette.line2, t + 18, -1);

    const meterX = width - 92;
    const meterY = 25;
    drawStatusPill(ctx, meterX, meterY, palette, status, live, danger);

    ctx.save();
    ctx.fillStyle = palette.dim;
    ctx.font = "700 8px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("VOXTRO", 18, 17);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(peak * 100).toString().padStart(2, "0")}%`, width - 16, height - 12);
    ctx.restore();
}

function drawOrb(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    palette: Palette,
    status: FloatingStatus,
    level: number,
    peak: number,
    t: number,
    bars: number[],
) {
    const live = status === "recording";
    const danger = status === "error";
    const size = Math.min(width, height);
    const cx = width / 2;
    const cy = height / 2;
    const outer = size / 2 - 4;
    const inner = size * 0.24;

    drawRoundedGradientPanel(ctx, width, height, outer, palette, danger);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * (live ? 0.018 : 0.006));
    ctx.strokeStyle = hexToRgba(danger ? palette.danger : palette.line, 0.34 + peak * 0.42);
    ctx.lineWidth = 1.3;
    ctx.shadowColor = danger ? palette.danger : palette.line;
    ctx.shadowBlur = live ? 14 + peak * 18 : 6;
    ctx.beginPath();
    ctx.ellipse(0, 0, outer * 0.78, outer * 0.48, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(Math.PI / 2.6);
    ctx.strokeStyle = hexToRgba(palette.line2, 0.24 + peak * 0.36);
    ctx.beginPath();
    ctx.ellipse(0, 0, outer * 0.74, outer * 0.44, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const count = 48;
    for (let i = 0; i < count; i += 1) {
        const pulse = Math.sin(t * 0.09 + i * 0.48) * 0.5 + 0.5;
        const target = Math.max(2, (live ? level : 0.05) * outer * (0.18 + pulse * 0.38 + Math.random() * 0.24));
        bars[i] += (target - bars[i]) * (live ? 0.22 : 0.1);
        const a = (i / count) * Math.PI * 2 - Math.PI / 2;
        const barH = Math.min(outer * 0.42, bars[i]);
        const r0 = inner + outer * 0.18;
        const x0 = cx + Math.cos(a) * r0;
        const y0 = cy + Math.sin(a) * r0;
        const x1 = cx + Math.cos(a) * (r0 + barH);
        const y1 = cy + Math.sin(a) * (r0 + barH);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = hexToRgba(i % 3 === 0 ? palette.line2 : palette.line, live ? 0.38 + barH / outer : 0.16);
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.stroke();
    }

    const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, inner * 1.4);
    core.addColorStop(0, hexToRgba(danger ? palette.danger : palette.accent, live ? 0.92 : 0.72));
    core.addColorStop(0.52, hexToRgba(palette.line, 0.24 + peak * 0.38));
    core.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, inner * (1.05 + peak * 0.2), 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.fillStyle = danger ? palette.danger : palette.text;
    ctx.font = "800 13px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(STATUS_LABEL[status], cx, cy + 1);
    ctx.restore();
}

function drawRoundedGradientPanel(ctx: CanvasRenderingContext2D, width: number, height: number, radius: number, palette: Palette, danger: boolean) {
    ctx.clearRect(0, 0, width, height);
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, danger ? "#321017" : palette.bg0);
    bg.addColorStop(0.58, palette.bg1);
    bg.addColorStop(1, danger ? "#4a1420" : palette.bg0);
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, width, height, radius);
    ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const glow = ctx.createRadialGradient(width * 0.18, height * 0.12, 0, width * 0.18, height * 0.12, width * 0.62);
    glow.addColorStop(0, hexToRgba(danger ? palette.danger : palette.line, 0.28));
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    roundRect(ctx, 0, 0, width, height, radius);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = hexToRgba(danger ? palette.danger : palette.line, 0.26);
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, width - 1, height - 1, Math.max(0, radius - 0.5));
    ctx.stroke();
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette, t: number) {
    ctx.save();
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    for (let x = 16 - (t % 16); x < width; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 15);
        ctx.lineTo(x, height - 13);
        ctx.stroke();
    }
    for (let y = 20; y < height - 12; y += 15) {
        ctx.beginPath();
        ctx.moveTo(14, y);
        ctx.lineTo(width - 14, y);
        ctx.stroke();
    }
    ctx.restore();
}

function drawWaveLine(
    ctx: CanvasRenderingContext2D,
    wave: number[],
    left: number,
    right: number,
    top: number,
    bottom: number,
    color: string,
    t: number,
    direction: number,
) {
    const mid = (top + bottom) / 2;
    const amp = (bottom - top) * 0.44;
    const step = (right - left) / Math.max(1, wave.length - 1);

    ctx.save();
    ctx.beginPath();
    wave.forEach((value, i) => {
        const x = left + i * step;
        const phase = Math.sin(t * 0.07 + i * 0.42) * 0.18;
        const y = mid + direction * (value + phase) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = hexToRgba(color, 0.78);
    ctx.lineWidth = 1.7;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
}

function drawStatusPill(ctx: CanvasRenderingContext2D, x: number, y: number, palette: Palette, status: FloatingStatus, live: boolean, danger: boolean) {
    const color = danger ? palette.danger : live ? palette.accent : palette.line;
    ctx.save();
    ctx.fillStyle = danger ? "rgba(110, 12, 32, 0.94)" : "rgba(9, 12, 24, 0.94)";
    ctx.strokeStyle = hexToRgba(color, 0.76);
    ctx.shadowColor = color;
    ctx.shadowBlur = live ? 16 : 8;
    roundRect(ctx, x - 33, y - 13, 66, 26, 13);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(x - 21, y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, live ? 0.7 + Math.sin(performance.now() * 0.012) * 0.25 : 0.78);
    ctx.shadowColor = color;
    ctx.shadowBlur = live ? 12 : 3;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.42)";
    ctx.font = "900 10px Arial, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.strokeText(STATUS_LABEL[status], x - 10, y + 0.5);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(STATUS_LABEL[status], x - 10, y + 0.5);
    ctx.restore();
}

function withAccent(palette: Palette, colors: [string, string]): Palette {
    return {
        ...palette,
        line: colors[0] || palette.line,
        line2: colors[1] || palette.line2,
    };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
    const safe = hex.startsWith("#") ? hex : "#ffffff";
    const r = parseInt(safe.slice(1, 3), 16);
    const g = parseInt(safe.slice(3, 5), 16);
    const b = parseInt(safe.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(alpha, 1))})`;
}
