# Voxtro 🎙️ — 完全無料 日本語音声入力アプリ

Whisper.cpp (ローカル推論) + Gemini BYOK で動く、開発者コスト $0 の日本語音声入力ツール。

## インストール

### ダウンロード

[GitHub Releases](https://github.com/avakero/voxtro/releases/latest) から最新版をダウンロード:

| OS | ファイル | 備考 |
|------|----------|------|
| **Windows** | `Voxtro_x.x.x_x64-setup.exe` | NSIS インストーラー |
| **macOS (Intel)** | `Voxtro_x.x.x_x64.dmg` | x86_64 |
| **macOS (Apple Silicon)** | `Voxtro_x.x.x_aarch64.dmg` | M1/M2/M3 |

### Windows

1. `Voxtro_x.x.x_x64-setup.exe` をダウンロードして実行
2. SmartScreen 警告が表示される場合: **「詳細情報」→「実行」** をクリック
3. インストーラーの指示に従ってインストール

### macOS

1. `.dmg` ファイルを開き、`Voxtro.app` を `Applications` にドラッグ
2. 初回起動時に Gatekeeper 警告が出る場合、ターミナルで以下を実行:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Voxtro.app
   ```

## 初回セットアップ

1. アプリを起動すると、初回はセットアップ画面が自動で開きます
2. **「まとめてダウンロード」** で音声エンジン (whisper-cli) と Whisper モデルを取得
   - `small` (466 MB): 日本語で十分な精度
   - `medium` (1.5 GB): より高精度
   - `large` (2.9 GB): 最高精度（GPU推奨）
3. (任意) [Google AI Studio](https://aistudio.google.com/app/apikey) で Gemini API キーを取得し設定
4. **Ctrl+Shift+K** で録音開始 → もう一度押して停止 → 自動ペースト

## 機能

- **グローバルショートカット** (デフォルト: Ctrl+Shift+K) で録音開始/停止
- **Whisper.cpp** でオフライン日本語文字起こし
- **Gemini API** (任意) でフィラーワード除去・句読点整形
- 整形後テキストを **アクティブウィンドウに自動ペースト**
- システムトレイ常駐
- **自動更新** — 新バージョンの通知・インストールを自動で行います

## 開発者向け

### 必要なもの

#### ビルド時
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- **CMake 3.14+** (whisper-rs のビルドに必要)
  - Windows: `winget install cmake` または Visual Studio Installer
  - macOS: `brew install cmake`
- Windows: Visual Studio Build Tools (MSVC)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

#### 実行時
- Whisper モデル (設定画面からダウンロード)

### セットアップ

```bash
# 依存関係インストール
npm install

# 開発サーバー起動
npm run tauri dev
```

### ビルド

```bash
npm run tauri build
```

### リリース手順

1. `tauri.conf.json` と `package.json` のバージョンを更新
2. タグを付けてプッシュ:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. GitHub Actions が自動でビルド → GitHub Releases にドラフトが作成されます
4. ドラフトの内容を確認して公開

### 自動更新の署名キー設定

初回のみ、署名キーペアの生成と設定が必要です:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/voxtro.key
```

生成された **公開鍵** を `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に設定し、**秘密鍵** を GitHub Secrets に登録:

- `TAURI_SIGNING_PRIVATE_KEY`: 秘密鍵の内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 秘密鍵のパスワード

## コスト

| 項目 | コスト |
|------|-------|
| 音声認識 (Whisper.cpp) | $0 — ローカル処理 |
| AI 整形 (Gemini) | $0 — ユーザー自身の API キー |
| 配布 (GitHub Releases) | $0 — 無料枠 |

## アーキテクチャ

```
Ctrl+Shift+K 押下
  └─ Rust: cpal で録音開始
Ctrl+Shift+K 再押下
  └─ Rust: 録音停止 → WAV 保存 → whisper-rs で推論
     └─ Tauri Event: transcription-complete (生テキスト)
        └─ フロントエンド:
           ├─ Gemini API キーあり → 整形 → paste_text コマンド
           └─ Gemini API キーなし → そのまま → paste_text コマンド
              └─ Rust: arboard でクリップボード → enigo で Ctrl+V
```

## プライバシー

音声データはすべてローカルで処理され、外部に送信されることはありません。Gemini API（オプション）を有効にした場合のみ、文字起こしテキストが Google に送信されます。

詳細は [PRIVACY.md](PRIVACY.md) をご覧ください。

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) をご覧ください。

サードパーティライブラリのライセンスは [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) をご覧ください。
