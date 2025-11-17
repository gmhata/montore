import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, signOut, getIdToken,
  setPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

// MONTORE Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBo3TDmGkYCtuPnTYxIPbB-AF02p86jpBI",
  authDomain: "montore-e35be.firebaseapp.com",
  projectId: "montore-e35be",
  storageBucket: "montore-e35be.firebasestorage.app",
  messagingSenderId: "327159500498",
  appId: "1:327159500498:web:f104de2e4a9d4f041f270b",
  measurementId: "G-TTK7RQRZKB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// 自動ログインを抑止（永続なし）
(async()=>{ try{ await setPersistence(auth, inMemoryPersistence); }catch{} })();

// 外部公開: IDトークン
window.getIdTokenAsync = async () => {
  const u = auth.currentUser;
  if (!u) return null;
  return await getIdToken(u, true);
};

// 手動ログインフラグ（redirect後も保持）
const MANUAL_KEY = "__manualLoginTriggered";
const setManual = (v)=> sessionStorage.setItem(MANUAL_KEY, v ? "1" : "0");
const getManual = ()=> sessionStorage.getItem(MANUAL_KEY) === "1";

// UI参照（存在しなければスキップ）
const $ = (id)=> document.getElementById(id);
const statusEl = $("authStatus");
const btnLogin  = $("btnLogin");
const btnLogout = $("btnLogout");
const debug     = $("debug");

// ボタン表示切替
function setButtons(ok){
  if (!btnLogin || !btnLogout) return;
  btnLogin.style.display  = ok ? "none" : "";
  btnLogout.style.display = ok ? "" : "none";
}

// ログインは「ボタン押下のみ」
if (btnLogin){
  btnLogin.addEventListener("click", async ()=>{
    try{
      setManual(true);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    }catch(e){
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithRedirect(auth, provider);
    }
  });
  getRedirectResult(auth).catch(()=>{});
}
if (btnLogout){
  btnLogout.addEventListener("click", async ()=>{
    try{ await signOut(auth); }catch(e){ alert("ログアウト失敗: " + (e.message||e)); }
    setManual(false);
  });
}

// 状態変化
onAuthStateChanged(auth, async (u)=>{
  // 手動以外のサインインは拒否（自動ログイン抑止）
  if (u && !getManual()){
    try{ await signOut(auth); }catch{}
    u = null;
  }
  if (statusEl) statusEl.textContent = u ? ("ログイン中: " + (u.displayName||u.email||u.uid)) : "未ログイン";
  setButtons(!!u);
  if (!u && debug) debug.textContent = "";

  // 現在の状態をグローバルにも保持（後続JSの初期判定用）
  window.__authSignedIn = !!u;

  // 画面へ確実に通知（リスナー登録より先に発火しないよう、tick遅延）
  setTimeout(()=>{
    window.dispatchEvent(new CustomEvent("auth-state", { detail:{ signedIn: !!u, user: u||null }}));
  }, 0);

  // ログイン済になったらフラグはクリア（次回は自動サインインさせない）
  if (u) setManual(false);
});