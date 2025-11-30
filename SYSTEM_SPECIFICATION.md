# MONTORE システム仕様書

**Version**: 4.54  
**最終更新**: 2025-11-30  
**プロジェクト名**: MONTORE (MONshin TRAining + mOnitoRE)

---

## 1. 概要

MONTOREは医療従事者（特に看護学生）向けの問診スキル訓練システムです。
OpenAI Realtime APIを活用したリアルタイム音声対話により、実践的な問診シミュレーションを提供し、
AI評価システムにより9項目のルーブリックに基づいた客観的フィードバックを行います。

---

## 2. 技術スタック

| コンポーネント | 技術 |
|---------------|------|
| Backend | Node.js 20+ / Express |
| Frontend | Vanilla JavaScript |
| Database | Cloud Firestore |
| Authentication | Firebase Authentication |
| AI (会話) | OpenAI GPT-4o Realtime API |
| AI (評価) | OpenAI GPT-4o-mini |
| Hosting | Google Cloud Run |
| CI/CD | Google Cloud Build |
| Storage | Google Cloud Storage |

---

## 3. 環境設定

### 3.1 Google Cloud / Firebase 環境

#### Firebase プロジェクト
```
プロジェクトID: montore-e35be
リージョン: asia-northeast1 (東京)
```

#### Firebase Authentication 設定
```javascript
{
  apiKey: "AIzaSyAQtV23xflspVnkJyap9OB3uPKjphfLdDw",
  authDomain: "montore-e35be.firebaseapp.com",
  projectId: "montore-e35be",
  storageBucket: "montore-e35be.firebasestorage.app",
  messagingSenderId: "327159500498",
  appId: "1:327159500498:web:f104de2e4a9d4f041f270b",
  measurementId: "G-TTK7RQRZKB"
}
```

#### Cloud Run サービス
```
サービス名: montore
リージョン: asia-northeast1
メモリ: 2Gi
CPU: 2
タイムアウト: 300秒
認証: 未認証アクセスを許可
```

#### Cloud Storage バケット
```
動画/アセット用: montore-e35be-recordings
音声録音用: RECORDINGS_BUCKET (ASSETS_BUCKET と同じ)
```

#### 環境変数一覧

| 変数名 | 説明 | デフォルト値 |
|-------|------|-------------|
| `OPENAI_API_KEY` | OpenAI APIキー | Secret Managerから取得 |
| `FIREBASE_PROJECT_ID` | Firebase認証プロジェクトID | montore-e35be |
| `FIRESTORE_PROJECT_ID` | Firestoreプロジェクトド | FIREBASE_PROJECT_IDと同じ |
| `APP_VERSION` | アプリケーションバージョン | 4.54 |
| `ASSETS_BUCKET` | 動画保管用GCSバケット名 | montore-e35be-recordings |
| `RECORDINGS_BUCKET` | 音声録音保管用GCSバケット名 | ASSETS_BUCKETと同じ |
| `FIREBASE_API_KEY` | Firebase Web API Key | AIzaSyAQtV... |
| `FIREBASE_AUTH_DOMAIN` | Firebase認証ドメイン | montore-e35be.firebaseapp.com |

#### Firestore データ構造

```
Firestore Database
├── users/                         # ユーザー情報
│   └── {uid}/
│       ├── email: string
│       ├── displayName: string
│       ├── userNo: number
│       ├── isAdmin: boolean
│       ├── remarks: string
│       └── createdAt: timestamp
│
├── sessions/                      # 学習セッション
│   └── {sessionId}/
│       ├── uid: string
│       ├── type: string           # "test" | "practice"
│       ├── cfg: object            # セッション設定
│       │   └── selectedEvalItems: string[]  # 選択された評価項目
│       ├── createdAt: timestamp
│       ├── finishedAt: timestamp
│       ├── durationSec: number
│       ├── analysis: object       # AI評価結果
│       └── messages/              # サブコレクション: 会話ログ
│           └── {messageId}/
│               ├── who: string    # "nurse" | "patient"
│               ├── text: string
│               └── t: timestamp
│
├── test_patients/                 # シナリオ患者設定
│   └── {patientId}/
│       ├── patientNo: number
│       ├── name: string
│       ├── age: string
│       ├── profile: string
│       ├── expectedVitals: object
│       ├── expectedExams: string[]
│       ├── active: boolean
│       └── isPublic: boolean
│
└── systemConfigs/                 # システム設定
    ├── rubric/                    # 評価ルーブリック設定
    │   ├── rubric: array[9]       # 9項目のルーブリック
    │   ├── updatedAt: timestamp
    │   └── updatedBy: object
    │
    └── keywords/                  # キーワード設定
        ├── vitals: object         # バイタル判定キーワード
        └── exams: object          # 身体診察判定キーワード
```

### 3.2 GitHub 環境

```
リポジトリ: https://github.com/gmhata/montore.git
ブランチ: main
ローカルディレクトリ: /home/user/montore (または ~/montore)
```

#### デプロイコマンド
```bash
cd ~/montore && git pull origin main && \
gcloud run deploy montore \
  --source=. \
  --region=asia-northeast1 \
  --project=montore-e35be \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --timeout=300 \
  --set-env-vars="FIREBASE_PROJECT_ID=montore-e35be,FIRESTORE_PROJECT_ID=montore-e35be,APP_VERSION=4.54,ASSETS_BUCKET=montore-e35be-recordings"
```

---

## 4. AI評価システム

### 4.1 システムプロンプト（評価用）

評価処理は `/api/sessions/:id/finish` エンドポイントで実行されます。
システムプロンプトは動的に生成され、以下の構造を持ちます。

#### システムプロンプト全文テンプレート

```
あなたは看護教育の採点官です。会話ログ（看護師/患者）を読み、
下の9項目で 0/1/2 点の三段階で評価し、短いコメントを日本語で作成してください。
必ず JSON だけを返し、余計な文章は出力しないこと。
${選択項目に応じた追加指示}

評価項目（順に配列で出力）:
1) 導入（名乗り/挨拶）
2) 主訴
3) OPQRST
4) ROS & Red Flag
5) 医療・生活歴
6) 受診契機
7) バイタル/現症
8) 身体診察
9) 進行

採点基準（各項目の詳細ルーブリック）:
${各項目の詳細採点基準 - 下記「ルーブリック」セクション参照}

summary（総評）の作成ルール（厳守）:
- 日本語の「です・ます調」。2〜3文、合計180〜250文字に収める。
- 会話ログの事実に基づく具体的な観察を少なくとも3点含める
  （例:「氏名確認なし」「OPQRSTの"増悪/寛解"未確認」「胸痛の随伴症状を未質問」等）
- あいまい語の禁止（例:「全体的に」「だいたい」「不十分」「もっと」「気をつけたい」など）
- 新しい事実の創作は禁止。必要に応じて看護師/患者の発言を短く「」で引用してよい。
- 批判は簡潔にし、最後は次回に向けた励ましの1文で締める。
${選択項目に応じた追加ルール}

positives（良かった点）の作成ルール【必須で3件以上出力すること】:
- 必ず3〜5件出力する（0件は禁止）。各要素は文頭を動詞で始める短い指示文にする。
- 1要素は45文字以内。具体的な観察や手技名を含める。
- 【重要】良かった点は、評価対象・対象外に関わらず、会話全体から良い点を見つけて全て褒めてください。
- 例:「氏名と年齢を確認した」「患者の訴えを傾聴した」「丁寧な言葉遣いで対応した」

improvements（改善が必要な点）の作成ルール【必須で3件以上出力すること】:
- 必ず3〜5件出力する（0件は禁止）。各要素は文頭を動詞で始める短い指示文にする。
- 1要素は45文字以内。具体的な観察や手技名を含める。
- 例:「OPQRSTの時間経過を尋ねる」「Red Flagを確認する」「既往歴を聴取する」
${選択項目に応じた改善点ルール}

出力 JSON 形式:
{
  "report": {
    "rubric": [
      {"name":"導入","score":0,"comment":"..."},
      {"name":"主訴","score":0,"comment":"..."},
      {"name":"OPQRST","score":0,"comment":"..."},
      {"name":"ROS","score":0,"comment":"..."},
      {"name":"医療・生活歴","score":0,"comment":"..."},
      {"name":"受診契機","score":0,"comment":"..."},
      {"name":"バイタル/現症","score":0,"comment":"..."},
      {"name":"身体診察","score":0,"comment":"..."},
      {"name":"進行","score":0,"comment":"..."}
    ],
    "summary":"（180〜250文字、具体的観察3点以上、最後は励ましで締める）",
    "positives":["...","...","..."],
    "improvements":["...","...","..."]
  }
}
```

#### 用途
- 看護学生の問診シミュレーション会話を客観的に評価
- 9項目のルーブリックに基づいた採点
- 具体的なフィードバック（良かった点・改善点）の生成
- 総評の自動生成

### 4.2 ユーザープロンプト（評価用）

```
会話ログ:
看護師: [発話内容]
患者: [発話内容]
看護師: [発話内容]
...

上記の厳密な形式とルールで JSON のみ返してください。
```

#### 用途
- 会話ログをシステムプロンプトの指示に従って評価するための入力データ
- 会話は「看護師」と「患者」のラベル付きで時系列順に整形

### 4.3 使用モデル
- **評価処理**: `gpt-4o-mini`
- **レスポンス形式**: JSON

---

## 5. 評価ルーブリック（9項目）

### 5.1 ルーブリック一覧

各項目は 0/1/2 点の3段階で評価されます。合計18点満点を100点換算で表示します。

#### 1) 導入（名乗り/挨拶）
| 点数 | 基準 |
|------|------|
| 2点 | 氏名を名乗り、役割を伝え、患者の氏名・年齢を確認した |
| 1点 | 挨拶または氏名確認のいずれか一方のみ実施 |
| 0点 | 導入なし、または挨拶・氏名確認ともに未実施 |

**補足**: 「お名前」「名前」「氏名」はすべて同じ意味として扱う。「お名前を教えてください」「お名前は？」等の質問で患者が名前を答えた場合は、氏名確認ができたと判定する。

#### 2) 主訴
| 点数 | 基準 |
|------|------|
| 2点 | 「今日はどうされましたか」等の開放質問で主訴を聴取し、内容を復唱または確認した |
| 1点 | 主訴を聴取したが、確認・復唱なし、または閉鎖質問のみ |
| 0点 | 主訴の聴取なし |

#### 3) OPQRST
| 点数 | 基準 |
|------|------|
| 2点 | OPQRST（発症時期・増悪/寛解因子・性状・放散痛・程度・時間経過）のうち5項目以上を聴取 |
| 1点 | OPQRSTのうち2〜4項目を聴取 |
| 0点 | OPQRST項目の聴取が1項目以下 |

**OPQRST解説**:
- **O**nset: 発症時期
- **P**alliative/Provoking: 増悪/寛解因子
- **Q**uality: 性状
- **R**adiation: 放散痛
- **S**everity: 程度
- **T**iming: 時間経過

#### 4) ROS & Red Flag
| 点数 | 基準 |
|------|------|
| 2点 | 随伴症状を複数聴取し、重篤な疾患の危険信号（呼吸困難・意識障害・胸痛放散等）を確認 |
| 1点 | 随伴症状の聴取はあるが、Red Flagの確認が不十分 |
| 0点 | 随伴症状・Red Flagともに未確認 |

#### 5) 医療・生活歴
| 点数 | 基準 |
|------|------|
| 2点 | 既往歴・内服薬・アレルギー歴・喫煙/飲酒歴のうち3項目以上を聴取 |
| 1点 | 上記のうち1〜2項目を聴取 |
| 0点 | 医療歴・生活歴の聴取なし |

#### 6) 受診契機
| 点数 | 基準 |
|------|------|
| 2点 | 「なぜ今日受診されたのですか」等で受診理由・きっかけを明確に聴取 |
| 1点 | 受診契機に触れたが、詳細な確認なし |
| 0点 | 受診契機の聴取なし |

#### 7) バイタル/現症 【システム自動判定】
| 点数 | 基準 |
|------|------|
| 2点 | システム上で「実施する」を選択して測定を行った |
| 1点 | （この項目は1点評価なし） |
| 0点 | システム上で「実施する」を選択していない |

**重要**: この項目は会話内容ではなく、システムの操作記録で自動判定されます。会話でバイタル測定に言及していても、システム上で「実施する」を選択していなければ未実施と判定されます。

#### 8) 身体診察 【システム自動判定】
| 点数 | 基準 |
|------|------|
| 2点 | システム上で「実施する」を選択して診察を行った |
| 1点 | （この項目は1点評価なし） |
| 0点 | システム上で「実施する」を選択していない |

**重要**: この項目は会話内容ではなく、システムの操作記録で自動判定されます。会話で身体診察に言及していても、システム上で「実施する」を選択していなければ未実施と判定されます。

#### 9) 進行
| 点数 | 基準 |
|------|------|
| 2点 | 論理的な順序で情報収集し、患者の訴えに応じて柔軟に質問を展開 |
| 1点 | 情報収集の順序に一部不自然さがある、または硬直的な質問 |
| 0点 | 情報収集の流れが不適切、または極端に短時間で終了 |

### 5.2 ルーブリック管理機能（v4.51〜）

管理者は管理画面から各ルーブリック項目の採点基準を編集できます。

#### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/admin/rubric/config` | 現在のルーブリック設定を取得 |
| POST | `/api/admin/rubric/config` | ルーブリック設定を保存 |
| DELETE | `/api/admin/rubric/config` | デフォルト設定にリセット |

#### 保存形式（Firestore）
```
Collection: systemConfigs
Document: rubric
Fields:
  rubric: [
    {
      id: "intro",
      name: "導入（名乗り/挨拶）",
      criteria: {
        score2: "...",
        score1: "...",
        score0: "..."
      },
      note: "補足説明",
      systemControlled: false  // true の場合は編集不可
    },
    // ... 9項目
  ],
  updatedAt: timestamp,
  updatedBy: { uid, email }
```

#### ファイルエクスポート/インポート機能（v4.52）
- **エクスポート**: JSON形式でダウンロード（`rubric_config_YYYY-MM-DD_HHMM.json`）
- **インポート**: JSONファイルを読み込み、画面に反映（保存は別途必要）

### 5.3 得点計算

```
各項目: 0〜2点
合計: 最大18点
100点換算: (合計点 / 18) × 100
```

---

## 6. 主要API一覧

### 6.1 認証・ユーザー管理

| メソッド | パス | 説明 | 認証 |
|---------|------|------|------|
| GET | `/api/me` | 現在のユーザー情報取得 | 必須 |
| GET | `/api/admin/users` | ユーザー一覧取得 | 管理者のみ |
| POST | `/api/admin/users/create` | 新規ユーザー作成 | 管理者のみ |
| PATCH | `/api/admin/users/:uid` | ユーザー情報更新 | 管理者のみ |
| DELETE | `/api/admin/users/:uid` | ユーザー削除 | 管理者のみ |

### 6.2 セッション管理

| メソッド | パス | 説明 | 認証 |
|---------|------|------|------|
| POST | `/api/sessions/start` | セッション開始 | 必須 |
| POST | `/api/sessions/:id/log` | 会話ログ保存 | 必須 |
| POST | `/api/sessions/:id/finish` | セッション終了・評価実行 | 必須 |
| GET | `/api/sessions/:id` | セッション詳細取得 | 必須 |
| GET | `/api/users/:uid/sessions` | ユーザーのセッション一覧 | 必須 |

### 6.3 患者設定

| メソッド | パス | 説明 | 認証 |
|---------|------|------|------|
| GET | `/api/admin/test-patients` | 患者一覧（管理者用） | 管理者のみ |
| GET | `/api/test-patients` | 患者一覧（受講者用） | 必須 |
| POST | `/api/admin/test-patients` | 患者作成 | 管理者のみ |
| PUT | `/api/admin/test-patients/:id` | 患者更新 | 管理者のみ |
| DELETE | `/api/admin/test-patients/:id` | 患者削除 | 管理者のみ |

### 6.4 システム設定

| メソッド | パス | 説明 | 認証 |
|---------|------|------|------|
| GET | `/api/admin/rubric/config` | ルーブリック設定取得 | 管理者のみ |
| POST | `/api/admin/rubric/config` | ルーブリック設定保存 | 管理者のみ |
| DELETE | `/api/admin/rubric/config` | ルーブリックをデフォルトにリセット | 管理者のみ |
| GET | `/api/admin/keywords/config` | キーワード設定取得 | 管理者のみ |
| POST | `/api/admin/keywords/config` | キーワード設定保存 | 管理者のみ |

### 6.5 OpenAI連携

| メソッド | パス | 説明 | 認証 |
|---------|------|------|------|
| POST | `/api/realtime-ephemeral-key` | Realtime API用一時キー取得 | 必須 |

---

## 7. 管理者権限

### 7.1 自動管理者判定

以下のメールアドレスは自動的に管理者権限が付与されます：
- `gmhata@gmail.com`

### 7.2 管理者登録方法

1. **管理画面から登録**（推奨）
   - 管理画面 → ユーザー管理 → 新規ユーザー登録
   - メールアドレス、名前、役割（管理者/一般）を入力

2. **Firestore直接編集**
   - `users/{uid}` ドキュメントの `isAdmin` フィールドを `true` に設定

---

## 8. バージョン履歴（抜粋）

| バージョン | 主な変更 |
|-----------|---------|
| v4.54 | 管理画面からユーザー新規登録機能を追加 |
| v4.53 | ROS & Red Flagの評価項目選択が正しく反映されない問題を修正 |
| v4.52 | ルーブリック管理に空白チェックとファイル保存/読込機能を追加 |
| v4.51 | 評価ルーブリック管理機能を追加 |
| v4.50 | キーワード管理画面の設定を完全反映 |
| v4.31 | バイタル・身体診察の実施項目を評価コメントに表示 |
| v4.28 | 選択評価項目に応じた動的プロンプト生成 |
| v4.25 | 評価項目の選択機能を追加 |
| v4.00 | Ver3.57から独立、MONTORE新規プロジェクト開始 |

---

## 9. 運用ガイド

### 9.1 ルーブリック設定の反映タイミング

- 管理画面で保存したルーブリック設定は**即時**Firestoreに保存されます
- 評価実行時（`/api/sessions/:id/finish`）に最新の設定が読み込まれます
- **ログアウトやリロードは不要**です

### 9.2 注意事項

1. **バイタル/現症・身体診察**はシステム自動判定のため、ルーブリック編集不可
2. ルーブリック項目は必ず9項目維持（増減不可）
3. 空白の採点基準は保存時にエラーになります

### 9.3 バックアップ推奨

定期的に「ファイルに保存」機能でルーブリック設定をエクスポートしてください。
復元が必要な場合は「ファイルから読込」で読み込み、「ルーブリックを保存」で適用します。

---

## 10. セキュリティ

### 10.1 認証フロー

1. Firebase Authentication によるログイン（Google認証またはメール/パスワード）
2. IDトークン取得
3. サーバー側でIDトークン検証
4. 管理者権限は `isAdmin` フィールドまたは `isAdminEmail()` で判定

### 10.2 API認証

- すべてのAPIは `Authorization: Bearer {IDトークン}` ヘッダー必須
- 管理者専用APIは追加で `requireAdmin` ミドルウェアで権限チェック

### 10.3 環境変数のセキュリティ

- `OPENAI_API_KEY` は Google Cloud Secret Manager で管理
- Firebase設定はサーバー側で動的生成（`/firebase-config.js`）

---

**作成者**: AI System  
**最終確認**: 2025-11-30
