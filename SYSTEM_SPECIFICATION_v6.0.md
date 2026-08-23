# 問診トレーニングシステム「モントレ」/ PeerMontore — v6.0 システム仕様書

- 版数: **v6.0**（2026-08-23 本番リリース）
- 内部ビルド識別子: `2026-08-23-m`（peer-room.html の `const BUILD`。コンソールに `PeerMontore build: 2026-08-23-m`）
- 詳細な AI プロンプト・評価ルーブリックは既存の [SYSTEM_SPECIFICATION.md] / [TECHNICAL_SPECIFICATION_v3.57.md] を参照。本書は v6.0 時点の全体像と、v4.70→6.0 で追加された「ピア練習（PeerMontore）」機能を中心にまとめる。

---

## 1. 概要

「モントレ」は看護学生向けの問診（医療面接）トレーニングシステム。AI 患者との音声対話練習を中核に、評価・学修履歴・AI コーチを備える。v6.0 では、学生 2 人が看護師役・患者役に分かれて相互に練習する **ピア練習（PeerMontore）** を正式機能として搭載した。

- 提供者: 大学教員（デモ・オープンキャンパス／授業運用）
- 会話言語: 日本語
- 運用規模の想定: 学生 20 名程度が各自の PC で並行利用
- コスト方針: 原則ゼロコスト（無料枠内）。ブラウザ内処理を優先。

## 2. システム構成

- 基盤: **GCP プロジェクト montore-e35be**、Cloud Run サービス `montore`（リージョン asia-northeast1、自動スケール 最小0/最大20）
- リポジトリ: **GitHub gmhata/montore**（ブランチ: `main`＝本番、`test`＝検証）
- サーバー: **Node.js / Express**（`server.js`）。静的配信は `express.static(public)`＋SPA フォールバック（`/api/`・`/health` 以外は index.html）
- 認証: **Firebase Authentication**（Google アカウントログイン）。データは **Firestore**
- リアルタイム通話: **LiveKit Cloud**（WebRTC。開発中のつなぎ。将来 P2P へ移行方針）
- 生成 AI: **OpenAI API**（Realtime＝音声対話、GPT-4o / GPT-4o-mini＝評価・生成・分析）
- ストレージ: **Cloud Storage**（`montore-recordings`。録音保管用。録音実装は当面見送り）
- URL: 本番 https://montore-327159500498.asia-northeast1.run.app ／ 検証 https://montore-test-327159500498.asia-northeast1.run.app

## 3. 機能一覧（トップメニュー）

v6.0 のトップメニュー並び順（`index.html`）:

1. **問診練習** — 患者を選択して AI と音声で対話練習
2. **ピア練習（試験）** — 2 人で問診の役割練習（看護師役・患者役）★v6 で 2 番目に昇格
3. **学修履歴** — 過去の練習・評価記録の確認
4. **AI コーチ** — AI による強み/弱み分析・アドバイス
5. **マニュアル** — 用語定義と使い方ガイド
6. **管理者**（管理者のみ表示・既定は非表示）

## 4. 問診練習（AI 患者対話）

- **リアルタイム音声対話**: OpenAI **Realtime API（GA 仕様）** を使用。
  - モデル: **`gpt-realtime`**（バージョン無し指定＝常に最新 GA スナップショット）
  - ephemeral key を `POST https://api.openai.com/v1/realtime/client_secrets` で発行 → クライアントは `POST /v1/realtime/calls`（GA の WebRTC）で接続。`session.update` は GA のネスト構造（`type:"realtime"`, `audio.{input,output}`）
  - v4.64 で Web Speech API を廃し Realtime のみで看護師音声を文字起こし、v4.65 で GA 仕様へ移行
- **患者シミュレーション**: 患者プロフィール（基本情報・現病歴・言語設定＝カタコト等）に基づく AI ペルソナ。管理者/学生が患者を作成・自動生成可。
- **評価（ルーブリック）**: 9 項目のルーブリックでスコアリング、総評・改善点を生成。評価を実行しないと学修履歴に記録されない。
- **バイタルサイン・身体診察判定**、**AI コーチ分析**（GPT-4o-mini）等。詳細は既存の詳細仕様書を参照。

## 5. ピア練習（PeerMontore）★v6.0 の中核追加

### 5.1 コンセプト
学生 2 人がペアになり、**看護師役（人間・実写＋実声）** と **患者役（アバター＋声変換）** に分かれて問診を相互練習する。役割はソフト上で自由に選択・交代できる。仮想マイク/カメラは不要。

### 5.2 導線・ルーム運用
- ロビー `peer.html`: ルーム 1〜10（`renshu1..10`）から選択。各ルームの**在室者（名前・役割）を表示**、満室（2 人）は選べない。`/api/peer/rooms` を 4 秒ポーリング。
- 「練習画面へ進む」→ 統合練習画面 `peer-room.html?room=renshuN`。画面内で役割（看護師役／患者役）を選び入室。「役割を交代」で同一ルームのまま逆役へ再入室、「退室」でロビーへ。
- **在室同期**: `POST /api/peer/heartbeat`（role: `patient`/`nurse`/`waiting`、TTL 15 秒、Firestore `peerPresence`）、`/api/peer/leave`、`GET /api/peer/rooms`（自分自身は一覧から除外）。役割選択前は `waiting` を送り「入室準備中」と相手名を表示。
- **表示名**: `peerDisplayName(u)= u.name || メールの@前 || uid先頭`。相手名の確認は 2 アカウントで（同一アカウントは自分除外で相手欄に出ない）。

### 5.3 役割ごとの入出力
- **看護師役**: 実写カメラ映像＋マイク音声を配信（LiveKit）。カメラ選択可（入室前に許可を取り実カメラ一覧を生成）。
- **患者役**: アバターを描画した canvas を `captureStream()` で患者映像として配信し、**声は変換音声**を配信。UE／画面共有は不要。

### 5.4 患者役アバター（顔＋腕＋指トラッキング）
- 認識: **MediaPipe Tasks Vision @0.10.14** — FaceLandmarker（ARKit 52 blendshape の表情）、PoseLandmarker（腕）、HandLandmarker（指）。
- 描画: **Three.js @0.160**。アバターは RPM/Wolf3D 系 GLB（`avatar-f-brunette.glb`）と **VRoid の VRM1.0** の両対応。
- 平滑化・安定化:
  - 腕: One Euro フィルタ＋時間ベース slerp。前腕（ひじ）は毎フレーム「実際の上腕の現在ワールド姿勢」基準で目標化（追従中の破綻を解消）。
  - 指: 未検出側は自然な開き（レスト）へ復帰。3 モデル同時実行を約 22fps に間引き。
  - **全画面でも停止しない**: 認識入力を `<video>` ではなく **MediaStreamTrackProcessor**（トラック直接フレーム取得）にし、認識・描画・送信をフレーム駆動。送信は `captureStream(0)` + `requestFrame()`。
- 画角: 顔優先（頭〜上胸）。手は胸〜顔の高さに上げたときだけ映る。顔向き yaw は既定 +1（反転しない）。

### 5.5 6 種キャラクター（声＝キャラ セット切替）
- 「患者の声（ペルソナ）」選択を**キャラクター選択**として使い、選ぶと**声とアバターがセットで切り替わる**（通話中もライブ切替）。
- 6 種（persona キー）: **kd=高齢男性 / cd=中年男性 / jd=若年男性 / kj=高齢女性 / cj=中年女性 / jj=若年女性**。
- **フォーマット非依存ロード**: `avatarCandidates(persona)` が `/avatar-<種別>.glb` → `/avatar-<種別>.vrm` → 既定（`avatar-f-brunette.glb`）の順に自動ロード。GLB と VRM を混在可。
- VRM パイプライン: `@pixiv/three-vrm@3`。humanoid ボーン（腕/指/head/hips）を取得、ARKit→VRM 表情マッピング（blink/blinkLeft/blinkRight←eyeBlink、aa←jawOpen、happy←mouthSmile、ou←mouthPucker）、毎フレーム `vrm.update(dt)`。VRM1.0 は無回転で正面。
- 配置ファイル: `public/avatar-{kd,cd,jd,kj,cj,jj}.vrm`（v6.0 時点は VRoid サンプルの仮アバター。年齢別の正式キャラに差し替え予定）。

### 5.6 声変換
- `public/peer-voice.js`（`VoiceConverter` / `PERSONAS`）。2 段 AudioWorklet（ピッチシフト＋ STFT フォルマントシフト、2 スライダー）。ペルソナ既定値 `PERSONAS`（kd/cd/jd/kj/cj/jj）。無料のブラウザ内 DSP（精度は後回し方針）。

### 5.7 アバター最適化（GitHub 収録のための軽量化）
VRoid の VRM は 1 体 16〜18MB（テクスチャ約 8.5MB＋形状/表情モーフ約 7.5MB）。GitHub 収録・配信のため **各約 5MB（6 体合計約 30MB）** に圧縮（GLB を直接手術し VRM 拡張を保持）:
1. テクスチャ縮小（顔 ≤1024・その他 ≤512・描画不要の VRM Thumbnail ≤128）
2. 未使用の表情モーフ削除（Face の 57 モーフ中、VRM 表情が参照する 14 種のみ残し、`morphTargetBinds` の index を再マップ、未参照 bufferView を GC）
3. 表情・ボーン・指をレンダー検証（破綻なし・顔鮮明）

### 5.8 UE 版（先生デモ用）
写真級の MetaHuman を用いる UE 版（`peer-patient.html`＋ランチャー）。GPU 必須のため教員のデモ用として維持。UE 版リンクは管理者のみ表示。学生全 PC 用は Web 版（本仕様書 5.4〜5.7）が推奨。

## 6. 主要 API（抜粋）

- 認証・ユーザー管理、セッション管理、患者設定、システム設定、OpenAI 連携（評価・生成・分析）: 既存の詳細仕様書 §6 を参照。
- ピア練習: `POST /api/peer/heartbeat`、`POST /api/peer/leave`、`GET /api/peer/rooms`（いずれも要認証）。
- Realtime ephemeral key 発行（サーバー側で `gpt-realtime` を使用）。
- `/version`（APP_VERSION を JSON で返す。画面右下のバージョンバッジとは非連動）。

## 7. バージョン管理

- 画面右下の **バージョンバッジは `index.html` にハードコード**（v6.0 = `version: 6.0`、2 箇所）。`/version` の APP_VERSION 環境変数とは独立。
- `package.json` の version（6.0.0）、本番 `cloudbuild.yaml` の `APP_VERSION=6.0` も 6.0 に統一。
- 補足: 「5.20」は gcloud 手動デプロイ時のバージョンラベルで、コードは 4.70 系＋Realtime GA（音声会話の更新は v4.64/4.65 として既に main に収録済み）。5.x のコミットは git に存在しない。

## 8. デプロイ

### 8.1 検証（test）— 自動
- `test` ブランチへ push → Cloud Build トリガー `deploy-montore-test` → Cloud Run `montore-test` に自動デプロイ。
- 手順: 変更ファイルを明示指定して `git add <files>` → `git commit` → `git push origin test`（**`git add -A` は使わない**。マウントの改行差で無関係ファイルが M 誤検出されるため）。反映後 `Ctrl+Shift+R`、コンソールで build 識別子を確認。

### 8.2 本番（production）— 手動 ★重要
- **`git push origin main` では本番は反映されない**（本番用の main トリガーは無い）。本番 Cloud Run `montore` は **gcloud で手動デプロイ**する運用。
- 手順（Cloud Shell もしくはローカルの Google Cloud SDK Shell。通常の PowerShell は gcloud が PATH に無く不可）:
  ```
  cd ~/montore                 # 無ければ git clone https://github.com/gmhata/montore.git
  git fetch origin && git checkout main && git reset --hard origin/main
  ls -la public/avatar-*.vrm   # 6 体（各 4〜6MB）確認
  gcloud builds submit --config=cloudbuild.yaml --substitutions=_ASSETS_BUCKET=montore-recordings .
  ```
- 要点:
  - `cloudbuild.yaml` は `${_ASSETS_BUCKET}` 置換変数を使うため **`--substitutions=_ASSETS_BUCKET=montore-recordings` が必須**（値は録音バケット名）。無いと `_ASSETS_BUCKET is not matched` で停止。
  - Cloud Shell の既存クローンが古いと古いコードでビルドされる → `git reset --hard origin/main` で最新化。
  - 前段として `git checkout main; git merge test; git push origin main`（履歴を GitHub へ）を済ませてから本番デプロイする。
- `cloudbuild.yaml` は Docker イメージ（`gcr.io/$PROJECT_ID/montore:v4.00` タグ。内部ラベルで表示バージョンには無関係）をビルド → Cloud Run にデプロイ。環境変数 `APP_VERSION=6.0`、シークレット `OPENAI_API_KEY` / `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`（すべて Secret Manager `:latest`、同プロジェクトに存在）を設定。
  - ※本番に LiveKit シークレットが無いとピア練習の通話が繋がらないため v6.0 で追加済み。

## 9. 主要ファイル

- `server.js` — Express サーバー。Realtime ephemeral、評価/生成/分析、ピア在室 API。
- `public/index.html` — トップ（メニュー・バージョンバッジ）。
- `public/peer.html` — ピア練習ロビー（ルーム選択・在室表示）。
- `public/peer-room.html` — 統合練習画面（アバター＋声変換＋カメラ＋ハートビート、build 識別子）。
- `public/peer-voice.js` — 声変換モジュール（VoiceConverter / PERSONAS）。
- `public/practice.js` — 問診練習（Realtime 対話・評価）。
- `public/admin.js` — 管理者機能。
- `public/avatar-{kd,cd,jd,kj,cj,jj}.vrm` — 6 種キャラ（VRM）。`avatar-f-brunette.glb` — 既定フォールバック（RPM 系 GLB）。
- `cloudbuild.yaml`（本番）/ `cloudbuild-test.yaml`（検証）/ `cloudbuild-dev.yaml`。
- 既存詳細仕様: `SYSTEM_SPECIFICATION.md`、`TECHNICAL_SPECIFICATION_v3.57.md`。

## 10. 技術スタック（要約）

Node.js / Express、Firebase Auth＋Firestore、LiveKit Cloud（WebRTC）、OpenAI（Realtime `gpt-realtime` / GPT-4o・4o-mini）、MediaPipe Tasks Vision 0.10.14、Three.js 0.160＋@pixiv/three-vrm 3、AudioWorklet（声変換）、Cloud Run / Cloud Build / Cloud Storage。

## 11. 既知の継続課題

- ピア練習の 6 枠は仮アバター（VRoid サンプル）。年齢別の正式キャラに差し替え予定（必要なら下半身クロップで更に軽量化可）。
- 単眼ゆえの腕の奥行き精度、親指の自然さ。
- 声変換の精度（無料 DSP の限界。将来はローカル/クラウド AI 案）。
- 通話基盤の P2P 移行、録画（MediaRecorder→GCS）の実装。
- 検証環境（Cloud Run montore-test）の削除はコスト観点で本番安定後に。GitHub の test ブランチは残す。

---
*本仕様書は v6.0 時点の要約。AI プロンプト全文・評価ルーブリック 9 項目の詳細・患者パラメータ等は `SYSTEM_SPECIFICATION.md` / `TECHNICAL_SPECIFICATION_v3.57.md` を参照。*
