import { Store } from "@tauri-apps/plugin-store";

let _store: Store | null = null;
async function getStore(): Promise<Store> {
  if (!_store) {
    _store = await Store.load("config.json");
  }
  return _store;
}

export async function getApiKey(): Promise<string | null> {
  const store = await getStore();
  return (await store.get<string>("gemini_api_key")) ?? null;
}

export async function saveApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set("gemini_api_key", key);
  await store.save();
}

export async function getShortcut(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>("shortcut")) ?? "Ctrl+Shift+K";
}

export async function saveShortcut(shortcut: string): Promise<void> {
  const store = await getStore();
  await store.set("shortcut", shortcut);
  await store.save();
}

export async function getModel(): Promise<"small" | "medium" | "large"> {
  const store = await getStore();
  return ((await store.get<string>("model")) ?? "small") as "small" | "medium" | "large";
}

export async function saveModel(model: "small" | "medium" | "large"): Promise<void> {
  const store = await getStore();
  await store.set("model", model);
  await store.save();
}

export async function getAccentColor(): Promise<string> {
  const store = await getStore();
  return (await store.get<string>("accentColor")) ?? "ocean";
}

export async function saveAccentColor(color: string): Promise<void> {
  const store = await getStore();
  await store.set("accentColor", color);
  await store.save();
}

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGemini(apiKey: string, prompt: string, maxOutputTokens: number): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    // APIキーはURLクエリではなくヘッダーで送る（ログ等への漏洩リスク低減）
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // thinkingBudget: 0 — 整形タスクに思考は不要。レイテンシとトークン消費を抑える
      generationConfig: { temperature: 0.2, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini API から予期しない形式のレスポンスが返されました");
  }
  return text.trim();
}

/**
 * Gemini API を呼び出して日本語テキストを整形する。
 * APIキーが未設定の場合は Error をスローする（呼び出し元でスキップ処理を行う）。
 */
export async function formatWithGemini(rawText: string): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("Gemini APIキーが設定されていません");
  }

  const prompt =
    `以下の音声認識テキストから不要なフィラーワード（「えー」「あの」「まあ」「えっと」など）を取り除き、` +
    `適切な句読点を付けた自然な日本語にしてください。テキストのみを返してください。\n\n${rawText}`;

  return callGemini(apiKey, prompt, 1024);
}

/**
 * APIキーの疎通確認。成功時は resolve、失敗時はエラーメッセージ付きで reject する。
 */
export async function testGeminiKey(apiKey: string): Promise<void> {
  if (!apiKey) {
    throw new Error("APIキーが入力されていません");
  }
  await callGemini(apiKey, "「OK」とだけ返してください。", 64);
}
