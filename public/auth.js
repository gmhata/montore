import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, signOut, getIdToken,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

// Firebase Configuration - loaded from environment/build time
// ⚠️ セキュリティ: API Keyは公開リポジトリにコミットしない
const firebaseConfig = window.FIREBASE_CONFIG || {
  apiKey: "PLACEHOLDER_WILL_BE_REPLACED",
  authDomain: "PLACEHOLDER_PROJECT_ID.firebaseapp.com",
  projectId: "PLACEHOLDER_PROJECT_ID",
  storageBucket: "PLACEHOLDER_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PLACEHOLDER",
  appId: "PLACEHOLDER"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ブラウザセッションで永続化（ブラウザを閉じるとログアウト）
(async()=>{ try{ await setPersistence(auth, browserSessionPersistence); }catch{} })();

// 外部公開: IDトークン
window.getIdTokenAsync = async () => {
  const u = auth.currentUser;
  if (!u) return null;
  return await getIdToken(u, true);
};

// 手動ログインフラグ（redirect後も保持）
const MANUAL_KEY = "__manualLoginTriggered";
const setManual = (v)=> sessionStorage.setItem(MANUAL_KEY, v ? "1" : "0");
const isManual = ()=> sessionStorage.getItem(MANUAL_KEY) === "1";

// auth状態監視
onAuthStateChanged(auth, async (user)=> {
  console.log("[auth] state changed:", user ? user.email : "signed out");
  
  if (user && window.onUserSignedIn) {
    await window.onUserSignedIn(user);
  } else if (!user && window.onUserSignedOut) {
    await window.onUserSignedOut();
  }
});

// リダイレクト結果の処理
(async()=>{
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) {
      console.log("[auth] redirect result:", result.user.email);
      setManual(true);
    }
  } catch(e) {
    console.warn("[auth] redirect result error:", e?.message || e);
  }
})();

// ログイン関数
window.firebaseSignInWithPopup = async () => {
  const provider = new GoogleAuthProvider();
  setManual(true);
  try {
    const result = await signInWithPopup(auth, provider);
    console.log("[auth] popup login success:", result.user.email);
    return result.user;
  } catch(e) {
    console.error("[auth] popup error:", e?.message || e);
    throw e;
  }
};

window.firebaseSignInWithRedirect = async () => {
  const provider = new GoogleAuthProvider();
  setManual(true);
  await signInWithRedirect(auth, provider);
};

window.firebaseSignOut = async () => {
  setManual(false);
  await signOut(auth);
  console.log("[auth] signed out");
};

console.log("[auth.js] Firebase Auth initialized");
