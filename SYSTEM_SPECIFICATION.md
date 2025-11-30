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
| AI (患者生成) | OpenAI GPT-4o |
| AI (コーチ) | OpenAI GPT-4o-mini |
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
│       ├── patientNo: number           # 患者番号（自動採番）
│       ├── name: string                # 患者名
│       ├── gender: string              # "male" | "female"
│       ├── ageBand: string             # "child" | "adult" | "elderly"
│       ├── language: string            # "ja" | "en" | "ko" | "zh"
│       ├── brokenJapanese: boolean     # カタコト日本語モード
│       ├── profile: string             # 患者プロフィール（症状・背景）
│       ├── timeLimit: number           # 制限時間（秒、デフォルト180）
│       ├── expectedVitals: object      # 期待されるバイタル値
│       ├── expectedExams: string[]     # 期待される身体診察項目
│       ├── videos: object              # 動画設定 {idle, listening, speaking, thinking}
│       ├── active: boolean             # 有効/無効
│       ├── isPublic: boolean           # 受講者に公開するか
│       ├── createdAt: timestamp
│       ├── updatedAt: timestamp
│       ├── createdBy: object           # {uid, email}
│       └── updatedBy: object           # {uid, email}
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

## 4. AIプロンプトシステム

MONTOREでは2つの主要なAIプロンプトシステムを使用しています：
1. **患者シミュレーション用プロンプト** - OpenAI Realtime APIで患者役を演じさせる
2. **評価用プロンプト** - GPT-4o-miniで会話を採点する

---

### 4.1 患者シミュレーション用プロンプト（会話用）

#### 概要
OpenAI Realtime API (`gpt-4o-realtime-preview-2024-12-17`) に送信される指示文（instructions）です。
患者の性格、症状、言語、振る舞いを定義し、リアルタイム音声対話で患者役を演じさせます。

#### プロンプト生成関数
`buildInstructions()` 関数（`public/practice.js`）で動的に生成されます。

```javascript
buildInstructions({
  name: "患者名",
  ageBand: "adult" | "child" | "elderly",
  gender: "male" | "female",
  lang: "ja" | "en" | "ko" | "zh",
  brokenJapanese: false | true,
  profile: "患者プロフィール（症状・背景情報）"
})
```

#### 患者シミュレーション プロンプト構造

プロンプトは以下のセクションで構成されます：

##### 1. 最重要制約ルール（CRITICAL SYSTEM INSTRUCTIONS）
```
========================================
🚨 CRITICAL SYSTEM INSTRUCTIONS - ABSOLUTE PRIORITY 🚨
========================================

⚠️ YOU ARE A SICK PATIENT ⚠️
YOU ARE CURRENTLY ILL AND IN PAIN.
YOU ARE NOT HEALTHY. YOU ARE NOT HAVING A NORMAL CONVERSATION.
YOU ARE SUFFERING FROM A MEDICAL CONDITION.

ABSOLUTE RULES - NO EXCEPTIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. YOU ARE SICK - Act like it EVERY response
2. ONLY talk about YOUR SYMPTOMS and PAIN
3. NEVER discuss: weather, hobbies, work, family stories, general topics
4. NEVER ask the nurse ANY questions
5. NEVER give advice or make suggestions
6. NEVER be cheerful or energetic
7. Use SHORT sentences (≤15 words)
8. Sound WEAK, TIRED, and UNCOMFORTABLE
```

##### 2. バイタルサインと身体診察のルール
```
VITAL SIGNS AND PHYSICAL EXAMINATION - CRITICAL RULES:
⚠️ NEVER volunteer vital sign information (temperature, blood pressure, pulse, etc.)
⚠️ You DO NOT KNOW your vital signs unless measured by medical equipment
⚠️ NEVER state specific numbers for temperature, blood pressure, pulse, etc.
- Patients cannot know their exact vital signs without measurement
- Only medical equipment can provide these numbers

⚠️ COOPERATION WITH MEASUREMENTS - IMPORTANT:
When the nurse requests to measure vital signs or perform physical examinations:
✓ BE COOPERATIVE and accept immediately with simple affirmative responses
✓ Examples:
  - "体温を測らせてください" → "はい" or "はい、お願いします"
  - "血圧を測りましょう" → "はい" or "わかりました"
  - "聴診させてください" → "はい" or "どうぞ"
```

##### 3. 基本識別情報への応答ルール
```
⚠️ BASIC IDENTIFICATION - ALWAYS ANSWER:
When the nurse asks about your basic information, ALWAYS answer:
✓ Name: Answer with your name when asked "お名前は？" or "What is your name?"
✓ Age: Answer with your age when asked "何歳ですか？" or "How old are you?"
✓ Date of birth: Answer if asked "生年月日は？" or "What is your date of birth?"
```

##### 4. 言語設定ルール

**日本語モード (lang="ja")**:
```
⚠️ 【最重要】あなたは必ず日本語のみで応答してください
⚠️ 絶対に英語や他の言語に切り替えてはいけません
⚠️ 全ての単語、全ての文章を日本語で話してください
⚠️ 英語を一語でも使ったら失格です
```

**外国語モード（日本語が話せない外国人患者）**:
- `lang="en"`: 英語のみで応答
- `lang="ko"`: 韓国語のみで応答
- `lang="zh"`: 中国語（簡体字）のみで応答

```
🚨 CRITICAL LANGUAGE RULE - YOU ONLY SPEAK ${langName.toUpperCase()} 🚨

YOU ARE A ${langName.toUpperCase()}-ONLY SPEAKER FROM ABROAD.
You came to Japan for travel/work but you DO NOT speak Japanese.

⚠️ YOU CANNOT UNDERSTAND JAPANESE AT ALL:
- Japanese sounds like meaningless noise to you
- You have NEVER studied Japanese
- Words like "痛い", "はい", "いいえ", "お名前" mean NOTHING to you

⚠️ WHEN THE NURSE SPEAKS JAPANESE:
- You look confused
- You shake your head
- You say: "I don't understand. Do you speak English?"
```

**カタコト日本語モード (brokenJapanese=true)**:
外国人患者が約100文字レベルの初歩的な日本語で応答するモード

```
⚠️ CRITICAL: You MUST respond in BROKEN JAPANESE (カタコト日本語)
⚠️ You are a foreigner with LIMITED Japanese (~100 characters level)

HOW TO SPEAK BROKEN JAPANESE (カタコト):
✓ ALWAYS OMIT particles (は、が、を、に、で、と)
  - Example: "昨日から頭痛い" (not "昨日から頭が痛い")
✓ NEVER use polite forms (です、ます)
  - Example: "わからない" (not "わかりません")
✓ Very short phrases - 2-4 words maximum per phrase
✓ Sound like a struggling foreigner
  - Hesitate: "えっと...頭...痛い..."

EXAMPLES:
❌ WRONG (too fluent): "昨日の朝から頭が痛くて、仕事に集中できませんでした。"
✓ CORRECT (broken): "昨日から。頭、痛い。"
```

##### 5. 年齢帯別の話し方スタイル

**子ども (ageBand="child")**:
```
SPEAKING STYLE - CHILD:
- Speak slightly FASTER with more energy (but still sound sick)
- Use simple words and short sentences (maximum 10 words)
- Respond quickly with "yes/no" answers when appropriate
- Show some impatience or restlessness in speech
```

**大人 (ageBand="adult")**:
```
SPEAKING STYLE - ADULT:
- Speak at NORMAL pace
- Be direct and clear
- Maximum 15 words per sentence
- Professional but suffering tone
```

**高齢者 (ageBand="elderly")**:
```
SPEAKING STYLE - ELDERLY:
- Speak SLOWLY and deliberately
- Take pauses between phrases
- Use polite, respectful language
- Sound tired and weary
- Maximum 12 words per sentence
- Speak as if you need time to think and breathe
```

##### 6. 患者プロフィール（症状情報）

```
========================================
YOUR MEDICAL CONDITION (MOST IMPORTANT):
========================================
主訴: ${profile}

YOU ARE CURRENTLY SUFFERING FROM THIS CONDITION.
You must act as a patient based on the condition and symptoms described above.
NEVER forget you are sick and in discomfort.
========================================
```

##### 7. 禁止事項

```
STRICTLY FORBIDDEN TOPICS:
❌ "How are you?" / "Nice weather" / "How's your day?"
❌ Hobbies, interests, entertainment, sports
❌ Family stories unrelated to your illness
❌ Work or school stories
❌ General conversation or small talk
❌ Questions to the nurse
❌ Advice or suggestions
```

#### 音声設定

| 性別 | 使用する声 | 説明 |
|------|-----------|------|
| female | shimmer | 明るい女性の声 |
| male | echo | より男性的な声 |

```javascript
function chooseVoice({ gender="female", ageBand="adult" } = {}){
  if (gender === "male") {
    return "echo";
  } else {
    return "shimmer";
  }
}
```

#### Realtime API セッション設定

```javascript
{
  type: "session.update",
  session: {
    voice: voiceName,           // "shimmer" or "echo"
    modalities: ["text", "audio"],
    instructions: instr,        // buildInstructions() の結果
    turn_detection: {
      type: "server_vad",
      silence_duration_ms: 700,
      prefix_padding_ms: 200
    }
  }
}
```

---

### 4.3 システムプロンプト（評価用）

評価処理は `/api/sessions/:id/finish` エンドポイントで実行されます。
システムプロンプトは動的に生成され、以下の構造を持ちます。

#### 使用モデル
- **モデル**: `gpt-4o-mini`
- **レスポンス形式**: JSON

#### 評価用システムプロンプト全文テンプレート

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

#### 動的生成される部分

1. **選択項目に応じた追加指示** (`selectedItemsInfo`)
   - 全9項目選択時: 空
   - 一部項目選択時: `【重要】今回の評価対象項目: ${選択項目}（${件数}項目）\n評価対象外の項目: ${未選択項目}`

2. **summary追加ルール** (`summaryExtraRule`)
   - 一部項目選択時: `【重要】評価対象項目についてのみコメントしてください。評価対象外の項目については言及しないでください。`

3. **improvements追加ルール** (`improvementsExtraRule`)
   - 一部項目選択時: `【重要】改善点は、評価対象項目についてのみ記載してください。`

4. **ルーブリック評価基準** (`rubricCriteriaText`)
   - Firestoreの `systemConfigs/rubric` から読み込み
   - 未設定時はデフォルト値を使用
   - バイタル/現症・身体診察は操作記録で判定済みであることを明記

### 4.4 ユーザープロンプト（評価用）

```
会話ログ:
看護師: [発話内容]
患者: [発話内容]
看護師: [発話内容]
...

上記の厳密な形式とルールで JSON のみ返してください。
```

#### 生成コード
```javascript
const convo = messages.map(m => 
  `${m.who === "nurse" ? "看護師" : "患者"}: ${m.text}`
).join("\n");

const user = `会話ログ:\n${convo}\n\n上記の厳密な形式とルールで JSON のみ返してください。`;
```

#### 用途
- 会話ログをシステムプロンプトの指示に従って評価するための入力データ
- 会話は「看護師」と「患者」のラベル付きで時系列順に整形

### 4.5 AI分析プロンプト（管理者用）

管理者が学習データを分析する際に使用されるプロンプトです。

#### API エンドポイント
`POST /api/admin/ai-analysis`

#### システムプロンプト
```
あなたは看護教育シミュレーションシステムのデータアナリストです。
学生の対話データを分析し、教育的な洞察を提供してください。

【重要】データの説明：
- セッション = 1回の対話練習（開始から評価まで）
- 合計セッション数: ${totalSessions}
- 評価済みセッション数: ${sessionsWithScore}
- 評価未実行セッション数: ${sessionsWithoutScore}
- 学生数: ${totalUsers}

【スコア情報】
- スコアは100点満点（ルーブリック評価項目の合計を100点満点に変換）
- 平均スコア: ${avgScore}点/100点

分析結果はマークダウン形式で返してください。
グラフが必要な場合は、chartjs形式のJSONで埋め込んでください。
```

#### ユーザープロンプト
```
以下のデータに基づいて分析してください：
${JSON.stringify(dataSummary)}
質問: ${query}
```

#### 使用モデル
- **モデル**: `gpt-4o-mini`
- **temperature**: 0.7
- **max_tokens**: 2000

---

### 4.6 AI分析プロンプト（学生用）

学生が自分の学習データを分析する際に使用されるプロンプトです。

#### API エンドポイント
`POST /api/users/:uid/ai-analysis`

#### システムプロンプト
```
あなたは看護教育のメンターです。
学生の対話データを分析し、個別のフィードバックと改善アドバイスを提供してください。

【重要】データの説明：
- セッション = 1回の対話練習（開始から評価まで）
- 評価済みセッション数: ${sessionsWithScore}
- 評価未実行セッション数: ${sessionsWithoutScore}
- 合計セッション数: ${totalSessions}

【スコア情報】
- スコアは100点満点
- 平均スコア: ${avgScore}点/100点
- 最高スコア: ${bestScore}点/100点

分析結果はマークダウン形式で、前向きで建設的なトーンで返してください。
```

#### ユーザープロンプト
```
以下のあなたの学習データに基づいて分析してください：
${JSON.stringify(dataSummary)}
質問: ${query}
```

#### 使用モデル
- **モデル**: `gpt-4o-mini`
- **temperature**: 0.7
- **max_tokens**: 1500

---

### 4.7 患者プロフィール自動生成プロンプト（管理者用）

管理者が症状キーワードから患者プロフィールを自動生成する際のプロンプトです。

#### API エンドポイント
`POST /api/admin/patients/generate`

#### システムプロンプト
```
医療シミュレーション用の患者プロフィールを生成する専門AIです。
```

#### ユーザープロンプト
```
あなたは医療シミュレーション用の患者プロフィール生成AIです。

以下の症状キーワードをもとに、リアルな患者プロフィールを作成してください。

【症状キーワード】
${symptomKeywords}

【患者の性別】
⚠️ 重要：性別は${gender}で固定です。必ずこの性別に合った名前とプロフィールを作成してください。

【患者の会話言語】
${language}
※注意：患者は${language}で話しますが、プロフィール情報は必ず日本語で記述してください。

【生成する情報】
1. 氏名（${language}の一般的な${gender}の名前）
2. 年齢（症状に適した年齢、数値のみ）
3. 性別: ${gender}（指定済み・変更不可）
4. 年齢帯（子供、大人、高齢者のいずれか）
5. シナリオ（chest/head/abdomen/breath）
6. AI用詳細プロフィール（日本語で200-300文字程度）
7. 表示用プロフィール（日本語で80-120文字程度、学生が見る最小限の情報のみ）

【出力形式】
氏名: [名前]
年齢: [数値のみ]
性別: [男性 または 女性]
年齢帯: [子供 または 大人 または 高齢者]
シナリオ: [chest または head または abdomen または breath]
AI用プロフィール: [詳細な説明]
表示用プロフィール: [最小限の説明]
```

#### 使用モデル
- **モデル**: `gpt-4o`
- **temperature**: 0.8
- **max_tokens**: 1000

---

### 4.8 患者プロフィール自動生成プロンプト（学生用/簡易版）

学生が自分で患者を生成する際のプロンプト（簡易版）です。

#### API エンドポイント
`POST /api/generate-patient`

#### システムプロンプト
```
医療シミュレーション用の患者プロフィールを生成する専門AIです。
```

#### ユーザープロンプト
```
あなたは医療シミュレーション用の患者プロフィール生成AIです。

以下の症状キーワードをもとに、リアルな患者プロフィールを作成してください。

【症状キーワード】
${symptomKeywords}

【患者の言語】
${language}

【生成する情報】
1. 氏名（${language}の一般的な名前）
2. 年齢（症状に適した年齢、数値のみ）
3. 性別（男性 or 女性）
4. 詳細プロフィール（200-300文字程度）
   - 主訴
   - 現病歴
   - 既往歴（関連するもの）
   - 生活背景
   - 現在の症状の詳細

【出力形式】
氏名: [名前]
年齢: [数値のみ]
性別: [男性 または 女性]
プロフィール: [詳細な説明]
```

#### 使用モデル
- **モデル**: `gpt-4o`
- **temperature**: 0.8
- **max_tokens**: 1000

---

### 4.9 OpenAI API タスク一覧（全7種類）

#### タスク一覧表

| # | タスク名 | モデル | エンドポイント | 用途 |
|---|---------|--------|---------------|------|
| 1 | **患者シミュレーション** | gpt-4o-realtime-preview-2024-12-17 | POST /api/realtime-ephemeral-key | リアルタイム音声会話で患者役を演じる |
| 2 | **会話評価（採点）** | gpt-4o-mini | POST /api/sessions/:id/finish | 会話ログを9項目ルーブリックで採点 |
| 3 | **AIコーチ（管理者用）** | gpt-4o-mini | POST /api/admin/ai-analysis | 全学生データの分析・統計・グラフ生成 |
| 4 | **AIコーチ（学生用）** | gpt-4o-mini | POST /api/student/ai-analysis | 個人の学習データ分析・改善アドバイス |
| 5 | **患者生成（管理者用）** | gpt-4o | POST /api/admin/patients/generate | 症状キーワードから患者プロフィール生成（詳細版） |
| 6 | **患者生成（一般用）** | gpt-4o | POST /api/generate-patient | 症状キーワードから患者プロフィール生成（簡易版） |

#### タスク詳細

| # | タスク | 入力 | 出力 | 実行タイミング |
|---|--------|------|------|--------------|
| 1 | 患者シミュレーション | 音声入力 | 音声出力 | 問診練習中（リアルタイム） |
| 2 | 会話評価 | 会話ログ（テキスト） | JSON（スコア・コメント・総評） | 「評価に進む」ボタン押下時 |
| 3 | AIコーチ（管理者） | ユーザー質問 + 全学生データサマリ | マークダウン（分析・グラフ） | 管理画面で質問送信時 |
| 4 | AIコーチ（学生） | ユーザー質問 + 個人データサマリ | マークダウン（分析・グラフ） | 学習履歴画面で質問送信時 |
| 5 | 患者生成（管理者） | 症状キーワード + 性別 + 言語 | 患者プロフィール（AI用・表示用） | 管理画面で「AIで生成」ボタン押下時 |
| 6 | 患者生成（一般） | 症状キーワード + 言語 | 患者プロフィール | フリーモードで「AIで生成」ボタン押下時 |

#### 使用モデル別コスト目安（2024年時点）

| モデル | 用途 | 入力コスト | 出力コスト | 備考 |
|--------|------|-----------|-----------|------|
| gpt-4o-realtime-preview | 音声会話 | $100/1M tokens | $200/1M tokens | 音声入出力含む |
| gpt-4o | 患者生成 | $2.50/1M tokens | $10/1M tokens | 高品質テキスト生成 |
| gpt-4o-mini | 評価・分析 | $0.15/1M tokens | $0.60/1M tokens | コスト効率重視 |

#### API呼び出しフロー図

```
[学生の操作]                      [OpenAI API呼び出し]
    │
    ├─ 問診練習開始 ─────────────→ (1) 患者シミュレーション（Realtime API）
    │     │                              ↓
    │     └─ 音声会話継続 ←────── 患者の応答（音声）
    │
    ├─ 「評価に進む」押下 ───────→ (2) 会話評価（gpt-4o-mini）
    │                                    ↓
    │                              評価結果表示
    │
    ├─ AIコーチに質問 ──────────→ (4) AIコーチ学生用（gpt-4o-mini）
    │                                    ↓
    │                              分析結果・グラフ表示
    │
    └─ 患者をAIで生成 ──────────→ (6) 患者生成（gpt-4o）
                                         ↓
                                   患者プロフィール表示

[管理者の操作]
    │
    ├─ 全体データ分析 ──────────→ (3) AIコーチ管理者用（gpt-4o-mini）
    │                                    ↓
    │                              統計・グラフ表示
    │
    └─ 患者をAIで生成 ──────────→ (5) 患者生成管理者用（gpt-4o）
                                         ↓
                                   患者プロフィール表示
```

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

## 11. 患者設定パラメータ

### 11.1 基本パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| name | string | ✓ | 患者名（例: 山田太郎） |
| gender | string | ✓ | 性別: "male" または "female" |
| ageBand | string | ✓ | 年齢帯: "child", "adult", "elderly" |
| language | string | ✓ | 言語: "ja", "en", "ko", "zh" |
| brokenJapanese | boolean | - | カタコト日本語モード（デフォルト: false） |
| profile | string | ✓ | 症状・背景情報（AI患者の振る舞いを決定） |
| timeLimit | number | - | 制限時間（秒、デフォルト: 180） |

### 11.2 言語設定の組み合わせ

| language | brokenJapanese | 動作 |
|----------|---------------|------|
| ja | false | 日本語のみで応答（標準モード） |
| ja | true | - （日本語モードでは無効） |
| en | false | 英語のみで応答（日本語を理解しない） |
| en | true | カタコト日本語で応答（約100文字レベル） |
| ko | false | 韓国語のみで応答（日本語を理解しない） |
| ko | true | カタコト日本語で応答（約100文字レベル） |
| zh | false | 中国語のみで応答（日本語を理解しない） |
| zh | true | カタコト日本語で応答（約100文字レベル） |

### 11.3 年齢帯による振る舞いの違い

| ageBand | 話す速さ | 文の長さ | 特徴 |
|---------|---------|---------|------|
| child | やや速め | 最大10語 | 落ち着きがない、イエス/ノーが多い |
| adult | 普通 | 最大15語 | 直接的で明確、プロフェッショナル |
| elderly | ゆっくり | 最大12語 | 丁寧、疲れた様子、話の間に間がある |

### 11.4 プロフィール（profile）の書き方

プロフィールは患者の症状と背景を定義します。AIはこの情報に基づいて患者役を演じます。

**例1: 胸痛患者**
```
45歳男性。2日前から胸の中央に締め付けられるような痛みがある。
歩くと悪化し、安静にすると少し楽になる。
既往歴: 高血圧で内服中。喫煙歴20年。
今朝から痛みが強くなり来院。
```

**例2: 頭痛患者（カタコト日本語）**
```
30歳女性。旅行で来日中の韓国人。
3日前から頭痛が続いている。吐き気もある。
海外旅行保険に加入している。
英語は少しできるが、日本語は初歩レベル。
```

---

## 12. カタコト日本語機能 詳細仕様

### 12.1 概要

カタコト日本語モード（`brokenJapanese=true`）は、日本語を約100文字レベルで理解・使用する外国人患者をシミュレートする機能です。この機能は `public/practice.js` の `buildInstructions()` 関数内にハードコードされています。

**有効条件**:
- `language` が "ja" 以外（en, ko, zh）
- `brokenJapanese` が `true`

### 12.2 理解可能な日本語単語リスト（約100語）

#### 基本動詞
```
痛い、ある、いる、ない、する、なる、わからない、来る、行く、見る、聞く、
食べる、飲む、寝る、起きる、座る、立つ、歩く、触る、できる
```

#### 体の部位
```
頭、目、耳、鼻、口、歯、喉、首、肩、腕、手、指、胸、お腹、背中、
腰、足、膝、体、心臓
```

#### 症状・状態
```
痛み、熱、咳、吐く、めまい、しびれ、かゆい、腫れる、出血、下痢、
便秘、動悸、息苦しい、だるい、疲れる、眠い、寒い、暑い、苦しい、
気持ち悪い
```

#### 時間表現
```
今日、昨日、一昨日、今朝、夜、朝、昼、前、後、時間、分、いつ、
ずっと、時々、今
```

#### 疑問詞・指示詞
```
何、どこ、どう、いつ、なぜ、これ、それ、あれ、ここ、そこ
```

#### 数字
```
1〜100（数字表現）
```

#### 基本医療用語
```
病院、医者、看護師、薬、注射、検査、血圧、体温、脈
```

#### 形容詞・副詞
```
強い、弱い、大きい、小さい、多い、少ない、長い、短い、良い、悪い、
とても、少し、もっと、まだ
```

#### その他基本語
```
はい、いいえ、お願い、ありがとう、すみません、大丈夫、名前、年、歳、
男、女、仕事、家、水、ご飯
```

### 12.3 理解不可能な日本語

以下のような日本語は理解できないとして振る舞います：

| カテゴリ | 例 |
|---------|-----|
| 複雑な医療用語 | 随伴症状、既往歴、血圧、心電図、X線検査 |
| 敬語・丁寧語 | おっしゃる、いたす、させていただく |
| 複雑な文法 | 受動態、使役形、条件文 |
| 複合動詞 | 思い出す、取り出す、持ち上げる |
| 長い文章 | 20語以上の文 |
| 抽象的概念 | 状況、可能性、程度、傾向 |

### 12.4 カタコト日本語の話し方ルール

#### 文法ルール
| ルール | 正しい例 | 間違った例（流暢すぎる） |
|--------|---------|---------------------|
| 助詞を省略 | 「頭、痛い」 | 「頭が痛いです」 |
| 敬語を使わない | 「わからない」 | 「わかりません」 |
| 2-4語で1フレーズ | 「昨日から。痛い。」 | 「昨日から痛いです。」 |
| 最大10語で1回答 | 短い返答のみ | 長い説明 |

#### 話し方スタイル
```
- たどたどしく、ためらいながら話す
- 「えっと...」「あの...」などの間を入れる
- 単語を思い出すように区切って話す
  例: 「えっと...頭...痛い...」「昨日から...ここ...痛い」
```

### 12.5 会話例

#### 理解できる質問への応答
```
看護師: 「どこが痛いですか？」
患者: 「頭...ここ...痛い」（頭を指しながら）

看護師: 「いつから痛いですか？」
患者: 「昨日から。ずっと...痛い」

看護師: 「熱はありますか？」
患者: 「熱...あると思う。体、熱い」

看護師: 「お名前は？」
患者: 「〇〇です」（名前は必ず答える）
```

#### 理解できない質問への応答
```
看護師: 「既往歴はありますか？」
患者: 「わからない...難しい」

看護師: 「随伴症状について教えてください」
患者: 「何？簡単に、お願い」

看護師: 「血圧の薬を服用されていますか？」
患者: 「え...すみません。もう一度？簡単、お願い」
```

### 12.6 実装場所と編集方法

#### 現在の実装
- **ファイル**: `public/practice.js`
- **関数**: `buildInstructions()`
- **行数**: 約3017〜3101行目（バージョンにより変動）
- **管理UI**: 現時点では**なし**（ハードコード）

#### 編集方法
現在は `public/practice.js` を直接編集する必要があります：

```javascript
// public/practice.js 内の単語リスト部分を編集
const katakotoVocab = `
YOUR JAPANESE IS VERY LIMITED (approximately 100-character level).
You can ONLY understand and use these Japanese words:

【基本動詞】
痛い、ある、いる、ない、する、なる、わからない、来る、行く、見る、聞く...
`;
```

#### 将来的な改善案
キーワード管理機能と同様に、Firestore + 管理画面での編集機能を追加することで、コード変更なしでカタコト日本語の単語リストを管理できるようになります。

```
// 将来的なFirestore構造案
Collection: systemConfigs
Document: katakotoVocab
Fields:
  verbs: ["痛い", "ある", "いる", ...]
  bodyParts: ["頭", "目", "耳", ...]
  symptoms: ["痛み", "熱", "咳", ...]
  ...
  updatedAt: timestamp
  updatedBy: { uid, email }
```

---

**作成者**: AI System  
**最終確認**: 2025-11-30
