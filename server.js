/**
 * server.js — Cloud Run 安定版
 * 機能:
 *  - Firebase 認証（IDトークン）/ Firestore
 *  - OpenAI（採点）/ Realtime Ephemeral Key
 *  - 学修セッション: start/log/finish/get
 *  - 管理者: ユーザー一覧/権限更新
 *  - 学修状況 API（サマリ/個別ログ）
 *  - シナリオ患者設定 API（必須項目・@auto自動命名）/ 署名付きURLで動画アップロード
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import multer from "multer";

/* ============ 基本設定 ============ */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));

// Firebase Authentication ポップアップ対応: COOPヘッダーを削除
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

// Multer configuration for audio file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

/* ============ 環境変数 ============ */
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY || "";
const AUTH_PROJECT_ID  = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "";
const DB_PROJECT_ID    = process.env.FIRESTORE_PROJECT_ID || AUTH_PROJECT_ID;
const APP_VERSION      = process.env.APP_VERSION || "dev";
const ASSETS_BUCKET    = process.env.ASSETS_BUCKET || ""; // 動画保管先（GCS バケット名）
const RECORDINGS_BUCKET = process.env.RECORDINGS_BUCKET || ASSETS_BUCKET || ""; // 音声録音保管先

/* ============ 起動時エラーハンドラ ============ */
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

/* ============ ヘルスチェック（最優先） ============ */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

// ルートパスも即座に応答（Cloud Runのヘルスチェック対策）
app.get("/", (_req, res) => {
  try {
    const indexPath = path.join(__dirname, "public", "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error("[/] sendFile error:", err);
        res.status(500).send("Internal Server Error");
      }
    });
  } catch (e) {
    console.error("[/] route error:", e);
    res.status(500).send("Internal Server Error");
  }
});

/* ============ 依存初期化（非同期） ============ */
let adminReady = false;
let db = null;
let dbReady = false;
let storage = null;
let storageReady = false;

// 初期化を非同期で実行（サーバー起動を待たせない）
(async () => {
  try {
    console.log("[init] Starting background initialization...");
    
    // Firebase Admin
    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          projectId: AUTH_PROJECT_ID,
          credential: admin.credential.applicationDefault ? admin.credential.applicationDefault() : undefined,
        });
      }
      adminReady = true;
      console.log("[admin] ✓ initialized. AUTH_PROJECT_ID =", AUTH_PROJECT_ID);
    } catch (e) {
      adminReady = false;
      console.warn("[admin] ✗ initialize failed (continue without auth):", e?.message || e);
    }

    // Firestore
    try {
      db = new Firestore({ projectId: DB_PROJECT_ID });
      // listCollections()は呼ばない（遅延初期化）
      dbReady = true;
      console.log("[firestore] ✓ ready. DB_PROJECT_ID =", DB_PROJECT_ID);
    } catch (e) {
      db = null;
      dbReady = false;
      console.warn("[firestore] ✗ init failed (continue without DB):", e?.message || e);
    }

    // Storage
    try {
      storage = new Storage();
      storageReady = true;
      console.log("[storage] ✓ ready. ASSETS_BUCKET =", ASSETS_BUCKET || "(not set)");
    } catch (e) {
      storage = null;
      storageReady = false;
      console.warn("[storage] ✗ init failed (continue without GCS):", e?.message || e);
    }
    
    console.log("[init] ✓ All services initialized. adminReady=%s dbReady=%s storageReady=%s", adminReady, dbReady, storageReady);
  } catch (err) {
    console.error("[init] ✗✗✗ Catastrophic initialization error:", err);
    // サーバーは継続動作
  }
})().catch(err => {
  console.error("[init] ✗✗✗ Unhandled async error:", err);
  // サーバーは継続動作
});

/* ============ Firebase設定エンドポイント ============ */
// firebase-config.js を動的に生成（ファイルがない場合のフォールバック）
app.get("/firebase-config.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  
  // 環境変数またはデフォルト値からFirebase設定を生成
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAQtV23xflspVnkJyap9OB3uPKjphfLdDw",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${AUTH_PROJECT_ID}.firebaseapp.com`,
    projectId: AUTH_PROJECT_ID || "montore-e35be",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${AUTH_PROJECT_ID}.firebasestorage.app`,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "327159500498",
    appId: process.env.FIREBASE_APP_ID || "1:327159500498:web:f104de2e4a9d4f041f270b",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-TTK7RQRZKB"
  };
  
  const js = `// Firebase Configuration for MONTORE Ver4 (generated by server)
window.FIREBASE_CONFIG = ${JSON.stringify(config, null, 2)};
console.log("[firebase-config.js] MONTORE Ver4 Firebase configuration loaded from server");`;
  
  res.send(js);
});

/* ============ 静的ファイル ============ */
const publicRoot = path.join(__dirname, "public");
app.use(express.static(publicRoot, { index: false, extensions: ["html","htm"] }));
app.get(/^\/(?!api\/|health$).*/, (_req, res) => res.sendFile(path.join(publicRoot, "index.html")));

/* ============ 共通ヘルパ ============ */
async function openaiFetch(url, init = {}) {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}
async function openaiChatJSON({ model = "gpt-4o-mini", system, user }) {
  const r = await openaiFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI ${r.status}`);
  const text = j?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(text);
}

/* ============ API ログ ============ */
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/session" || req.path === "/health") {
    console.log(`[api] ${req.method} ${req.path}`);
  }
  next();
});

/* ============ 認証系 ============ */
async function requireAuth(req, res, next) {
  try {
    console.log('[requireAuth] adminReady:', adminReady);
    if (!adminReady) {
      console.error('[requireAuth] Auth not initialized');
      return res.status(500).json({ error: "auth not initialized" });
    }
    const authHeader = req.get("Authorization") || "";
    console.log('[requireAuth] Authorization header present:', !!authHeader);
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      console.error('[requireAuth] Invalid authorization header format');
      return res.status(401).json({ error: "missing Authorization: Bearer <Firebase ID token>" });
    }
    console.log('[requireAuth] Verifying token...');
    const decoded = await admin.auth().verifyIdToken(m[1]);
    console.log('[requireAuth] Token verified for uid:', decoded.uid);
    req.user = { uid: decoded.uid, email: decoded.email || null, name: decoded.name || decoded.displayName || null };
    next();
  } catch (e) {
    console.error('[requireAuth] Token verification failed:', e.message);
    res.status(401).json({ error: "invalid Firebase ID token", detail: String(e?.message || e) });
  }
}
const isAdminEmail = (email)=> email === "gmhata@gmail.com";

async function ensureUserDoc(uid, email, name) {
  console.log('[ensureUserDoc] Called for uid:', uid, 'dbReady:', dbReady);
  if (!dbReady) {
    console.log('[ensureUserDoc] DB not ready, returning default role');
    return { role: isAdminEmail(email) ? "admin" : "user" };
  }

  try {
    const uref = db.collection("users").doc(uid);
    const snap = await uref.get();
    console.log('[ensureUserDoc] User exists:', snap.exists);

    if (!snap.exists) {
      console.log('[ensureUserDoc] Creating new user document...');
      const cref = db.collection("meta").doc("counters");
      await db.runTransaction(async (tx) => {
        const cdoc = await tx.get(cref);
        const nextNo = (cdoc.exists ? cdoc.data().userNo || 0 : 0) + 1;
        tx.set(cref, { userNo: nextNo }, { merge: true });
        tx.set(uref, {
          userNo: nextNo,
          email: email || null,
          name: name || null,
          role: isAdminEmail(email) ? "admin" : "user",
          createdAt: Date.now(),
        }, { merge: true });
      });
      console.log('[ensureUserDoc] User document created');
    } else {
      const cur = snap.data() || {};
      const patch = {};
      // メールアドレスのみ更新（名前は管理画面で設定されるため上書きしない）
      if (email && cur.email !== email) patch.email = email;
      // 名前は既存の値がない場合のみ設定（管理画面で設定された名前を保護）
      if (name && !cur.name) patch.name = name;
      // roleは既に設定されている場合は保護（管理画面で設定された権限を上書きしない）
      // ただし、gmhata@gmail.comの場合は常にadminに設定
      if (isAdminEmail(email) && cur.role !== "admin") {
        patch.role = "admin";
      } else if (!cur.role) {
        // roleが未設定の場合のみデフォルト値を設定
        patch.role = "user";
      }
      if (Object.keys(patch).length) {
        console.log('[ensureUserDoc] Updating user with patch:', patch);
        await uref.set(patch, { merge: true });
      }
    }
    const result = (await uref.get()).data();
    console.log('[ensureUserDoc] Returning user data:', result);
    return result;
  } catch (e) {
    console.error('[ensureUserDoc] Error:', e.message, e.stack);
    throw e;
  }
}
async function requireAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    const doc = await db.collection("users").doc(req.user.uid).get();
    const ok = isAdminEmail(req.user.email || "") || (doc.exists && doc.data().role === "admin");
    if (!ok) return res.status(403).json({ error: "forbidden" });
    next();
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}

/* ============ Detailed Health Status ============ */
app.get("/api/health/status", (_req, res) =>
  res.json({
    ok: true,
    version: APP_VERSION,
    authProject: AUTH_PROJECT_ID,
    dbProject: DB_PROJECT_ID,
    adminReady,
    dbReady,
    openai: !!OPENAI_API_KEY,
    storageReady,
    bucket: ASSETS_BUCKET || null,
  })
);

app.get("/api/roles/me", requireAuth, async (req, res) => {
  try {
    console.log('[/api/roles/me] Request received');
    const { uid, email, name } = req.user;
    console.log('[/api/roles/me] User info - uid:', uid, 'email:', email);

    const udoc = await ensureUserDoc(uid, email, name);
    console.log('[/api/roles/me] User doc retrieved:', udoc);

    // デバッグ：管理者チェックの詳細
    const isAdminByEmail = isAdminEmail(email);
    const isAdminByDoc = udoc?.role === "admin";
    console.log('[/api/roles/me] isAdminByEmail:', isAdminByEmail, 'isAdminByDoc:', isAdminByDoc);
    
    const role  = isAdminByEmail || isAdminByDoc ? "admin" : "user";
    console.log('[/api/roles/me] Final role:', role);
    
    // Firestoreから最新の名前を取得
    const userName = udoc?.name || name || email?.split('@')[0] || "ユーザー";

    const response = {
      ok: true,
      role,
      uid,
      email,
      name: userName,
      displayName: userName
    };
    console.log('[/api/roles/me] Sending response:', response);
    res.json(response);
  } catch (e) {
    console.error('[/api/roles/me] Error:', e.message, e.stack);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ============ Realtime: ephemeral key ============ */
app.post("/session", requireAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: "OPENAI_API_KEY not set" });
    }

    const body = req.body || {};
    // 修正: shimmer（女性）と echo（男性）を許可
    const allowedVoices = new Set(["shimmer", "echo", "alloy", "verse"]);

    const gender = String(body.gender || body?.persona?.gender || "").toLowerCase();
    const fallbackVoice = gender === "male" ? "echo" : "shimmer";

    let voice = String(body.voice || body?.persona?.voice || "").toLowerCase();
    if (!allowedVoices.has(voice)) voice = fallbackVoice;

    const r = await openaiFetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: { "OpenAI-Beta": "realtime=v1" },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice
      }),
    });

    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch {}

    if (!r.ok) {
      console.warn("[/session] OpenAI error", r.status, text);
      return res.status(r.status).json({ ok: false, error: j?.error?.message || `OpenAI ${r.status}`, detail: j });
    }

    const ephemeralKey = j?.client_secret?.value || j?.client_secret || null;
    res.json({ ok: true, voice, ephemeralKey });
  } catch (e) {
    console.error("[/session] error", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============ Sessions ============ */
app.post("/api/sessions/start", requireAuth, async (req, res) => {
  try {
    const cfg = req.body || {};
    const sid = crypto.randomUUID();
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    const sref = db.collection("sessions").doc(sid);
    const now  = Date.now();
    await sref.set({
      id: sid,
      uid: req.user.uid,
      email: req.user.email || null,
      cfg,
      createdAt: now,
      updatedAt: now,
      status: "active",
    });
    res.json({ ok: true, id: sid, sessionId: sid });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/sessions/:id/log", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    const { id } = req.params;
    const { who = "user", text = "", prosody = null } = req.body || {};
    const sRef   = db.collection("sessions").doc(id);
    const msgRef = sRef.collection("messages").doc();
    const now    = Date.now();
    
    const messageData = { 
      id: msgRef.id, 
      t: now, 
      who: String(who), 
      text: String(text) 
    };
    
    // Add prosody data if available (for nurse speech analysis)
    // Volume-based metrics: intonation from volume variance, clarity from volume + energy variance
    if (prosody && typeof prosody === 'object') {
      messageData.prosody = {
        avgVolume: prosody.avgVolume || 0,
        avgEnergy: prosody.avgEnergy || 0,
        volumeVariance: prosody.volumeVariance || 0,
        energyVariance: prosody.energyVariance || 0,
        speakingRate: prosody.speakingRate || 0,
        totalSpeakingTime: prosody.totalSpeakingTime || 0,
        speechSegments: prosody.speechSegments || 0,
        evaluation: prosody.evaluation || {}
      };
    }
    
    await msgRef.set(messageData);
    await sRef.set({ updatedAt: now }, { merge: true });
    res.json({ ok: true, messageId: msgRef.id });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ============ 採点（finish） ============ */
app.post("/api/sessions/:id/finish", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    const { id } = req.params;
    const { vitalChecked, examChecked } = req.body || {};
    const sRef  = db.collection("sessions").doc(id);
    const sSnap = await sRef.get();
    if (!sSnap.exists) return res.status(404).json({ error: "not found" });

    const msgsQ     = await sRef.collection("messages").orderBy("t").get();
    const messages  = msgsQ.docs.map((d) => d.data());
    const firstT    = messages[0]?.t || sSnap.data().createdAt || Date.now();
    const lastT     = messages[messages.length - 1]?.t || Date.now();
    const durationSec = Math.max(0, Math.round((lastT - firstT) / 1000));

let report = null;
if (OPENAI_API_KEY && messages.length) {
  const system = `あなたは看護教育の採点官です。会話ログ（看護師/患者）を読み、
下の9項目で 0/1/2 点の三段階で評価し、短いコメントを日本語で作成してください。
必ず JSON だけを返し、余計な文章は出力しないこと。

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

1) 導入（名乗り/挨拶）
  - 2点: 氏名を名乗り、役割を伝え、患者の氏名・年齢を確認した
  - 1点: 挨拶または氏名確認のいずれか一方のみ実施
  - 0点: 導入なし、または挨拶・氏名確認ともに未実施

2) 主訴
  - 2点: 「今日はどうされましたか」等の開放質問で主訴を聴取し、内容を復唱または確認した
  - 1点: 主訴を聴取したが、確認・復唱なし、または閉鎖質問のみ
  - 0点: 主訴の聴取なし

3) OPQRST
  - 2点: OPQRST（発症時期・増悪/寛解因子・性状・放散痛・程度・時間経過）のうち5項目以上を聴取
  - 1点: OPQRSTのうち2〜4項目を聴取
  - 0点: OPQRST項目の聴取が1項目以下

4) ROS & Red Flag
  - 2点: 随伴症状を複数聴取し、重篤な疾患の危険信号（呼吸困難・意識障害・胸痛放散等）を確認
  - 1点: 随伴症状の聴取はあるが、Red Flagの確認が不十分
  - 0点: 随伴症状・Red Flagともに未確認

5) 医療・生活歴
  - 2点: 既往歴・内服薬・アレルギー歴・喫煙/飲酒歴のうち3項目以上を聴取
  - 1点: 上記のうち1〜2項目を聴取
  - 0点: 医療歴・生活歴の聴取なし

6) 受診契機
  - 2点: 「なぜ今日受診されたのですか」等で受診理由・きっかけを明確に聴取
  - 1点: 受診契機に触れたが、詳細な確認なし
  - 0点: 受診契機の聴取なし

7) バイタル/現症
  - システム判定: バイタルサイン測定を実施した → 2点、実施しなかった → 0点
  - 実際の判定: ${vitalChecked ? 'バイタルサイン測定を実施しました（2点）' : 'バイタルサイン測定を実施しませんでした（0点）'}

8) 身体診察
  - システム判定: 身体診察を実施した → 2点、実施しなかった → 0点
  - 実際の判定: ${examChecked ? '身体診察を実施しました（2点）' : '身体診察を実施しませんでした（0点）'}

9) 進行
  - 2点: 論理的な順序で情報収集し、患者の訴えに応じて柔軟に質問を展開
  - 1点: 情報収集の順序に一部不自然さがある、または硬直的な質問
  - 0点: 情報収集の流れが不適切、または極端に短時間で終了

summary（総評）の作成ルール（厳守）:
- 日本語の「です・ます調」。2〜3文、合計180〜250文字に収める。
- 会話ログの事実に基づく具体的な観察を少なくとも3点含める（例:「氏名確認なし」「OPQRSTの“増悪/寛解”未確認」「胸痛の随伴症状を未質問」等）。
- あいまい語の禁止（例:「全体的に」「だいたい」「不十分」「もっと」「気をつけたい」など）。具体的な名詞・動詞で記述する。
- 新しい事実の創作は禁止。必要に応じて看護師/患者の発言を短く「」で引用してよい。
- 批判は簡潔にし、最後は次回に向けた励ましの1文で締める。

positives / improvements の作成ルール:
- それぞれ3〜5件。各要素は文頭を動詞で始める短い指示文にする（例:「氏名・年齢を最初に確認する」「OPQRSTの“時間経過”を必ず尋ねる」など）。
- 1要素は45文字以内。具体的な観察や手技名を含める（OPQRST, ROS, Red Flag, バイタル等の語を積極的に使う）。

出力 JSON 形式:
{
  "report": {
    "rubric": [
      {"name":"導入","score":0,"comment":"..."},
      {"name":"主訴","score":0,"comment":"..."},
      {"name":"OPQRST","score":0,"comment":"..."},
      {"name":"ROS&RedFlag","score":0,"comment":"..."},
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
}`;

  const convo = messages.map(m => `${m.who === "nurse" ? "看護師" : "患者"}: ${m.text}`).join("\n");
  const user  = `会話ログ:\n${convo}\n\n上記の厳密な形式とルールで JSON のみ返してください。`;

  try {
    const j = await openaiChatJSON({ system, user, model: "gpt-4o-mini" });
    const rb = Array.isArray(j?.report?.rubric) ? j.report.rubric : [];
    report = {
      rubric: rb.map((x, i) => {
        let score = Math.max(0, Math.min(2, Number(x?.score ?? 0)));
        let comment = String(x?.comment || "");

        // バイタル/現症（インデックス6）はシステム判定で上書き
        if (i === 6) {
          score = vitalChecked ? 2 : 0;
          comment = vitalChecked ? 'バイタルサイン測定を実施しました（体温、血圧、脈拍などを確認）' : 'バイタルサイン測定を実施していません。体温・血圧・脈拍等の測定が必要です';
        }
        // 身体診察（インデックス7）はシステム判定で上書き
        if (i === 7) {
          score = examChecked ? 2 : 0;
          comment = examChecked ? '身体診察を実施しました（視診、触診、聴診などを実施）' : '身体診察を実施していません。視診・触診・聴診などが必要です';
        }

        return {
          name: String(x?.name || ["導入","主訴","OPQRST","ROS&RedFlag","医療・生活歴","受診契機","バイタル/現症","身体診察","進行"][i] || `項目${i+1}`),
          score,
          comment,
        };
      }),
      summary: String(j?.report?.summary || ""),
      positives: Array.isArray(j?.report?.positives) ? j.report.positives.map(String) : [],
      improvements: Array.isArray(j?.report?.improvements) ? j.report.improvements.map(String) : [],
      durationSec,
    };
  } catch (err) {
    console.warn("[scoring] OpenAI failed:", err?.message || err);
  }
}

    const analysis = report ? { report, durationSec, createdAt: Date.now() } : null;
    await sRef.set({ status: "finished", updatedAt: Date.now(), analysis }, { merge: true });

    res.json({ ok: true, analysisSaved: !!analysis });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/sessions/:id", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    const { id } = req.params;
    const sRef  = db.collection("sessions").doc(id);
    const snap  = await sRef.get();
    if (!snap.exists) return res.status(404).json({ error: "not found" });
    const msgsQ = await sRef.collection("messages").orderBy("t").get();
    const messages = msgsQ.docs.map((d) => d.data());
    res.json({ ok: true, session: snap.data(), messages, analysis: snap.data().analysis || null });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// セッション音声のアップロード
app.post("/api/sessions/upload-audio", requireAuth, upload.single('audio'), async (req, res) => {
  try {
    if (!dbReady || !storageReady) {
      return res.status(503).json({ ok: false, error: "service not ready" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "no audio file provided" });
    }

    const sessionId = req.body.sessionId;
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "sessionId required" });
    }

    // Verify session exists and belongs to user
    const sessionRef = db.collection("sessions").doc(sessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(404).json({ ok: false, error: "session not found" });
    }

    const sessionData = sessionSnap.data();
    if (sessionData.uid !== req.user.uid) {
      return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    // Upload to Cloud Storage
    if (!RECORDINGS_BUCKET) {
      console.error('[Recording] RECORDINGS_BUCKET not configured. ASSETS_BUCKET:', ASSETS_BUCKET);
      return res.status(500).json({ ok: false, error: "recordings bucket not configured" });
    }

    console.log('[Recording] Uploading to bucket:', RECORDINGS_BUCKET);
    const fileName = `recordings/${sessionId}.webm`;
    const file = storage.bucket(RECORDINGS_BUCKET).file(fileName);

    try {
      console.log('[Recording] Saving file buffer, size:', req.file.buffer.length, 'to bucket:', RECORDINGS_BUCKET);
      await file.save(req.file.buffer, {
        metadata: {
          contentType: req.file.mimetype || 'audio/webm',
          cacheControl: 'public, max-age=31536000',
          contentDisposition: 'inline',
          metadata: {
            sessionId: sessionId,
            uploadedBy: req.user.uid,
            uploadedAt: new Date().toISOString()
          }
        }
      });
      console.log('[Recording] File saved successfully to', fileName);
    } catch (saveError) {
      console.error('[Recording] Error saving file to bucket', RECORDINGS_BUCKET + ':', saveError.message);
      throw new Error(`Failed to save file to bucket ${RECORDINGS_BUCKET}: ${saveError.message}`);
    }

    // Try to make file public, but fall back to signed URL if it fails
    let audioUrl;
    try {
      console.log('[Recording] Making file public');
      await file.makePublic();
      console.log('[Recording] File made public successfully');
      audioUrl = `https://storage.googleapis.com/${RECORDINGS_BUCKET}/${fileName}`;
      console.log('[Recording] Public URL:', audioUrl);
    } catch (publicError) {
      console.warn('[Recording] Could not make file public (will use signed URL):', publicError.message);
      // Generate signed URL valid for 7 days (GCS maximum)
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days - GCS maximum
      });
      audioUrl = signedUrl;
      console.log('[Recording] Signed URL generated:', audioUrl.substring(0, 100) + '...');
    }

    try {
      console.log('[Recording] Updating session document');
      await sessionRef.update({
        audioUrl: audioUrl,
        audioUploadedAt: Date.now()
      });
      console.log('[Recording] Session updated successfully');
    } catch (updateError) {
      console.error('[Recording] Error updating session:', updateError);
      throw new Error(`Failed to update session: ${updateError.message}`);
    }

    console.log('[Recording] Audio uploaded:', audioUrl);
    res.json({ ok: true, audioUrl });

  } catch (e) {
    console.error('[Recording] Upload error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 診断用: 音声ファイルのアクセス権限をテスト
app.get("/api/sessions/:sessionId/test-audio", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    if (!storageReady) return res.status(503).json({ error: "storage not ready" });

    const { sessionId } = req.params;
    const sessionRef = db.collection("sessions").doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ error: "session not found" });
    }

    const sessionData = sessionDoc.data();
    
    // セッションのオーナーまたは管理者のみ
    if (sessionData.uid !== req.user.uid && !req.user.isAdmin) {
      return res.status(403).json({ error: "forbidden" });
    }

    const audioUrl = sessionData.audioUrl;
    if (!audioUrl) {
      return res.json({
        ok: true,
        hasAudio: false,
        message: "No audio file for this session"
      });
    }

    // Check if file exists in bucket
    const fileName = `recordings/${sessionId}.webm`;
    const file = storage.bucket(RECORDINGS_BUCKET).file(fileName);
    
    const [exists] = await file.exists();
    const [metadata] = exists ? await file.getMetadata() : [null];
    
    // Generate a fresh signed URL for testing
    let testSignedUrl = null;
    if (exists) {
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000, // 1 hour for testing
      });
      testSignedUrl = url;
    }

    res.json({
      ok: true,
      hasAudio: true,
      audioUrl: audioUrl,
      fileExists: exists,
      fileName: fileName,
      bucketName: RECORDINGS_BUCKET,
      fileSize: metadata?.size,
      contentType: metadata?.contentType,
      isPublic: metadata?.acl ? metadata.acl.some(a => a.entity === 'allUsers') : false,
      testSignedUrl: testSignedUrl,
      urlType: audioUrl.includes('X-Goog-Signature') ? 'signed' : 'public',
      diagnostics: {
        storageReady: storageReady,
        bucketConfigured: !!RECORDINGS_BUCKET,
      }
    });

  } catch (e) {
    console.error('[Test Audio] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 一般ユーザー用: 自分の学修履歴を取得
app.get("/api/my/sessions", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: "db not ready" });
    
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    
    // インデックス不要なクエリに変更（whereのみ）
    const qs = await db.collection("sessions")
      .where("uid", "==", req.user.uid)
      .get();
    
    // メモリ上でソート
    const allDocs = qs.docs
      .map(doc => ({ doc, createdAt: doc.data().createdAt || 0 }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(x => x.doc);
    
    const sessions = [];
    for (const doc of allDocs) {
      const s = { id: doc.id, ...doc.data() };

      // メッセージ数を取得し、会話速度データを集計
      const msgsQ = await db.collection("sessions").doc(doc.id).collection("messages").get();
      const messageCount = msgsQ.size;

      // 看護師のメッセージからprosodyデータを集計
      let avgSpeakingRate = null;
      const nurseMessages = msgsQ.docs.filter(d => d.data().who === "nurse" && d.data().prosody?.speakingRate != null);
      if (nurseMessages.length > 0) {
        const totalRate = nurseMessages.reduce((sum, d) => sum + (d.data().prosody?.speakingRate || 0), 0);
        avgSpeakingRate = Math.round((totalRate / nurseMessages.length) * 10) / 10;
      }

      // スコア計算
      let score100 = null;
      const rb = s?.analysis?.report?.rubric;
      if (Array.isArray(rb) && rb.length) {
        const total = rb.reduce((a, x) => a + Math.max(0, Math.min(2, Number(x?.score || 0))), 0);
        const max = rb.length * 2;
        score100 = max ? Math.round((total / max) * 100) : 0;
      }

      sessions.push({
        id: s.id,
        createdAt: s.createdAt || 0,
        type: s?.cfg?.type || s?.cfg?.mode || s?.type || "training",
        mode: s?.cfg?.mode || (s?.cfg?.type === "exam" || s?.type === "exam" ? "test" : "practice"),
        patient: s?.cfg?.patient || null,
        persona: s?.cfg?.persona || null,
        messageCount,
        score100,
        hasAnalysis: !!(s.analysis),
        avgSpeakingRate
      });
    }
    
    res.json({ ok: true, sessions });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* =======================================================================
 * 学修状況 API
 * ======================================================================= */
async function computeSessionDurationSec(sessionDoc) {
  try {
    const s = sessionDoc;
    if (typeof s?.analysis?.durationSec === "number") return s.analysis.durationSec;
    const sRef = db.collection("sessions").doc(s.id);
    const firstQ = await sRef.collection("messages").orderBy("t","asc").limit(1).get();
    const lastQ  = await sRef.collection("messages").orderBy("t","desc").limit(1).get();
    const firstT = firstQ.docs[0]?.data()?.t ?? s.createdAt ?? 0;
    const lastT  = lastQ.docs[0]?.data()?.t  ?? s.updatedAt ?? s.createdAt ?? firstT;
    return Math.max(0, Math.round((lastT - firstT)/1000));
  } catch {
    const s = sessionDoc;
    if (s.updatedAt && s.createdAt) return Math.max(0, Math.round((s.updatedAt - s.createdAt)/1000));
    return 0;
  }
}

app.get("/api/admin/learning/summary", requireAuth, requireAdmin, async (_req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    const usersSnap = await db.collection("users").orderBy("userNo").get();
    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

    const rows = [];
    for (const u of users) {
      const qs = await db.collection("sessions").where("uid", "==", u.uid).get();
      let practiceCount = 0;
      let examCount = 0;
      let bestExamScore100 = null;
      let totalDurationSec = 0;

      for (const sdoc of qs.docs) {
        const s = { id: sdoc.id, ...sdoc.data() };
        const typ = s?.cfg?.type || s?.cfg?.mode || s?.type || "";
        const isExam = (typ === "exam" || typ === "test");
        const isPractice = (typ === "training" || typ === "practice" || (!isExam));
        if (isExam) examCount++; else if (isPractice) practiceCount++;

        const rb = s?.analysis?.report?.rubric;
        if (isExam && Array.isArray(rb) && rb.length) {
          const total = rb.reduce((a,x)=> a + Math.max(0, Math.min(2, Number(x?.score || 0))), 0);
          const max   = rb.length * 2;
          const score100 = max ? Math.round((total / max) * 100) : 0;
          if (bestExamScore100 == null || score100 > bestExamScore100) bestExamScore100 = score100;
        }
        totalDurationSec += await computeSessionDurationSec(s);
      }

      rows.push({
        userNo: u.userNo || 0,
        uid: u.uid,
        name: u.name || "",
        email: u.email || "",
        practiceCount,
        examCount,
        bestExamScore100: (bestExamScore100 == null ? "-" : bestExamScore100),
        totalDurationSec
      });
    }

    res.json({ ok:true, rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.get("/api/admin/learning/user/:uid/logs", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    const { uid } = req.params;

    const qs = await db.collection("sessions").where("uid","==",uid).get();
    const sessions = qs.docs
      .map(d=> ({ id: d.id, ...d.data() }))
      .sort((a,b)=> (b.createdAt||0) - (a.createdAt||0)); // 新しい順

    const result = [];
    for (const s of sessions) {
      const msgsQ = await db.collection("sessions").doc(s.id).collection("messages")
        .orderBy("t").get();
      const messages = msgsQ.docs.map(d=> d.data());

      const durationSec = await computeSessionDurationSec(s);

      result.push({
        id: s.id,
        createdAt: s.createdAt || 0,
        type: s?.cfg?.type || s?.cfg?.mode || s?.type || "training",
        score100: (()=>{ 
          const rb = s?.analysis?.report?.rubric;
          if (!Array.isArray(rb) || !rb.length) return null;
          const total = rb.reduce((a,x)=> a + Math.max(0, Math.min(2, Number(x?.score || 0))),0);
          const max = rb.length * 2;
          return max ? Math.round((total/max)*100) : null;
        })(),
        durationSec,
        messages
      });
    }
    res.json({ ok:true, sessions: result });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// 成長分析: 全学生の初期5回 vs 直近5回の比較
app.get("/api/admin/learning/growth-analysis", requireAuth, requireAdmin, async (_req, res) => {
  try {
    console.log("[growth-analysis] Starting analysis...");
    if (!dbReady) {
      console.error("[growth-analysis] Database not ready");
      return res.status(503).json({ ok:false, error:"db not ready" });
    }

    // 全ユーザーを取得
    const usersSnap = await db.collection("users").orderBy("userNo").get();
    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    console.log(`[growth-analysis] Found ${users.length} users`);

    const analysisResults = [];

    for (const u of users) {
      try {
        console.log(`[growth-analysis] Processing user ${u.userNo}: ${u.name || u.email}`);

        // このユーザーの全セッションを取得（分析済みのみ）
        const qs = await db.collection("sessions").where("uid", "==", u.uid).get();
        const allSessions = qs.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(s => s.analysis && s.analysis.report && Array.isArray(s.analysis.report.rubric))
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // 古い順

        console.log(`[growth-analysis] User ${u.userNo} has ${allSessions.length} analyzed sessions`);

        if (allSessions.length === 0) {
          // セッションがない場合はスキップ
          continue;
        }

        // 初期5セッションと直近5セッションを抽出
        const initialSessions = allSessions.slice(0, Math.min(5, allSessions.length));
        const recentSessions = allSessions.slice(Math.max(0, allSessions.length - 5));

        // 初期セッションの分析
        const initialAnalysis = await analyzeSessionGroup(initialSessions);

        // 直近セッションの分析
        const recentAnalysis = await analyzeSessionGroup(recentSessions);

        // 成長率計算
        let growthRate = null;
        if (initialAnalysis.avgScore !== null && recentAnalysis.avgScore !== null) {
          if (initialAnalysis.avgScore > 0) {
            growthRate = Math.round(((recentAnalysis.avgScore - initialAnalysis.avgScore) / initialAnalysis.avgScore) * 100);
          } else {
            growthRate = recentAnalysis.avgScore > 0 ? 100 : 0;
          }
        }

        // 弱点項目（直近の平均が1.0未満）
        const weakItems = [];
        for (const [itemName, scores] of Object.entries(recentAnalysis.itemScores)) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          if (avg < 1.0) {
            weakItems.push({ name: itemName, avg: Math.round(avg * 100) / 100 });
        }
      }

        // 改善項目（0.5以上の向上）
        const improvedItems = [];
        for (const itemName of Object.keys(recentAnalysis.itemScores)) {
          if (initialAnalysis.itemScores[itemName]) {
            const initialAvg = initialAnalysis.itemScores[itemName].reduce((a, b) => a + b, 0) / initialAnalysis.itemScores[itemName].length;
            const recentAvg = recentAnalysis.itemScores[itemName].reduce((a, b) => a + b, 0) / recentAnalysis.itemScores[itemName].length;
            const improvement = recentAvg - initialAvg;
            if (improvement >= 0.5) {
              improvedItems.push({
                name: itemName,
                improvement: Math.round(improvement * 100) / 100,
                from: Math.round(initialAvg * 100) / 100,
                to: Math.round(recentAvg * 100) / 100
              });
            }
          }
        }

        analysisResults.push({
          userNo: u.userNo || 0,
          uid: u.uid,
          name: u.name || "",
          email: u.email || "",
          totalSessions: allSessions.length,
          initial: {
            count: initialSessions.length,
            avgScore: initialAnalysis.avgScore,
            avgSpeakingRate: initialAnalysis.avgSpeakingRate
          },
          recent: {
            count: recentSessions.length,
            avgScore: recentAnalysis.avgScore,
            avgSpeakingRate: recentAnalysis.avgSpeakingRate
          },
          growthRate,
          weakItems,
          improvedItems
        });

        console.log(`[growth-analysis] User ${u.userNo} processed successfully`);
      } catch (userError) {
        console.error(`[growth-analysis] Error processing user ${u.userNo} (${u.email}):`, userError);
        // このユーザーをスキップして続行
        continue;
      }
    }

    console.log(`[growth-analysis] Analysis complete. ${analysisResults.length} students processed.`);
    res.json({ ok: true, students: analysisResults });
  } catch (e) {
    console.error("[growth-analysis] Fatal error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// セッショングループの分析ヘルパー関数
async function analyzeSessionGroup(sessions) {
  if (sessions.length === 0) {
    return { avgScore: null, avgSpeakingRate: null, itemScores: {} };
  }

  let totalScore = 0;
  let scoreCount = 0;
  const itemScores = {}; // { itemName: [score1, score2, ...] }
  const speakingRates = [];

  for (const s of sessions) {
    // Rubric スコア集計
    const rubric = s.analysis.report.rubric;
    if (Array.isArray(rubric)) {
      for (const item of rubric) {
        const score = Math.max(0, Math.min(2, Number(item.score || 0)));
        totalScore += score;
        scoreCount += 1;

        const itemName = item.name || "不明";
        if (!itemScores[itemName]) {
          itemScores[itemName] = [];
        }
        itemScores[itemName].push(score);
      }
    }

    // 会話速度集計
    try {
      const msgsQ = await db.collection("sessions").doc(s.id).collection("messages").get();
      const nurseMessages = msgsQ.docs.filter(d => d.data().who === "nurse" && d.data().prosody?.speakingRate != null);
      if (nurseMessages.length > 0) {
        const totalRate = nurseMessages.reduce((sum, d) => sum + (d.data().prosody?.speakingRate || 0), 0);
        const avgRate = totalRate / nurseMessages.length;
        speakingRates.push(avgRate);
      }
    } catch (e) {
      console.warn(`[analyzeSessionGroup] Failed to get speaking rate for session ${s.id}:`, e.message);
    }
  }

  // 平均スコア計算（0-2スケール）
  const avgScore = scoreCount > 0 ? Math.round((totalScore / scoreCount) * 100) / 100 : null;

  // 平均会話速度計算
  const avgSpeakingRate = speakingRates.length > 0
    ? Math.round((speakingRates.reduce((a, b) => a + b, 0) / speakingRates.length) * 10) / 10
    : null;

  return { avgScore, avgSpeakingRate, itemScores };
}

// 評価項目分析: 全学生の評価項目スコアを集計（フィルタリング付き）
app.get("/api/admin/learning/rubric-analysis", requireAuth, requireAdmin, async (_req, res) => {
  try {
    console.log("[rubric-analysis] Starting analysis...");
    if (!dbReady) {
      console.error("[rubric-analysis] Database not ready");
      return res.status(503).json({ ok:false, error:"db not ready" });
    }

    // 全ユーザーを取得
    const usersSnap = await db.collection("users").orderBy("userNo").get();
    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    console.log(`[rubric-analysis] Found ${users.length} users`);

    const itemScoresGlobal = {}; // { itemName: [score1, score2, ...] }
    const studentItemScores = []; // { userNo, name, itemScores: { itemName: avgScore } }

    for (const u of users) {
      try {
        console.log(`[rubric-analysis] Processing user ${u.userNo}: ${u.name || u.email}`);

        // このユーザーの全セッションを取得
        const qs = await db.collection("sessions").where("uid", "==", u.uid).get();
        const allSessions = qs.docs.map(d => ({ id: d.id, ...d.data() }));

        console.log(`[rubric-analysis] User ${u.userNo} has ${allSessions.length} total sessions`);

        // フィルタリング: 適切なセッションのみ
        const validSessions = [];
        for (const s of allSessions) {
          // 評価が存在しない → 除外
          if (!s.analysis || !s.analysis.report || !Array.isArray(s.analysis.report.rubric) || s.analysis.report.rubric.length === 0) {
            continue;
          }

          // メッセージ数が10未満 → 除外
          try {
            const msgsQ = await db.collection("sessions").doc(s.id).collection("messages").get();
            if (msgsQ.size < 10) {
              console.log(`[rubric-analysis] Session ${s.id} has only ${msgsQ.size} messages, skipping`);
              continue;
            }
          } catch (e) {
            console.warn(`[rubric-analysis] Failed to get message count for session ${s.id}:`, e.message);
            continue;
          }

          validSessions.push(s);
        }

        console.log(`[rubric-analysis] User ${u.userNo} has ${validSessions.length} valid sessions after filtering`);

        if (validSessions.length === 0) {
          continue; // 有効なセッションがない場合はスキップ
        }

        // このユーザーの評価項目スコアを集計
        const userItemScores = {};
        for (const s of validSessions) {
          const rubric = s.analysis.report.rubric;
          for (const item of rubric) {
            const itemName = item.name || "不明";
            const score = Math.max(0, Math.min(2, Number(item.score || 0)));

            // グローバル集計
            if (!itemScoresGlobal[itemName]) {
              itemScoresGlobal[itemName] = [];
            }
            itemScoresGlobal[itemName].push(score);

            // ユーザー別集計
            if (!userItemScores[itemName]) {
              userItemScores[itemName] = [];
            }
            userItemScores[itemName].push(score);
          }
        }

        // ユーザーごとの平均スコアを計算
        const userItemAvg = {};
        for (const [itemName, scores] of Object.entries(userItemScores)) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          userItemAvg[itemName] = Math.round(avg * 100) / 100;
        }

        studentItemScores.push({
          userNo: u.userNo || 0,
          name: u.name || "",
          sessionCount: validSessions.length,
          itemScores: userItemAvg
        });

      } catch (userError) {
        console.error(`[rubric-analysis] Error processing user ${u.userNo} (${u.email}):`, userError);
        continue;
      }
    }

    // グローバル平均を計算
    const globalItemAvg = {};
    for (const [itemName, scores] of Object.entries(itemScoresGlobal)) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      globalItemAvg[itemName] = Math.round(avg * 100) / 100;
    }

    console.log(`[rubric-analysis] Analysis complete. ${studentItemScores.length} students processed.`);
    res.json({
      ok: true,
      globalItemAvg,
      studentItemScores
    });
  } catch (e) {
    console.error("[rubric-analysis] Fatal error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// テキストマイニング分析: 学生の対話特徴と患者応答品質
app.get("/api/admin/learning/text-mining", requireAuth, requireAdmin, async (_req, res) => {
  try {
    console.log("[text-mining] Starting analysis...");
    if (!dbReady) {
      console.error("[text-mining] Database not ready");
      return res.status(503).json({ ok:false, error:"db not ready" });
    }

    // 全ユーザーを取得
    const usersSnap = await db.collection("users").orderBy("userNo").get();
    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    console.log(`[text-mining] Found ${users.length} users`);

    const studentAnalysis = [];

    for (const u of users) {
      try {
        console.log(`[text-mining] Processing user ${u.userNo}: ${u.name || u.email}`);

        // このユーザーの全セッションを取得
        const qs = await db.collection("sessions").where("uid", "==", u.uid).get();
        const allSessions = qs.docs.map(d => ({ id: d.id, ...d.data() }));

        console.log(`[text-mining] User ${u.userNo} has ${allSessions.length} total sessions`);

        // フィルタリング: 適切なセッションのみ
        const validSessions = [];
        for (const s of allSessions) {
          // 評価が存在しない → 除外
          if (!s.analysis || !s.analysis.report || !Array.isArray(s.analysis.report.rubric) || s.analysis.report.rubric.length === 0) {
            continue;
          }

          // メッセージを取得
          try {
            const msgsQ = await db.collection("sessions").doc(s.id).collection("messages").orderBy("t").get();
            const messages = msgsQ.docs.map(d => d.data());

            if (messages.length < 10) {
              console.log(`[text-mining] Session ${s.id} has only ${messages.length} messages, skipping`);
              continue;
            }

            s.messages = messages; // メッセージを追加
            validSessions.push(s);
          } catch (e) {
            console.warn(`[text-mining] Failed to get messages for session ${s.id}:`, e.message);
            continue;
          }
        }

        console.log(`[text-mining] User ${u.userNo} has ${validSessions.length} valid sessions after filtering`);

        if (validSessions.length === 0) {
          continue; // 有効なセッションがない場合はスキップ
        }

        // 全セッションのテキストマイニング分析を実行
        const analysis = analyzeConversations(validSessions);

        studentAnalysis.push({
          userNo: u.userNo || 0,
          name: u.name || "",
          sessionCount: validSessions.length,
          ...analysis
        });

      } catch (userError) {
        console.error(`[text-mining] Error processing user ${u.userNo} (${u.email}):`, userError);
        continue;
      }
    }

    console.log(`[text-mining] Analysis complete. ${studentAnalysis.length} students processed.`);
    res.json({
      ok: true,
      students: studentAnalysis
    });
  } catch (e) {
    console.error("[text-mining] Fatal error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =======================================================================
 * AI分析機能（ChatGPT）
 * ======================================================================= */

// 管理者用AI分析 - 全対話データを対象
app.post("/api/admin/ai-analysis", requireAuth, requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: "Database not ready" });

  try {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ ok: false, error: "Query is required" });
    }

    // 全セッションデータを取得
    const sessionsQ = await db.collection("sessions")
      .orderBy("createdAt", "desc")
      .limit(200) // 最新200件に制限（トークン制限対策）
      .get();

    const sessions = [];
    const debugInfo = { totalFetched: sessionsQ.docs.length, validSessions: 0, withAnalysis: 0, withScore: 0, scoreMissing: 0 };

    for (const doc of sessionsQ.docs) {
      const data = doc.data();
      const msgsQ = await db.collection("sessions").doc(doc.id).collection("messages").get();
      const messages = msgsQ.docs.map(m => m.data());

      // 有効なセッションのみ（10メッセージ以上）
      if (messages.length >= 10) {
        debugInfo.validSessions++;
        const hasAnalysis = !!data.analysis;

        // スコア計算（学修履歴と同じロジック）
        let score100 = null;
        const rb = data?.analysis?.report?.rubric;
        if (Array.isArray(rb) && rb.length) {
          const total = rb.reduce((a, x) => a + Math.max(0, Math.min(2, Number(x?.score || 0))), 0);
          const max = rb.length * 2;
          score100 = max ? Math.round((total / max) * 100) : 0;
        }

        const hasScore = score100 !== null && score100 > 0;

        if (hasAnalysis) debugInfo.withAnalysis++;
        if (hasScore) debugInfo.withScore++;
        if (hasAnalysis && !hasScore) debugInfo.scoreMissing++;

        sessions.push({
          id: doc.id,
          uid: data.uid,
          mode: data.mode,
          createdAt: data.createdAt,
          score: score100 || 0,
          duration: data.duration || 0,
          hasAnalysis: hasAnalysis,
          hasScore: hasScore,
          messages: messages.map(m => ({
            who: m.who,
            text: m.text
          }))
        });
      }
    }

    console.log(`[AI Analysis Admin] Debug info: ${JSON.stringify(debugInfo)}`);

    // ユーザー情報を取得
    const usersQ = await db.collection("users").get();
    const users = usersQ.docs.map(doc => ({
      uid: doc.id,
      ...doc.data()
    }));

    // 評価済み/未評価を区別
    const sessionsWithScore = sessions.filter(s => s.hasScore && s.score > 0);
    const sessionsWithoutScore = sessions.filter(s => !s.hasScore || s.score === 0);

    // データサマリを作成
    const dataSummary = {
      totalSessions: sessions.length,
      sessionsWithScore: sessionsWithScore.length,
      sessionsWithoutScore: sessionsWithoutScore.length,
      totalUsers: users.length,
      avgScore: sessionsWithScore.length > 0
        ? Math.round(sessionsWithScore.reduce((sum, s) => sum + s.score, 0) / sessionsWithScore.length)
        : 0,
      sessions: sessions.slice(0, 50).map(s => ({
        uid: s.uid,
        mode: s.mode,
        score: s.score,
        hasScore: s.hasScore,
        duration: s.duration,
        messageCount: s.messages.length,
        // プライバシー保護: 実際の会話は必要な場合のみ
        sampleMessages: s.messages.slice(0, 5).map(m => `${m.who}: ${m.text}`)
      }))
    };

    // ChatGPT APIに送信
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `あなたは看護教育シミュレーションシステムのデータアナリストです。学生の対話データを分析し、教育的な洞察を提供してください。

【重要】データの説明：
- セッション = 1回の対話練習（開始から評価まで）
- 合計セッション数: ${dataSummary.totalSessions}
- 評価済みセッション数: ${dataSummary.sessionsWithScore}（「評価に進む」ボタンを押してスコアが記録されたもの）
- 評価未実行セッション数: ${dataSummary.sessionsWithoutScore}（対話は行ったが評価を実行していない、またはスコアが0のもの）
- 学生数: ${dataSummary.totalUsers}

【スコア情報】
- スコアは100点満点（ルーブリック評価項目の合計を100点満点に変換）
- 平均スコア: ${dataSummary.avgScore}点/100点（評価済みセッションのみの平均）

${dataSummary.sessionsWithoutScore > 0 ? `\n⚠️ 重要な注意: ${dataSummary.sessionsWithoutScore}個のセッションで評価が未実行またはスコアが0です。評価未実行のセッションはグラフ作成時に除外してください。` : ''}

分析結果はマークダウン形式で返してください。グラフが必要な場合は、以下のJSON形式で埋め込んでください：

\`\`\`chartjs
{
  "type": "line",
  "data": {
    "labels": ["項目1", "項目2", "項目3"],
    "datasets": [{
      "label": "データ系列名",
      "data": [10, 20, 15],
      "borderColor": "rgb(99, 102, 241)",
      "backgroundColor": "rgba(99, 102, 241, 0.1)"
    }]
  },
  "options": {
    "responsive": true,
    "plugins": {
      "title": {"display": true, "text": "グラフタイトル"}
    }
  }
}
\`\`\`

グラフタイプは "line", "bar", "pie", "radar", "doughnut" が使用できます。インタラクティブなグラフとして表示されます。`
          },
          {
            role: "user",
            content: `以下のデータに基づいて分析してください：\n\n${JSON.stringify(dataSummary, null, 2)}\n\n質問: ${query}`
          }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[AI Analysis] OpenAI API error:", errorText);
      return res.status(500).json({ ok: false, error: "AI analysis failed" });
    }

    const aiResult = await response.json();
    const analysis = aiResult.choices[0]?.message?.content || "分析結果を取得できませんでした。";

    // AI分析結果をFirestoreに保存（管理者用）
    const analysisDoc = {
      uid: req.user.uid, // 分析を実行した管理者のUID
      query,
      analysis,
      metadata: {
        totalSessions: dataSummary.totalSessions,
        sessionsWithScore: dataSummary.sessionsWithScore,
        sessionsWithoutScore: dataSummary.sessionsWithoutScore,
        totalUsers: dataSummary.totalUsers,
        avgScore: dataSummary.avgScore
      },
      isAdmin: true, // 管理者の分析
      createdAt: Date.now()
    };

    const docRef = await db.collection("aiAnalysisHistory").add(analysisDoc);
    console.log(`[AI Analysis Admin] Saved history: ${docRef.id}`);

    res.json({
      ok: true,
      analysisId: docRef.id,
      analysis,
      metadata: analysisDoc.metadata
    });

  } catch (error) {
    console.error("[AI Analysis Admin] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// 学生用AI分析 - 自分の対話データのみ対象
app.post("/api/student/ai-analysis", requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: "Database not ready" });

  try {
    const uid = req.user.uid; // 修正: req.uidではなくreq.user.uid
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ ok: false, error: "Query is required" });
    }

    // 自分のセッションデータのみ取得（個人情報保護）
    const sessionsQ = await db.collection("sessions")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const sessions = [];
    const debugInfo = { totalFetched: sessionsQ.docs.length, validSessions: 0, scoreMissing: 0 };

    for (const doc of sessionsQ.docs) {
      const data = doc.data();
      const msgsQ = await db.collection("sessions").doc(doc.id).collection("messages").get();
      const messages = msgsQ.docs.map(m => m.data());

      // 有効なセッションのみ
      if (messages.length >= 10) {
        debugInfo.validSessions++;

        // スコア計算（学修履歴と同じロジック）
        let score100 = null;
        const rb = data?.analysis?.report?.rubric;
        if (Array.isArray(rb) && rb.length) {
          const total = rb.reduce((a, x) => a + Math.max(0, Math.min(2, Number(x?.score || 0))), 0);
          const max = rb.length * 2;
          score100 = max ? Math.round((total / max) * 100) : 0;
        }

        const hasScore = score100 !== null && score100 > 0;
        if (!hasScore) debugInfo.scoreMissing++;

        sessions.push({
          id: doc.id,
          mode: data.mode,
          createdAt: data.createdAt,
          score: score100 || 0,
          duration: data.duration || 0,
          rubric: rb || [],
          hasAnalysis: !!data.analysis,
          hasScore: hasScore,
          messages: messages.map(m => ({
            who: m.who,
            text: m.text
          }))
        });
      }
    }

    console.log(`[AI Analysis Student] User ${uid}: ${JSON.stringify(debugInfo)}`);

    if (sessions.length === 0) {
      return res.json({
        ok: true,
        analysis: "まだ分析可能なセッションデータがありません。10メッセージ以上の会話を行ってください。",
        metadata: { totalSessions: 0 }
      });
    }

    // データサマリを作成（自分のデータのみ）
    const sessionsWithScore = sessions.filter(s => s.hasScore && s.score > 0);
    const sessionsWithoutScore = sessions.filter(s => !s.hasScore || s.score === 0);

    const dataSummary = {
      totalSessions: sessions.length,
      sessionsWithScore: sessionsWithScore.length,
      sessionsWithoutScore: sessionsWithoutScore.length,
      avgScore: sessionsWithScore.length > 0
        ? Math.round(sessionsWithScore.reduce((sum, s) => sum + s.score, 0) / sessionsWithScore.length)
        : 0,
      bestScore: sessionsWithScore.length > 0
        ? Math.max(...sessionsWithScore.map(s => s.score))
        : 0,
      recentSessions: sessions.slice(0, 10).map(s => ({
        mode: s.mode,
        score: s.score,
        hasAnalysis: s.hasAnalysis,
        duration: s.duration,
        messageCount: s.messages.length,
        rubricScores: s.rubric.map(r => ({ item: r.item, score: r.score })),
        sampleMessages: s.messages.slice(0, 8).map(m => `${m.who}: ${m.text}`)
      }))
    };

    // ChatGPT APIに送信
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `あなたは看護教育のメンターです。学生の対話データを分析し、個別のフィードバックと改善アドバイスを提供してください。

【重要】データの説明：
- セッション = 1回の対話練習（開始から評価まで）
- 評価済みセッション数: ${dataSummary.sessionsWithScore}（「評価に進む」ボタンを押して分析が完了したもの）
- 評価未実行セッション数: ${dataSummary.sessionsWithoutScore}（対話は行ったが評価を実行していないもの）
- 合計セッション数: ${dataSummary.totalSessions}

【スコア情報】
- スコアは100点満点（ルーブリック評価項目の合計を100点満点に変換）
- 平均スコア: ${dataSummary.avgScore}点/100点（評価済みセッションのみの平均）
- 最高スコア: ${dataSummary.bestScore}点/100点

${dataSummary.sessionsWithoutScore > 0 ? `\n⚠️ 注意: ${dataSummary.sessionsWithoutScore}個のセッションで「評価に進む」ボタンが押されていません。対話後は必ず評価を実行してください。` : ''}

分析結果はマークダウン形式で、前向きで建設的なトーンで返してください。グラフが必要な場合は、以下のJSON形式で埋め込んでください：

\`\`\`chartjs
{
  "type": "line",
  "data": {
    "labels": ["項目1", "項目2", "項目3"],
    "datasets": [{
      "label": "データ系列名",
      "data": [10, 20, 15],
      "borderColor": "rgb(99, 102, 241)",
      "backgroundColor": "rgba(99, 102, 241, 0.1)"
    }]
  },
  "options": {
    "responsive": true,
    "plugins": {
      "title": {"display": true, "text": "グラフタイトル"}
    }
  }
}
\`\`\`

グラフタイプは "line", "bar", "pie", "radar", "doughnut" が使用できます。インタラクティブなグラフとして表示されます。`
          },
          {
            role: "user",
            content: `以下のあなたの学習データに基づいて分析してください：\n\n${JSON.stringify(dataSummary, null, 2)}\n\n質問: ${query}`
          }
        ],
        temperature: 0.7,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[AI Analysis Student] OpenAI API error:", errorText);
      return res.status(500).json({ ok: false, error: "AI analysis failed" });
    }

    const aiResult = await response.json();
    const analysis = aiResult.choices[0]?.message?.content || "分析結果を取得できませんでした。";

    // AI分析結果をFirestoreに保存
    const analysisDoc = {
      uid,
      query,
      analysis,
      metadata: {
        totalSessions: dataSummary.totalSessions,
        sessionsWithScore: dataSummary.sessionsWithScore,
        sessionsWithoutScore: dataSummary.sessionsWithoutScore,
        avgScore: dataSummary.avgScore,
        bestScore: dataSummary.bestScore
      },
      isAdmin: false,
      createdAt: Date.now()
    };

    const docRef = await db.collection("aiAnalysisHistory").add(analysisDoc);
    console.log(`[AI Analysis Student] Saved history: ${docRef.id}`);

    res.json({
      ok: true,
      analysisId: docRef.id,
      analysis,
      metadata: analysisDoc.metadata
    });

  } catch (error) {
    console.error("[AI Analysis Student] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// 学生用AI分析履歴取得 - 自分の履歴のみ
app.get("/api/student/ai-analysis-history", requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: "Database not ready" });

  try {
    const uid = req.user.uid;

    // 自分のAI分析履歴のみ取得（インデックス不要なクエリに変更）
    const historyQ = await db.collection("aiAnalysisHistory")
      .where("uid", "==", uid)
      .get();

    // メモリ上でフィルタ＆ソート（isAdmin=falseのみ）
    const history = historyQ.docs
      .filter(doc => doc.data().isAdmin === false)
      .map(doc => ({
        doc,
        data: doc.data(),
        createdAt: doc.data().createdAt || 0
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map(item => ({
        id: item.doc.id,
        query: item.data.query,
        analysis: item.data.analysis,
        metadata: item.data.metadata,
        createdAt: item.data.createdAt
      }));

    res.json({ ok: true, history });

  } catch (error) {
    console.error("[AI Analysis History Student] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// 管理者用AI分析履歴取得 - 全履歴
app.get("/api/admin/ai-analysis-history", requireAuth, requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ ok: false, error: "Database not ready" });

  try {
    // 全履歴を取得してメモリ上でフィルタ＆ソート（インデックス不要）
    const historyQ = await db.collection("aiAnalysisHistory").get();

    const history = historyQ.docs
      .filter(doc => doc.data().isAdmin === true)
      .map(doc => ({
        doc,
        data: doc.data(),
        createdAt: doc.data().createdAt || 0
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map(item => ({
        id: item.doc.id,
        uid: item.data.uid,
        query: item.data.query,
        analysis: item.data.analysis,
        metadata: item.data.metadata,
        createdAt: item.data.createdAt
      }));

    res.json({ ok: true, history });

  } catch (error) {
    console.error("[AI Analysis History Admin] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// テキストマイニング分析ロジック
function analyzeConversations(sessions) {
  let totalNurseMessages = 0;
  let totalPatientMessages = 0;
  let totalNurseLength = 0;
  let totalPatientLength = 0;

  let openQuestions = 0;
  let closedQuestions = 0;
  let empathyWords = 0;

  // 頻出語・発話例の収集用
  const nurseWordFreq = {}; // 看護師の単語頻度
  const patientWordFreq = {}; // 患者の単語頻度
  const nurseUtterances = []; // 看護師の発話例
  const patientUtterances = []; // 患者の発話例

  // ストップワード（除外する語）
  const stopWords = new Set([
    "です", "ます", "ません", "でした", "ました", "ない", "なっ", "から", "まで",
    "として", "により", "による", "ために", "ながら", "について", "における",
    "こと", "もの", "よう", "ため", "とき", "とこ", "ところ", "ので", "のに",
    "が", "を", "に", "へ", "と", "で", "や", "は", "も", "か", "の", "ね", "よ",
    "あっ", "いる", "いた", "ある", "あった", "する", "した", "なる", "なった",
    "なり", "ござい", "ござる", "させ", "られ", "れる", "せる", "てる", "ている"
  ]);

  // OPQRST情報収集項目
  const opqrstKeywords = {
    onset: ["いつから", "いつ頃", "何時頃", "始まった", "発症"],
    palliative: ["楽になる", "和らぐ", "軽減", "改善"],
    quality: ["どのような", "どんな", "どういった", "性質"],
    radiation: ["広がる", "放散", "他の場所", "移動"],
    severity: ["程度", "どのくらい", "強さ", "重症"],
    time: ["持続", "続く", "頻度", "繰り返し"]
  };
  const opqrstCoverage = {
    onset: false, palliative: false, quality: false,
    radiation: false, severity: false, time: false
  };

  // キーワード定義
  const openQuestionWords = ["どのように", "どんな", "どういった", "なぜ", "何が", "どうして", "教えて"];
  const empathyKeywords = ["つらい", "大変", "心配", "不安", "苦しい", "辛い", "わかります", "そうですね", "なるほど"];

  for (const session of sessions) {
    const messages = session.messages || [];

    for (const msg of messages) {
      const text = msg.text || "";
      const who = msg.who;

      if (who === "nurse") {
        totalNurseMessages++;
        totalNurseLength += text.length;

        // 発話例を収集（ランダムサンプリング、最大50件）
        if (nurseUtterances.length < 50 && text.length > 5) {
          nurseUtterances.push(text);
        }

        // 単語抽出と頻度カウント
        const words = extractWords(text);
        words.forEach(word => {
          if (!stopWords.has(word) && word.length >= 2) {
            nurseWordFreq[word] = (nurseWordFreq[word] || 0) + 1;
          }
        });

        // 開放質問の検出
        if (openQuestionWords.some(word => text.includes(word))) {
          openQuestions++;
        }
        // 閉鎖質問の検出（「ですか」「ますか」で終わる短文）
        else if ((text.endsWith("ですか") || text.endsWith("ますか")) && text.length < 30) {
          closedQuestions++;
        }

        // 共感語の検出
        empathyKeywords.forEach(word => {
          if (text.includes(word)) empathyWords++;
        });

        // OPQRST情報収集の検出
        for (const [category, keywords] of Object.entries(opqrstKeywords)) {
          if (keywords.some(kw => text.includes(kw))) {
            opqrstCoverage[category] = true;
          }
        }
      } else if (who === "patient") {
        totalPatientMessages++;
        totalPatientLength += text.length;

        // 発話例を収集
        if (patientUtterances.length < 50 && text.length > 5) {
          patientUtterances.push(text);
        }

        // 単語抽出と頻度カウント
        const words = extractWords(text);
        words.forEach(word => {
          if (!stopWords.has(word) && word.length >= 2) {
            patientWordFreq[word] = (patientWordFreq[word] || 0) + 1;
          }
        });
      }
    }
  }

  // 平均値計算
  const avgNurseLength = totalNurseMessages > 0 ? Math.round(totalNurseLength / totalNurseMessages) : 0;
  const avgPatientLength = totalPatientMessages > 0 ? Math.round(totalPatientLength / totalPatientMessages) : 0;

  // 開放質問比率
  const totalQuestions = openQuestions + closedQuestions;
  const openQuestionRatio = totalQuestions > 0 ? Math.round((openQuestions / totalQuestions) * 100) : 0;

  // OPQRST網羅率
  const opqrstCount = Object.values(opqrstCoverage).filter(v => v).length;
  const opqrstCoverageRate = Math.round((opqrstCount / 6) * 100);

  // 頻出語TOP20を抽出
  const nurseTopWords = getTopN(nurseWordFreq, 20);
  const patientTopWords = getTopN(patientWordFreq, 20);

  return {
    nurse: {
      totalMessages: totalNurseMessages,
      avgLength: avgNurseLength,
      openQuestions,
      closedQuestions,
      openQuestionRatio,
      empathyWords,
      opqrstCoverageRate,
      opqrstDetails: opqrstCoverage,
      topWords: nurseTopWords,
      utteranceExamples: nurseUtterances.slice(0, 10) // 代表的な10件
    },
    patient: {
      totalMessages: totalPatientMessages,
      avgLength: avgPatientLength,
      topWords: patientTopWords,
      utteranceExamples: patientUtterances.slice(0, 10) // 代表的な10件
    }
  };
}

// 単語抽出（簡易版）
function extractWords(text) {
  // 句読点・記号で分割
  const cleaned = text.replace(/[、。！？…「」『』（）\(\)]/g, " ");

  const words = [];

  // 文字種パターンで分割（ひらがな、カタカナ、漢字の塊を識別）
  const patterns = [
    // カタカナ連続（2文字以上）
    /[ァ-ヶー]{2,}/g,
    // 漢字連続（1文字以上）+ ひらがな（任意）の組み合わせ（3文字以上の意味のある単語を優先）
    /[一-龯々]{1,}[ぁ-ん]{0,}/g,
    // ひらがな連続（3文字以上の意味のある語のみ）
    /[ぁ-ん]{3,}/g
  ];

  patterns.forEach(pattern => {
    const matches = cleaned.match(pattern);
    if (matches) {
      matches.forEach(match => {
        // 3文字以上、または漢字を含む2文字以上の語を抽出
        if (match.length >= 3 || (match.length >= 2 && /[一-龯々]/.test(match))) {
          words.push(match);
        }
      });
    }
  });

  // 元のトークンも追加（スペースで分割）
  cleaned.split(/\s+/).forEach(token => {
    if (token.length >= 3) {
      words.push(token);
    }
  });

  return words;
}

// 頻度の高い上位N件を取得
function getTopN(freqMap, n) {
  return Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

/* =======================================================================
 * シナリオ患者設定 API + 署名付きURL
 * ======================================================================= */
// 言語正規化（ja/ko/zh/en）
function mapLang(x){
  const t = String(x || "").trim().toLowerCase();
  if (t === "韓国語" || t === "ko" || t === "ko-kr") return "ko";
  if (t === "中国語" || t === "zh" || t === "zh-cn" || t === "zh-tw" || t === "zh-hans" || t === "zh-hant") return "zh";
  if (t === "英語"   || t === "en" || t === "en-us" || t === "en-gb") return "en";
  return "ja";
}
function mapGender(x){ x=String(x||"").trim(); return (x==="男性"||x==="male")?"male":"female"; }
function mapAgeBand(x){ const t=String(x||"").trim(); if(t==="子供"||t==="child")return "child"; if(t==="高齢者"||t==="elderly")return "elderly"; return "adult"; }
function pad3(n){ n = Number(n)||0; return String(n).padStart(3,"0"); }
function autoVideosFor(no){
  const p = pad3(no);
  const base = `/assets/patients/${p}/`;
  // 後方互換のため keys は4つ揃えるが、listening/thinking は idle と同じにする
  return {
    idle:      base + "patient_idle.mp4",
    listening: base + "patient_idle.mp4",
    speaking:  base + "patient_speaking.mp4",
    thinking:  base + "patient_idle.mp4",
  };
}
function normVideos(v){ // 空/未指定や '@auto' を許容
  const out = {};
  if (v && typeof v === "object") {
    for (const k of ["idle","listening","speaking","thinking"]) {
      const s = (v[k]??"").toString().trim();
      if (s) out[k] = s;
    }
  }
  return out;
}


async function nextCounter(key){
  const cref = db.collection("meta").doc("counters");
  let val = 0;
  await db.runTransaction(async tx=>{
    const snap = await tx.get(cref);
    const cur = snap.exists ? (snap.data()[key]||0) : 0;
    val = cur + 1;
    tx.set(cref, { [key]: val }, { merge:true });
  });
  return val;
}

/* ====================== 全般設定 ====================== */

// 設定取得（一般ユーザー用 - 読み取り専用）
app.get("/api/settings", requireAuth, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const snap = await db.collection("settings").doc("global").get();
    const settings = snap.exists ? snap.data() : { practiceTimeLimit: 180, recordingEnabled: true };

    res.json({ ok:true, settings });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// 設定取得（管理者）
app.get("/api/admin/settings", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const snap = await db.collection("settings").doc("global").get();
    const settings = snap.exists ? snap.data() : { 
      practiceTimeLimit: 180, 
      recordingEnabled: true,
      aiCoachLimit: {
        enabled: false,
        period: "weekly",
        maxCount: 3,
        resetDay: 1
      }
    };

    res.json({ ok:true, settings });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// 設定保存（Version 3.0: AI Coach制限追加）
app.post("/api/admin/settings", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const b = req.body||{};
    const practiceTimeLimit = Number.isFinite(b.practiceTimeLimit) && b.practiceTimeLimit > 0 ? b.practiceTimeLimit : 180;
    const recordingEnabled = typeof b.recordingEnabled === 'boolean' ? b.recordingEnabled : true;
    
    // AI Coach制限設定（Version 3.0）
    const aiCoachLimit = b.aiCoachLimit || {};
    const aiCoachLimitSettings = {
      enabled: typeof aiCoachLimit.enabled === 'boolean' ? aiCoachLimit.enabled : false,
      period: aiCoachLimit.period || "weekly",
      maxCount: Number.isFinite(aiCoachLimit.maxCount) && aiCoachLimit.maxCount > 0 ? aiCoachLimit.maxCount : 3,
      resetDay: aiCoachLimit.resetDay || 1
    };

    const settings = {
      practiceTimeLimit,
      recordingEnabled,
      aiCoachLimit: aiCoachLimitSettings,
      updatedAt: Date.now(),
      updatedBy: { uid: req.user?.uid || null, email: req.user?.email || null }
    };

    await db.collection("settings").doc("global").set(settings, { merge: true });

    res.json({ ok:true, settings });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* =======================================================================
 * Version 3.0: AI Coach使用制限
 * ======================================================================= */

// AI Coach使用可否チェック
app.get("/api/ai-coach/check-limit", requireAuth, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const userId = req.user.uid;

    // グローバル設定を取得
    const settingsSnap = await db.collection("settings").doc("global").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const aiCoachLimit = settings.aiCoachLimit || { enabled: false };

    // 制限が無効の場合は常に許可
    if (!aiCoachLimit.enabled) {
      return res.json({ 
        ok: true, 
        allowed: true, 
        unlimited: true,
        message: "AI Coachは無制限に使用できます"
      });
    }

    const period = aiCoachLimit.period || "weekly";
    const maxCount = aiCoachLimit.maxCount || 3;

    // 期間の開始日を計算
    const now = new Date();
    let periodStart;
    
    if (period === "daily") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === "weekly") {
      // 週の開始日（月曜日）を計算
      const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ...
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMonday);
    } else if (period === "monthly") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      // unlimited
      return res.json({ 
        ok: true, 
        allowed: true, 
        unlimited: true,
        message: "AI Coachは無制限に使用できます"
      });
    }

    const periodStartISO = periodStart.toISOString().split('T')[0];

    // 使用履歴を取得
    const usageSnap = await db.collection("aiCoachUsage")
      .where("userId", "==", userId)
      .where("periodStart", "==", periodStartISO)
      .get();

    let currentCount = 0;
    if (!usageSnap.empty) {
      const usageData = usageSnap.docs[0].data();
      currentCount = usageData.count || 0;
    }

    const remaining = maxCount - currentCount;
    const allowed = currentCount < maxCount;

    res.json({ 
      ok: true, 
      allowed,
      currentCount,
      maxCount,
      remaining: Math.max(0, remaining),
      period,
      periodStart: periodStartISO,
      message: allowed 
        ? `AI Coachはあと${remaining}回使用できます（${period === "daily" ? "今日" : period === "weekly" ? "今週" : "今月"}）`
        : `AI Coachの使用回数が上限に達しました（${period === "daily" ? "今日" : period === "weekly" ? "今週" : "今月"}）`
    });

  }catch(e){ 
    console.error('[AI Coach check-limit] Error:', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) }); 
  }
});

// AI Coach使用記録
app.post("/api/ai-coach/record-usage", requireAuth, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const userId = req.user.uid;
    const sessionId = req.body?.sessionId || null;

    // グローバル設定を取得
    const settingsSnap = await db.collection("settings").doc("global").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const aiCoachLimit = settings.aiCoachLimit || { enabled: false };

    // 制限が無効の場合は記録のみ（エラーにしない）
    if (!aiCoachLimit.enabled) {
      return res.json({ 
        ok: true, 
        recorded: false,
        message: "AI Coach制限が無効のため、使用記録は保存されません"
      });
    }

    const period = aiCoachLimit.period || "weekly";
    const maxCount = aiCoachLimit.maxCount || 3;

    // 期間の開始日を計算
    const now = new Date();
    let periodStart;
    
    if (period === "daily") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === "weekly") {
      const dayOfWeek = now.getDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMonday);
    } else if (period === "monthly") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      // unlimited - 記録しない
      return res.json({ 
        ok: true, 
        recorded: false,
        message: "無制限モードのため、使用記録は保存されません"
      });
    }

    const periodStartISO = periodStart.toISOString().split('T')[0];

    // 使用履歴を取得または作成
    const usageQuery = await db.collection("aiCoachUsage")
      .where("userId", "==", userId)
      .where("periodStart", "==", periodStartISO)
      .get();

    const timestamp = Date.now();
    const usageEntry = {
      timestamp,
      sessionId
    };

    if (usageQuery.empty) {
      // 新規作成
      const docId = db.collection("aiCoachUsage").doc().id;
      const newUsage = {
        id: docId,
        userId,
        periodStart: periodStartISO,
        count: 1,
        lastUsedAt: timestamp,
        usageHistory: [usageEntry]
      };
      await db.collection("aiCoachUsage").doc(docId).set(newUsage);
    } else {
      // 既存を更新
      const doc = usageQuery.docs[0];
      const currentData = doc.data();
      const newCount = (currentData.count || 0) + 1;
      const usageHistory = currentData.usageHistory || [];
      usageHistory.push(usageEntry);

      await db.collection("aiCoachUsage").doc(doc.id).set({
        count: newCount,
        lastUsedAt: timestamp,
        usageHistory
      }, { merge: true });
    }

    const remaining = maxCount - (usageQuery.empty ? 1 : (usageQuery.docs[0].data().count || 0) + 1);

    res.json({ 
      ok: true, 
      recorded: true,
      remaining: Math.max(0, remaining),
      message: `AI Coachの使用を記録しました。残り${Math.max(0, remaining)}回`
    });

  }catch(e){ 
    console.error('[AI Coach record-usage] Error:', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) }); 
  }
});

/* ====================== シナリオ設定 ====================== */

// シナリオ設定取得（一般ユーザー - 読み取り専用）
app.get("/api/scenarios/:scenarioId/config", requireAuth, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const scenarioId = req.params.scenarioId;
    const snap = await db.collection("scenarioConfigs").doc(scenarioId).get();

    // デフォルトのキーワード設定
    const defaultConfig = {
      vitalKeywords: {
        temperature: ['体温', '熱', 'お熱', 'temperature', 'temp', '体温を', '体温測定'],
        bloodPressure: ['血圧', 'blood pressure', 'bp', '血圧を', '血圧測定'],
        pulse: ['脈拍', '脈', 'pulse', 'heart rate', '脈を', '脈拍数'],
        respiration: ['呼吸', '呼吸数', 'respiratory', 'respiratory rate', '呼吸を'],
        spo2: ['spo2', 'SpO2', '酸素', 'oxygen', 'saturation', '酸素飽和度']
      },
      examKeywords: {
        inspection: ['視診', '見', '見て', '見ます', 'inspection', 'look', 'look at', 'inspect'],
        palpation: ['触診', '触', '触って', '触ります', 'palpation', 'touch', 'feel', 'press'],
        auscultation: ['聴診', '聴', '聴いて', '聴きます', 'auscultation', 'listen', '聞いて'],
        percussion: ['打診', '叩', '叩いて', '叩きます', 'percussion']
      }
    };

    const config = snap.exists ? snap.data() : defaultConfig;

    res.json({ ok:true, config });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// シナリオ設定保存（管理者のみ）
app.post("/api/admin/scenarios/:scenarioId/config", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const scenarioId = req.params.scenarioId;
    const { vitalKeywords, examKeywords } = req.body;

    const config = {
      vitalKeywords: vitalKeywords || {},
      examKeywords: examKeywords || {},
      updatedAt: Date.now(),
      updatedBy: { uid: req.user?.uid || null, email: req.user?.email || null }
    };

    await db.collection("scenarioConfigs").doc(scenarioId).set(config, { merge: true });

    res.json({ ok:true, config });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* ====================== 患者設定 ====================== */

// 管理一覧（停止含め可）: サーバ側で patientNo ソート
app.get("/api/admin/test-patients", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    const includeDisabled = String(req.query.includeDisabled||req.query.all||"") === "1";
    const q = includeDisabled
      ? db.collection("test_patients")
      : db.collection("test_patients").where("active","==",true);
    const qs = await q.get();
    const arr = qs.docs.map(d=> ({ id:d.id, ...d.data() }))
      .sort((a,b)=> (a.patientNo||0) - (b.patientNo||0));
    res.json({ ok:true, patients: arr });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// 受講者用一覧（有効のみ、Version 3.0: isPublicフィルタ追加）
app.get("/api/test-patients", requireAuth, async (_req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    console.log('[test-patients GET] Fetching active patients...');
    const qs = await db.collection("test_patients").where("active","==",true).get();
    console.log(`[test-patients GET] Found ${qs.docs.length} active patients in database`);
    const arr = qs.docs.map(d=>{
      const p = d.data();
      // Version 3.0: isPublic=trueまたはisPublic未設定（後方互換性）の患者のみ返す
      // isAdminCreated=trueの患者はisPublic=trueが必須
      if (p.isAdminCreated === true && p.isPublic !== true) {
        console.log(`[test-patients GET] Filtering out patient (not public): ${d.id} - ${p.name}`);
        return null; // Admin作成だがisPublic=falseの患者は除外
      }
      return { 
        id: p.id, 
        patientNo: p.patientNo, 
        name: p.name, 
        gender: p.gender, 
        ageBand: p.ageBand, 
        language: p.language, 
        brokenJapanese: p.brokenJapanese || false,
        scenario: p.scenario || "chest",
        profile: p.profile || "", 
        timeLimit: p.timeLimit || 180, 
        videos: p.videos || {},
        expectedVitals: p.expectedVitals || null,
        customVitals: p.customVitals || null
      };
    })
    .filter(p => p !== null) // nullを除外
    .sort((a,b)=> (a.patientNo||0) - (b.patientNo||0));
    console.log(`[test-patients GET] Returning ${arr.length} patients after filtering`);
    console.log(`[test-patients GET] Patient IDs:`, arr.map(p => `${p.id} (${p.name})`));
    res.json({ ok:true, patients: arr });
  }catch(e){ 
    console.error('[test-patients GET] Error:', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) }); 
  }
});

// 作成（全項目必須。動画は "@auto" 指定可＝自動命名適用）
app.post("/api/admin/test-patients", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    const b = req.body||{};
    const now = Date.now();

    const name = (b.name||"").toString().trim();
    const gender = mapGender(b.gender);
    const ageBand = mapAgeBand(b.ageBand);
    const language = mapLang(b.language);
    const profile = (b.profile||"").toString();
    const brokenJapanese = Boolean(b.brokenJapanese);
    const timeLimit = Number.isFinite(b.timeLimit) && b.timeLimit > 0 ? b.timeLimit : 180;
    if (!name || !profile || !gender || !ageBand || !language) {
      return res.status(400).json({ ok:false, error:"required fields missing (name/gender/ageBand/language/profile)" });
    }

    const patientNo = await nextCounter("patientNo");
    const id = db.collection("test_patients").doc().id;

    const auto = autoVideosFor(patientNo);
    const vIn = normVideos(b.videos);
    const videos = {
      idle:      vIn.idle      || auto.idle,
      listening: vIn.listening || auto.listening,
      speaking:  vIn.speaking  || auto.speaking,
      thinking:  vIn.thinking  || auto.thinking,
    };

    const doc = {
      id, patientNo,
      name, gender, ageBand, language, profile,
      brokenJapanese,
      timeLimit,
      videos,
      active: true, status:"active",
      createdAt: now, updatedAt: now,
      createdBy: { uid:req.user?.uid || null, email:req.user?.email || null },
      updatedBy: { uid:req.user?.uid || null, email:req.user?.email || null },
    };
    await db.collection("test_patients").doc(id).set(doc);
    res.json({ ok:true, patient: doc });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// 更新（全項目必須。videos.*='@auto' でその項目のみ再命名）
app.patch("/api/admin/test-patients/:id", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    const id = req.params.id;
    const snap = await db.collection("test_patients").doc(id).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"not found" });
    const cur = snap.data()||{};
    const b = req.body||{};

    const name = (b.name!=null) ? String(b.name).trim() : cur.name;
    const gender = (b.gender!=null) ? mapGender(b.gender) : cur.gender;
    const ageBand = (b.ageBand!=null) ? mapAgeBand(b.ageBand) : cur.ageBand;
    const language = (b.language!=null) ? mapLang(b.language) : cur.language;
    const profile = (b.profile!=null) ? String(b.profile) : cur.profile;
    const brokenJapanese = (b.brokenJapanese!=null) ? Boolean(b.brokenJapanese) : (cur.brokenJapanese || false);
    const timeLimit = (b.timeLimit!=null && Number.isFinite(b.timeLimit) && b.timeLimit > 0) ? b.timeLimit : (cur.timeLimit || 180);

    let videos = { ...(cur.videos||{}) };
    if (b.videos!=null) {
      const auto = autoVideosFor(cur.patientNo);
      for (const k of ["idle","listening","speaking","thinking"]) {
        if (k in b.videos) {
          const v = String(b.videos[k]||"").trim();
          videos[k] = (v==="" || v==="@auto") ? auto[k] : v;
        }
      }
    } else if (!videos || !videos.idle || !videos.speaking) {
      // videos が未整備なら自動補完
      videos = autoVideosFor(cur.patientNo);
    }

    const patch = {
      name, gender, ageBand, language, profile, brokenJapanese, timeLimit, videos,
      updatedAt: Date.now(),
      updatedBy:{ uid:req.user.uid, email:req.user.email||null }
    };
    if (typeof b.active === "boolean") { patch.active = b.active; patch.status = b.active ? "active" : "stopped"; }

    await db.collection("test_patients").doc(id).set(patch, { merge: true });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error: String(e?.message||e) }); }
});

// 署名付きURL（PUT）発行
app.post("/api/admin/uploads/sign", requireAuth, requireAdmin, async (req, res)=>{
  try{
    if (!storageReady || !ASSETS_BUCKET) return res.status(503).json({ ok:false, error:"storage not configured (ASSETS_BUCKET)" });
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });

    const { patientId, type = "idle", contentType = "video/mp4" } = req.body || {};
    const kinds = ["idle","listening","speaking","thinking"];
    const t = String(type||"").toLowerCase();
    if (!patientId || !kinds.includes(t)) return res.status(400).json({ ok:false, error:"invalid params" });

    const snap = await db.collection("test_patients").doc(patientId).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"patient not found" });
    const p = snap.data() || {};
    const no = p.patientNo;
    if (!Number.isFinite(no)) return res.status(400).json({ ok:false, error:"patientNo missing" });

    const key = `patients/patient_${pad3(no)}_${t}.mp4`;
    const file = storage.bucket(ASSETS_BUCKET).file(key);

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });

    const publicUrl = `https://storage.googleapis.com/${ASSETS_BUCKET}/${key}`;
    res.json({ ok:true, uploadUrl:url, publicUrl, objectKey:key, bucket:ASSETS_BUCKET, contentType });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

/* =======================================================================
 * Version 3.0: Admin患者作成（症状別モードから移行）
 * ======================================================================= */

// POST /api/admin/patients/generate - Admin専用患者プロフィール生成（GPT-4o）
app.post("/api/admin/patients/generate", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok: false, error: "OpenAI API key not configured" });

    const { symptomKeywords, language, brokenJapanese } = req.body || {};

    if (!symptomKeywords || !symptomKeywords.trim()) {
      return res.status(400).json({ ok: false, error: "symptomKeywords is required" });
    }
    if (!language) {
      return res.status(400).json({ ok: false, error: "language is required" });
    }

    console.log(`[admin/patients/generate] Admin generating patient with keywords: ${symptomKeywords}, language: ${language}, brokenJapanese: ${brokenJapanese}`);

    // OpenAI GPT-4oで患者プロフィール生成
    const languageNames = {
      ja: "日本語",
      en: "英語",
      ko: "韓国語",
      zh: "中国語",
      th: "タイ語"
    };
    
    const prompt = `あなたは医療シミュレーション用の患者プロフィール生成AIです。

以下の症状キーワードをもとに、リアルな患者プロフィールを作成してください。

【症状キーワード】
${symptomKeywords}

【患者の会話言語】
${languageNames[language] || language}
※注意：患者は${languageNames[language]}で話しますが、プロフィール情報は必ず日本語で記述してください。

【生成する情報】
1. 氏名（${languageNames[language]}の一般的な名前）
2. 年齢（症状に適した年齢、数値のみ）
3. 性別（男性 or 女性）
4. 年齢帯（子供、大人、高齢者のいずれか）
5. シナリオ（症状から適切なものを選択：chest（胸痛）、head（頭痛）、abdomen（腹痛）、breath（呼吸困難））
6. 詳細プロフィール（必ず日本語で200-300文字程度）
   - 主訴
   - 現病歴
   - 既往歴（関連するもの）
   - 生活背景
   - 現在の症状の詳細

【出力形式】（必ずこの形式で日本語で回答してください）
氏名: [名前]
年齢: [数値のみ]
性別: [男性 または 女性]
年齢帯: [子供 または 大人 または 高齢者]
シナリオ: [chest または head または abdomen または breath]
プロフィール: [日本語で詳細な説明]

リアルで臨床的に妥当な患者を作成してください。プロフィールは必ず日本語で記述してください。`;

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: '医療シミュレーション用の患者プロフィールを生成する専門AIです。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 1000
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('[admin/patients/generate] OpenAI API error:', errorText);
      return res.status(500).json({ ok: false, error: 'OpenAI API error' });
    }

    const openaiData = await openaiResponse.json();
    const generatedText = openaiData.choices[0]?.message?.content || '';

    console.log('[admin/patients/generate] Generated text:', generatedText);

    // パース
    const nameMatch = generatedText.match(/氏名[：:]\s*(.+?)(?:\n|$)/);
    const ageMatch = generatedText.match(/年齢[：:]\s*(\d+)/);
    const ageBandMatch = generatedText.match(/年齢帯[：:]\s*(子供|大人|高齢者)/);
    const scenarioMatch = generatedText.match(/シナリオ[：:]\s*(chest|head|abdomen|breath)/);
    const aiProfileMatch = generatedText.match(/AI用プロフィール[：:]\s*([\s\S]+?)(?=\n表示用プロフィール[：:]|\n\n|$)/);
    const displayProfileMatch = generatedText.match(/表示用プロフィール[：:]\s*([\s\S]+?)(?:\n\n|$)/);

    const name = nameMatch ? nameMatch[1].trim() : '患者';
    const age = ageMatch ? parseInt(ageMatch[1]) : 40;
    const ageBandText = ageBandMatch ? ageBandMatch[1] : "大人";
    const ageBand = ageBandText === "子供" ? "child" : ageBandText === "高齢者" ? "elderly" : "adult";
    const scenario = scenarioMatch ? scenarioMatch[1] : "chest";
    const profileText = aiProfileMatch ? aiProfileMatch[1].trim() : generatedText;
    const displayProfileText = displayProfileMatch ? displayProfileMatch[1].trim() : profileText;

    res.json({
      ok: true,
      profile: {
        name,
        age,
        ageBand,
        scenario,
        profileText,
        displayProfileText
      }
    });

  } catch (e) {
    console.error('[admin/patients/generate] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/admin/patients - Admin患者作成（保存）
app.post("/api/admin/patients", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    
    const b = req.body || {};
    const now = Date.now();

    const name = (b.name || "").toString().trim();
    const age = Number.isFinite(b.age) && b.age > 0 ? b.age : 40;
    const gender = mapGender(b.gender);
    const ageBand = mapAgeBand(b.ageBand);
    const language = mapLang(b.language);
    const profile = (b.profile || "").toString();
    const displayProfile = (b.displayProfile || "").toString();
    const symptomKeywords = (b.symptomKeywords || "").toString().trim();
    const brokenJapanese = Boolean(b.brokenJapanese);
    const timeLimit = Number.isFinite(b.timeLimit) && b.timeLimit > 0 ? b.timeLimit : 180;
    const scenario = b.scenario || "chest";
    const isAdminCreated = Boolean(b.isAdminCreated);
    const isPublic = Boolean(b.isPublic);
    
    // Version 3.42: 想定バイタル異常とカスタムバイタル項目を保存
    const expectedVitals = b.expectedVitals || null;
    const customVitals = b.customVitals || null;

    if (!name || !profile || !displayProfile || !symptomKeywords) {
      return res.status(400).json({ ok: false, error: "name, profile, displayProfile, and symptomKeywords are required" });
    }

    const patientNo = await nextCounter("patientNo");
    const id = db.collection("test_patients").doc().id;

    const auto = autoVideosFor(patientNo);
    const videos = {
      idle: auto.idle,
      listening: auto.listening,
      speaking: auto.speaking,
      thinking: auto.thinking,
    };

    const doc = {
      id,
      patientNo,
      name,
      age,
      gender,
      ageBand,
      language,
      profile,
      displayProfile,
      symptomKeywords,
      brokenJapanese,
      scenario,
      timeLimit,
      expectedVitals,
      customVitals,
      videos,
      isAdminCreated,
      isPublic,
      active: true,
      status: "active",
      usedCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: { uid: req.user?.uid || null, email: req.user?.email || null },
      updatedBy: { uid: req.user?.uid || null, email: req.user?.email || null },
    };

    await db.collection("test_patients").doc(id).set(doc);
    res.json({ ok: true, patient: doc });
  } catch (e) {
    console.error('[admin/patients POST] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/admin/patients - Admin患者一覧（isAdminCreated=trueでフィルタ可能）
app.get("/api/admin/patients", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    
    const isAdminCreated = String(req.query.isAdminCreated || "") === "true";
    
    let q = db.collection("test_patients");
    if (isAdminCreated) {
      q = q.where("isAdminCreated", "==", true);
    }
    
    const qs = await q.get();
    const arr = qs.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.patientNo || 0) - (b.patientNo || 0));
    
    res.json({ ok: true, patients: arr });
  } catch (e) {
    console.error('[admin/patients GET] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// PATCH /api/admin/patients/:id - Admin患者更新
app.patch("/api/admin/patients/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    
    const id = req.params.id;
    const snap = await db.collection("test_patients").doc(id).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "patient not found" });
    
    const cur = snap.data() || {};
    const b = req.body || {};

    const name = (b.name != null) ? String(b.name).trim() : cur.name;
    const age = (b.age != null && Number.isFinite(b.age) && b.age > 0) ? b.age : cur.age;
    const gender = (b.gender != null) ? mapGender(b.gender) : cur.gender;
    const ageBand = (b.ageBand != null) ? mapAgeBand(b.ageBand) : cur.ageBand;
    const language = (b.language != null) ? mapLang(b.language) : cur.language;
    const profile = (b.profile != null) ? String(b.profile) : cur.profile;
    const symptomKeywords = (b.symptomKeywords != null) ? String(b.symptomKeywords).trim() : cur.symptomKeywords;
    const brokenJapanese = (b.brokenJapanese != null) ? Boolean(b.brokenJapanese) : (cur.brokenJapanese || false);
    const timeLimit = (b.timeLimit != null && Number.isFinite(b.timeLimit) && b.timeLimit > 0) ? b.timeLimit : (cur.timeLimit || 180);
    const scenario = (b.scenario != null) ? String(b.scenario) : (cur.scenario || "chest");
    
    // Version 3.42: 想定バイタル異常とカスタムバイタル項目を更新
    const expectedVitals = (b.expectedVitals != null) ? b.expectedVitals : (cur.expectedVitals || null);
    const customVitals = (b.customVitals != null) ? b.customVitals : (cur.customVitals || null);

    const patch = {
      name,
      age,
      gender,
      ageBand,
      language,
      profile,
      symptomKeywords,
      brokenJapanese,
      scenario,
      timeLimit,
      expectedVitals,
      customVitals,
      updatedAt: Date.now(),
      updatedBy: { uid: req.user.uid, email: req.user.email || null }
    };

    await db.collection("test_patients").doc(id).set(patch, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin/patients PATCH] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// DELETE /api/admin/patients/:id - Admin患者削除（Version 3.54: 削除確認を強化）
app.delete("/api/admin/patients/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    
    const id = req.params.id;
    console.log(`[admin/patients DELETE] ========== 削除処理開始 ==========`);
    console.log(`[admin/patients DELETE] Patient ID: ${id}`);
    
    const snap = await db.collection("test_patients").doc(id).get();
    if (!snap.exists) {
      console.log(`[admin/patients DELETE] ✗ Patient not found: ${id}`);
      return res.status(404).json({ ok: false, error: "patient not found" });
    }
    
    const patientData = snap.data();
    console.log(`[admin/patients DELETE] 削除前の患者データ:`, { 
      id, 
      name: patientData?.name, 
      patientNo: patientData?.patientNo,
      active: patientData?.active,
      isPublic: patientData?.isPublic
    });
    
    // Firestoreから削除
    await db.collection("test_patients").doc(id).delete();
    console.log(`[admin/patients DELETE] ✓ Firestore delete() 完了`);
    
    // 削除確認：もう一度取得して存在しないことを確認
    const verifySnap = await db.collection("test_patients").doc(id).get();
    if (verifySnap.exists) {
      console.error(`[admin/patients DELETE] ✗✗✗ 削除失敗！データがまだ存在します`);
      throw new Error("削除に失敗しました：データが残っています");
    }
    
    console.log(`[admin/patients DELETE] ✓✓✓ 削除成功確認完了: PatientNo.${patientData?.patientNo} (${patientData?.name})`);
    console.log(`[admin/patients DELETE] ========== 削除処理完了 ==========`);
    
    res.json({ 
      ok: true, 
      message: `患者No.${patientData?.patientNo}を削除しました`,
      deletedPatient: {
        id,
        name: patientData?.name,
        patientNo: patientData?.patientNo
      }
    });
  } catch (e) {
    console.error('[admin/patients DELETE] ✗✗✗ Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =======================================================================
 * 管理者: ユーザー
 * ======================================================================= */
app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error: "db not ready" });
    const qs = await db.collection("users").orderBy("userNo").get();
    res.json({ ok: true, users: qs.docs.map(d => ({ uid: d.id, ...d.data() })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    
    const updates = {};
    
    // role の更新
    if (req.body?.role !== undefined) {
      const role = String(req.body.role).toLowerCase();
      if (!["user","admin"].includes(role)) return res.status(400).json({ ok:false, error:"invalid role" });
      updates.role = role;
    }

    // name（名前）の更新
    if (req.body?.name !== undefined) {
      updates.name = String(req.body.name || "").trim();
    }

    // remarks（備考）の更新
    if (req.body?.remarks !== undefined) {
      updates.remarks = String(req.body.remarks || "");
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok:false, error:"no valid fields to update" });
    }
    
    await db.collection("users").doc(req.params.uid).set(updates, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// DELETE /api/admin/users/:uid - ユーザー削除
app.delete("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    
    const uid = req.params.uid;
    if (!uid) return res.status(400).json({ ok:false, error:"uid required" });
    
    console.log(`[DELETE /api/admin/users/${uid}] Admin ${req.user.uid} deleting user ${uid}`);
    
    // 1. ユーザーのセッションを削除
    const sessionsSnapshot = await db.collection("sessions").where("uid", "==", uid).get();
    const batch = db.batch();
    sessionsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    console.log(`[DELETE user] Deleted ${sessionsSnapshot.size} sessions for user ${uid}`);
    
    // 2. ユーザードキュメントを削除
    await db.collection("users").doc(uid).delete();
    console.log(`[DELETE user] Deleted user document for ${uid}`);
    
    // 3. Firebase Authentication からユーザーを削除
    if (adminReady) {
      try {
        await admin.auth().deleteUser(uid);
        console.log(`[DELETE user] Deleted Firebase Auth user ${uid}`);
      } catch (authErr) {
        console.warn(`[DELETE user] Failed to delete Firebase Auth user ${uid}:`, authErr.message);
        // 認証削除に失敗しても続行（Firestoreデータは削除済み）
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error(`[DELETE /api/admin/users/:uid] Error:`, e);
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// DELETE /api/admin/sessions/:sessionId - セッション削除
app.delete("/api/admin/sessions/:sessionId", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok:false, error:"db not ready" });
    
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ ok:false, error:"sessionId required" });
    
    console.log(`[DELETE /api/admin/sessions/${sessionId}] Admin ${req.user.uid} deleting session`);
    
    // セッションを削除
    await db.collection("sessions").doc(sessionId).delete();
    console.log(`[DELETE session] Deleted session ${sessionId}`);
    
    res.json({ ok: true });
  } catch (e) {
    console.error(`[DELETE /api/admin/sessions/:sessionId] Error:`, e);
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

/* =======================================================================
 * 患者生成機能 (Version 2.01)
 * ======================================================================= */

// POST /api/generate-patient
// 症状キーワードから患者プロフィールを生成
app.post("/api/generate-patient", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok: false, error: "OpenAI API key not configured" });

    const { symptomKeywords, language } = req.body || {};
    const userId = req.user.uid;

    if (!symptomKeywords || !symptomKeywords.trim()) {
      return res.status(400).json({ ok: false, error: "symptomKeywords is required" });
    }
    if (!language) {
      return res.status(400).json({ ok: false, error: "language is required" });
    }

    console.log(`[generate-patient] User ${userId} generating patient with keywords: ${symptomKeywords}`);

    // OpenAI GPT-4で患者プロフィール生成
    const languageNames = {
      ja: "日本語",
      en: "英語",
      ko: "韓国語",
      th: "タイ語（チェンマイ方言）"
    };
    
    const prompt = `あなたは医療シミュレーション用の患者プロフィール生成AIです。

以下の症状キーワードをもとに、リアルな患者プロフィールを作成してください。

【症状キーワード】
${symptomKeywords}

【患者の言語】
${languageNames[language] || language}

【生成する情報】
1. 氏名（${languageNames[language]}の一般的な名前）
2. 年齢（症状に適した年齢、数値のみ）
3. 性別（男性 or 女性）
4. 詳細プロフィール（200-300文字程度）
   - 主訴
   - 現病歴
   - 既往歴（関連するもの）
   - 生活背景
   - 現在の症状の詳細

【出力形式】（必ずこの形式で回答してください）
氏名: [名前]
年齢: [数値のみ]
性別: [男性 または 女性]
プロフィール: [詳細な説明]

リアルで臨床的に妥当な患者を作成してください。`;

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: '医療シミュレーション用の患者プロフィールを生成する専門AIです。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 1000
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('[generate-patient] OpenAI API error:', errorText);
      return res.status(500).json({ ok: false, error: 'OpenAI API error' });
    }

    const openaiData = await openaiResponse.json();
    const generatedText = openaiData.choices[0]?.message?.content || '';

    console.log('[generate-patient] Generated text:', generatedText);

    // パース
    const nameMatch = generatedText.match(/氏名[：:]\s*(.+?)(?:\n|$)/);
    const ageMatch = generatedText.match(/年齢[：:]\s*(\d+)/);
    const genderMatch = generatedText.match(/性別[：:]\s*(男性|女性)/);
    const profileMatch = generatedText.match(/プロフィール[：:]\s*([\s\S]+?)(?:\n\n|$)/);

    const name = nameMatch ? nameMatch[1].trim() : '患者';
    const age = ageMatch ? parseInt(ageMatch[1]) : 40;
    const gender = genderMatch ? genderMatch[1] : '不明';
    const profileText = profileMatch ? profileMatch[1].trim() : generatedText;

    // Firestoreに保存
    const patientId = db.collection('generatedPatients').doc().id;
    const now = Date.now();

    const patientData = {
      id: patientId,
      userId: userId,
      createdAt: now,
      lastUsedAt: now,
      usedCount: 0,
      symptomKeywords: symptomKeywords.trim(),
      language: language,
      generatedProfile: {
        name: name,
        age: age,
        gender: gender,
        profileText: profileText
      }
    };

    await db.collection('generatedPatients').doc(patientId).set(patientData);

    console.log(`[generate-patient] Patient created: ${patientId}`);

    res.json({
      ok: true,
      patient: patientData
    });

  } catch (e) {
    console.error('[generate-patient] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/generated-patients
// ログインユーザーが作成した患者一覧を取得
app.get("/api/generated-patients", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });

    const userId = req.user.uid;
    console.log('[generated-patients] Fetching for userId:', userId);
    
    // インデックスエラー回避: orderByを一時的に削除
    const querySnapshot = await db.collection('generatedPatients')
      .where('userId', '==', userId)
      .get();

    console.log('[generated-patients] Found documents:', querySnapshot.size);

    // クライアント側でソート
    const patients = querySnapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100);

    console.log('[generated-patients] Returning patients:', patients.length);

    res.json({
      ok: true,
      patients: patients
    });

  } catch (e) {
    console.error('[generated-patients] Error:', e);
    console.error('[generated-patients] Error stack:', e.stack);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/admin/generated-patients
// 管理者用：全ユーザーの生成患者一覧を取得
app.get("/api/admin/generated-patients", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });

    console.log('[admin/generated-patients] Fetching all patients');

    // インデックスエラー回避: orderByなしで取得
    const querySnapshot = await db.collection('generatedPatients')
      .get();
    
    console.log('[admin/generated-patients] Found documents:', querySnapshot.size);

    // クライアント側でソート（最新順）
    const sortedPatients = querySnapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 500);

    // ユーザー情報も取得
    const userIds = [...new Set(sortedPatients.map(p => p.userId))];
    const userMap = {};
    
    for (const uid of userIds) {
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          userMap[uid] = userData.name || userData.email || uid;
        } else {
          userMap[uid] = uid;
        }
      } catch (e) {
        userMap[uid] = uid;
      }
    }

    // 患者データにユーザー名を追加
    const patientsWithUserInfo = sortedPatients.map(p => ({
      ...p,
      userName: userMap[p.userId] || p.userId
    }));

    console.log('[admin/generated-patients] Returning patients:', patientsWithUserInfo.length);

    res.json({
      ok: true,
      patients: patientsWithUserInfo
    });

  } catch (e) {
    console.error('[admin/generated-patients] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// PATCH /api/generated-patients/:id/use
// 患者を使用した際に使用回数をインクリメント
app.patch("/api/generated-patients/:id/use", requireAuth, async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: "db not ready" });

    const patientId = req.params.id;
    const userId = req.user.uid;

    const patientRef = db.collection('generatedPatients').doc(patientId);
    const patientDoc = await patientRef.get();

    if (!patientDoc.exists) {
      return res.status(404).json({ ok: false, error: "Patient not found" });
    }

    const patientData = patientDoc.data();
    
    // セキュリティチェック: 自分が作成した患者のみ使用可能
    if (patientData.userId !== userId) {
      return res.status(403).json({ ok: false, error: "Access denied" });
    }

    await patientRef.update({
      usedCount: (patientData.usedCount || 0) + 1,
      lastUsedAt: Date.now()
    });

    res.json({ ok: true });

  } catch (e) {
    console.error('[generated-patients/use] Error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============ 404(JSON) ============ */
/* 404 は必ず最後に置くこと（これより下にAPIを追加しない） */
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

/* ============ 起動 ============ */
const port = process.env.PORT || 8080;

console.log("[server] Starting server...");
console.log("[server] __dirname =", __dirname);
console.log("[server] publicRoot =", publicRoot);
console.log("[server] PORT =", port);

app.listen(port, "0.0.0.0", () => {
  console.log(`[server] ✓✓✓ Server is listening on 0.0.0.0:${port} ✓✓✓`);
  console.log(`[server] APP_VERSION=${APP_VERSION}`);
  console.log(`[server] AUTH_PROJECT_ID=${AUTH_PROJECT_ID}`);
  console.log(`[server] DB_PROJECT_ID=${DB_PROJECT_ID}`);
  console.log(`[server] OPENAI_API_KEY set: ${OPENAI_API_KEY ? "yes" : "no"}`);
  console.log(`[server] ASSETS_BUCKET=${ASSETS_BUCKET || "(not set)"}`);
  console.log(`[server] Dependencies will initialize asynchronously...`);
}).on("error", (err) => {
  console.error("[server] ✗✗✗ Failed to start server:", err);
  process.exit(1);
});