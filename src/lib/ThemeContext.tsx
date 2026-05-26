import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import { ThemeId, THEMES, applyTheme } from "./themes";

const VALID_THEMES = Object.keys(THEMES) as ThemeId[];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isValidTheme(value: unknown): value is ThemeId {
  return typeof value === "string" && VALID_THEMES.includes(value as ThemeId);
}

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "simple",
  setTheme: async () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>("simple");

  // 初回読み込み
  useEffect(() => {
    (async () => {
      try {
        const store = await Store.load("config.json");
        const saved = await store.get<string>("uiTheme");
        if (isValidTheme(saved)) {
          setThemeState(saved);
          applyTheme(saved);
        } else {
          applyTheme("simple");
        }
      } catch {
        applyTheme("simple");
      }
    })();
  }, []);

  // 別ウィンドウからのテーマ変更を受信
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen<string>("theme-changed", ({ payload }) => {
      if (isValidTheme(payload)) {
        setThemeState(payload);
        applyTheme(payload);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const setTheme = async (id: ThemeId) => {
    setThemeState(id);
    applyTheme(id);
    if (!isTauriRuntime()) return;
    try {
      const store = await Store.load("config.json");
      await store.set("uiTheme", id);
      await store.save();
    } catch (e) {
      console.error("テーマ保存エラー:", e);
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
