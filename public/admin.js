// public/admin.js
// 安定版（動画アップロードUIなし・NPE防止・確実にタブが動く）
// - 左メニュー（ユーザー管理/学修状況/患者設定/会話ログ分析）で確実に切替
// - 旧サーバ互換: test-patients で videos 必須なら '@auto' を補完して再送
// - 患者一覧の描画で DOM 参照NPEを回避（querySelectorの前に存在確認）

"use strict";

const $ = (id)=> document.getElementById(id);
async function getIdToken(){ return await (window.getIdTokenAsync ? window.getIdTokenAsync() : null); }
const esc = (s)=> String(s ?? "").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const fmtDur = (sec)=>{ const s=Math.max(0,Math.floor(Number(sec||0))); const m=Math.floor(s/60), r=s%60; return `${m}:${String(r).padStart(2,"0")}`; };

// CSV ダウンロードユーティリティ
function downloadCSV(filename, csvContent) {
  const bom = "\uFEFF"; // UTF-8 BOM for Excel compatibility
  const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeCSV(value) {
  if (value == null) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function showPane(id){
  const ids = ["pane-settings","pane-users","pane-patient-creation","pane-stats","pane-scenarios","pane-analysis","pane-ai-analysis"];
  for(const pid of ids){
    const el = $(pid); if (!el) continue;
    el.style.display = (pid===id) ? "" : "none";
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  // 左メニュー: タブ切替
  document.querySelectorAll(".admin-menu[data-target]").forEach(btn=>{
    btn.addEventListener("click", (ev)=>{
      ev.preventDefault();
      const target = btn.getAttribute("data-target");
      showPane(target);
      if (target === "pane-settings")            mountSettingsPane();
      if (target === "pane-users")               refreshUsers();
      if (target === "pane-patient-creation")    mountPatientCreationPane();
      if (target === "pane-stats")               mountLearningPane();
      if (target === "pane-scenarios")           mountScenariosPane();
      if (target === "pane-analysis")            mountAnalysisPane();
      if (target === "pane-ai-analysis")         mountAIAnalysisPane();
    });
  });

  // 既定は全般設定
  showPane("pane-settings");
  mountSettingsPane();
});

/* ====================== ユーザー管理 ====================== */
async function refreshUsers(){
  const pane = $("pane-users"); if (!pane) return;
  try{
    pane.innerHTML = `
      <h3>ユーザー管理</h3>
      <div class="muted small" style="margin-bottom:.5rem">権限：一般／管理者 を切り替えできます。</div>
      <div class="muted">読み込み中…</div>
    `;
    const t = await getIdToken();
    if (!t) { pane.innerHTML += `<div class="err">未ログインです</div>`; return; }

    const r = await fetch("/api/admin/users", { headers:{ Authorization:"Bearer "+t } });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    const rows = Array.isArray(j.users) ? j.users : [];
    console.log('[refreshUsers] Fetched users from Firestore:', rows.map(u => ({email: u.email, role: u.role})));
    pane.innerHTML = `
      <h3>ユーザー管理</h3>
      <div class="muted small" style="margin-bottom:.5rem">権限：一般／管理者 を切り替えできます。名前・備考欄をダブルクリックで編集できます。</div>
      <div style="overflow:auto">
        <table class="tbl" id="userTable">
          <thead>
            <tr><th style="width:80px">UserNo</th><th>Mail</th><th>名前</th><th style="width:160px">権限</th><th style="min-width:200px">備考</th><th style="width:80px">削除</th></tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows.map(u=>`
                    <tr data-uid="${u.uid}">
                      <td>${u.userNo ?? "-"}</td>
                      <td>${esc(u.email ?? "")}</td>
                      <td class="name-cell" style="cursor:text;position:relative" data-original="${esc(u.name ?? "")}">${esc(u.name ?? "")}</td>
                      <td>
                        <select class="roleSel">
                          <option value="user" ${u.role==="user"?"selected":""}>一般</option>
                          <option value="admin" ${u.role==="admin"?"selected":""}>管理者</option>
                        </select>
                      </td>
                      <td class="remarks-cell" style="cursor:text;position:relative" data-original="${esc(u.remarks ?? "")}">${esc(u.remarks ?? "")}</td>
                      <td><button class="delete-user-btn" data-uid="${u.uid}" data-email="${esc(u.email ?? "")}" style="background:#dc2626;color:#fff;padding:6px 12px;border-radius:4px;font-size:12px;cursor:pointer;border:none">削除</button></td>
                    </tr>
                  `).join("")
                : `<tr><td colspan="6" class="muted">ユーザーが見つかりません。</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `;

    pane.querySelectorAll(".roleSel").forEach(sel=>{
      sel.addEventListener("change", async ()=>{
        const tr = sel.closest("tr"); 
        const uid = tr?.dataset?.uid;
        if (!uid) {
          alert("ユーザーIDが見つかりません");
          return;
        }
        
        // 変更前の値を保存（changeイベントは変更後に発火するので、逆に計算）
        const newValue = sel.value;
        const originalValue = (newValue === "admin") ? "user" : "admin";
        
        console.log('[Role Change]', {uid, from: originalValue, to: newValue});
        
        try{
          sel.disabled = true;
          const t2 = await getIdToken();
          if (!t2) {
            throw new Error("認証トークンが取得できません");
          }
          
          console.log('[Role Change] Sending PATCH request:', {uid, role: newValue});
          
          const r2 = await fetch(`/api/admin/users/${uid}`, {
            method:"PATCH",
            headers:{ "Content-Type":"application/json", Authorization:"Bearer "+t2 },
            body: JSON.stringify({ role: newValue })
          });
          const j2 = await r2.json().catch(()=>({}));
          
          console.log('[Role Change] Response:', {status: r2.status, ok: r2.ok, body: j2});
          
          if (!r2.ok) throw new Error(j2?.error || `HTTP ${r2.status}`);
          
          // 成功メッセージを表示
          const statusSpan = document.createElement("span");
          statusSpan.textContent = " ✓ 保存しました";
          statusSpan.style.color = "#10b981";
          statusSpan.style.marginLeft = "8px";
          statusSpan.style.fontSize = "12px";
          statusSpan.style.fontWeight = "600";
          tr.appendChild(statusSpan);
          setTimeout(() => statusSpan.remove(), 3000);
          
          console.log('[Role Change] Success!');
        }catch(e){
          console.error('[Role Change] Error:', e);
          alert("更新失敗: " + (e.message||e));
          sel.value = originalValue;
        }finally{
          sel.disabled = false;
        }
      });
    });

    // 名前欄の編集機能
    pane.querySelectorAll(".name-cell").forEach(cell=>{
      cell.addEventListener("dblclick", ()=>{
        const tr = cell.closest("tr");
        const uid = tr?.dataset?.uid;
        if (!uid) return;

        const currentText = cell.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = currentText;
        input.style.width = "100%";
        input.style.padding = "6px";
        input.style.border = "2px solid #ec4899";
        input.style.borderRadius = "4px";
        input.style.fontSize = "13px";

        cell.innerHTML = "";
        cell.appendChild(input);
        input.focus();
        input.select();

        const saveName = async ()=>{
          const newValue = input.value.trim();
          try{
            const t2 = await getIdToken();
            const r2 = await fetch(`/api/admin/users/${uid}`, {
              method:"PATCH",
              headers:{ "Content-Type":"application/json", Authorization:"Bearer "+t2 },
              body: JSON.stringify({ name: newValue })
            });
            const j2 = await r2.json().catch(()=>({}));
            if (!r2.ok) throw new Error(j2?.error || `HTTP ${r2.status}`);

            cell.textContent = newValue;
            cell.setAttribute("data-original", esc(newValue));
          }catch(e){
            alert("名前更新失敗: " + (e.message||e));
            cell.textContent = currentText;
          }
        };

        input.addEventListener("blur", saveName);
        input.addEventListener("keydown", (e)=>{
          if (e.key === "Enter"){
            e.preventDefault();
            saveName();
          }
          if (e.key === "Escape"){
            e.preventDefault();
            cell.textContent = currentText;
          }
        });
      });
    });

    // 備考欄の編集機能
    pane.querySelectorAll(".remarks-cell").forEach(cell=>{
      cell.addEventListener("dblclick", ()=>{
        const tr = cell.closest("tr");
        const uid = tr?.dataset?.uid;
        if (!uid) return;

        const currentText = cell.textContent;
        const input = document.createElement("textarea");
        input.value = currentText;
        input.style.width = "100%";
        input.style.minHeight = "60px";
        input.style.padding = "6px";
        input.style.border = "2px solid #6366f1";
        input.style.borderRadius = "4px";
        input.style.fontSize = "13px";

        cell.innerHTML = "";
        cell.appendChild(input);
        input.focus();

        const saveRemarks = async ()=>{
          const newValue = input.value.trim();
          try{
            const t2 = await getIdToken();
            const r2 = await fetch(`/api/admin/users/${uid}`, {
              method:"PATCH",
              headers:{ "Content-Type":"application/json", Authorization:"Bearer "+t2 },
              body: JSON.stringify({ remarks: newValue })
            });
            const j2 = await r2.json().catch(()=>({}));
            if (!r2.ok) throw new Error(j2?.error || `HTTP ${r2.status}`);

            cell.textContent = newValue;
            cell.setAttribute("data-original", esc(newValue));
          }catch(e){
            alert("備考更新失敗: " + (e.message||e));
            cell.textContent = currentText;
          }
        };

        input.addEventListener("blur", saveRemarks);
        input.addEventListener("keydown", (e)=>{
          if (e.key === "Enter" && e.ctrlKey){
            e.preventDefault();
            saveRemarks();
          }
          if (e.key === "Escape"){
            e.preventDefault();
            cell.textContent = currentText;
          }
        });
      });
    });

    // ユーザー削除機能
    pane.querySelectorAll(".delete-user-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const uid = btn.getAttribute("data-uid");
        const email = btn.getAttribute("data-email");
        if (!uid) return;

        const confirmed = confirm(`ユーザー「${email}」を削除しますか？\n\nこの操作は取り消せません。ユーザーの全データ（セッション、会話ログ等）も削除されます。`);
        if (!confirmed) return;

        try{
          btn.disabled = true;
          btn.textContent = "削除中...";
          const t2 = await getIdToken();
          const r2 = await fetch(`/api/admin/users/${uid}`, {
            method:"DELETE",
            headers:{ Authorization:"Bearer "+t2 }
          });
          const j2 = await r2.json().catch(()=>({}));
          if (!r2.ok) throw new Error(j2?.error || `HTTP ${r2.status}`);

          alert("ユーザーを削除しました");
          refreshUsers(); // リロード
        }catch(e){
          alert("削除失敗: " + (e.message||e));
          btn.disabled = false;
          btn.textContent = "削除";
        }
      });
    });

  }catch(e){
    const pane = $("pane-users"); if (pane) pane.innerHTML = `<div class="err">取得失敗: ${esc(e.message||String(e))}</div>`;
  }
}

/* ====================== 学修状況 ====================== */
let LZ_SORT = { key: "userNo", dir: "asc" };
let CACHED_SUMMARY_DATA = null; // CSV出力用にキャッシュ { rows: [], detailedSessions: {} }
let CACHED_GROWTH_DATA = null; // CSV出力用にキャッシュ

function mountLearningPane(){
  const pane = $("pane-stats"); if (!pane) return;
  pane.innerHTML = `
    <h3>学修状況 <button id="btnDownloadSummaryCSV" class="secondary" style="font-size:13px;padding:6px 10px;margin-left:10px">📥 会話ログ付きCSV</button></h3>
    <div id="lzBox"><div class="muted">読み込み中…</div></div>

    <div style="margin-top:32px; border-top:2px solid #e5e7eb; padding-top:24px">
      <h3>成長分析（初期5回 vs 直近5回） <button id="btnDownloadGrowthCSV" class="secondary" style="font-size:13px;padding:6px 10px;margin-left:10px">📥 CSVダウンロード</button></h3>
      <div class="muted small" style="margin-bottom:.5rem">
        各学生の初期5セッションと直近5セッションを比較し、成長率・弱点・改善項目を表示します。
      </div>
      <div id="growthBox"><div class="muted">読み込み中…</div></div>
    </div>

    <style>
      .lnk{ color:#0a58ca; text-decoration:underline; cursor:pointer; background:none; border:none; padding:0; }
      .slnk{ color:#666; text-decoration:none; margin-left:.25rem; }
      .logline{ line-height:1.55; }
      .nowrap{ white-space:nowrap; }
      .growth-up{ color:#10b981; font-weight:700; }
      .growth-down{ color:#ef4444; font-weight:700; }
      .growth-neutral{ color:#6b7280; }
      .badge-weak{ display:inline-block; background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; margin:2px; font-size:11px; }
      .badge-improved{ display:inline-block; background:#dbeafe; color:#1e3a8a; padding:2px 6px; border-radius:4px; margin:2px; font-size:11px; }
      .expand{ position:relative; z-index:1; }
      .expand td{ position:relative; z-index:1; }
    </style>
  `;
  loadLearningSummary();
  loadGrowthAnalysis();
}

async function loadLearningSummary(){
  const box = $("lzBox"); if (!box) return;
  box.innerHTML = `<div class="muted">読み込み中...</div>`;
  try{
    const t = await getIdToken();
    const r = await fetch("/api/admin/learning/summary", { headers:{ Authorization:"Bearer "+t } });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    let rows = Array.isArray(j.rows) ? j.rows : [];
    const cmp = (a,b)=>{
      const k = LZ_SORT.key;
      const na=(typeof a[k]==="number")?a[k]:(""+(a[k]??"")).toLowerCase();
      const nb=(typeof b[k]==="number")?b[k]:(""+(b[k]??"")).toLowerCase();
      return (LZ_SORT.dir==="asc") ? ((na>nb)?1:(na<nb)?-1:0) : ((na>nb)?-1:(na<nb)?1:0);
    };
    rows = rows.sort(cmp);
    const head = (key,label)=>`${label}<a href="#" class="slnk" data-key="${key}" title="並び替え">↕</a>`;

    box.innerHTML = `
      <div class="muted small" style="margin-bottom:.5rem">
        「会話」リンクで実施毎の会話ログを展開表示します（看護師=青）。
      </div>
      <table class="tbl" id="lzTable">
        <thead>
          <tr>
            <th style="width:80px">${head("userNo","No.")}</th>
            <th>${head("name","氏名")}</th>
            <th>${head("email","メールアドレス")}</th>
            <th style="width:110px">${head("practiceCount","練習回数")}</th>
            <th style="width:110px">${head("examCount","患者別回数")}</th>
            <th style="width:140px">${head("bestExamScore100","患者別最高点")}</th>
            <th style="width:140px">${head("totalDurationSec","学修総時間")}</th>
            <th style="width:70px">会話</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r=>renderRow(r)).join("")}
        </tbody>
      </table>
    `;

    box.querySelectorAll(".slnk").forEach(a=>{
      a.addEventListener("click", (ev)=>{
        ev.preventDefault();
        const k = a.dataset.key;
        if (LZ_SORT.key === k) LZ_SORT.dir = (LZ_SORT.dir === "asc") ? "desc" : "asc";
        else { LZ_SORT.key = k; LZ_SORT.dir = "asc"; }
        loadLearningSummary();
      });
    });

    box.querySelectorAll(".btnLog").forEach(b=>{
      b.addEventListener("click", (ev)=>{ ev.preventDefault(); toggleLogsRow(b); });
    });

    // 総時間セルをバックフィル & 詳細セッション情報を取得
    const detailedSessions = {}; // { uid: [sessions] }
    for (const r0 of rows){
      const cell = document.querySelector(`tr[data-uid="${r0.uid}"] td[data-col="dur"]`);
      if (!cell) continue;
      try{
        const t2 = await getIdToken();
        const rs = await fetch(`/api/admin/learning/user/${r0.uid}/logs`, { headers:{ Authorization:"Bearer "+t2 } });
        const jj = await rs.json().catch(()=>({}));
        if (!rs.ok) throw new Error(jj?.error || `HTTP ${rs.status}`);
        const sessions = Array.isArray(jj.sessions) ? jj.sessions : [];

        // 詳細セッション情報を保存（CSV用）
        detailedSessions[r0.uid] = sessions;

        let total = 0;
        for (const s of sessions){
          const d = getSessionDurationSec(s);
          if (Number.isFinite(d)) total += d;
        }
        cell.textContent = fmtDur(total);
        r0.totalDurationSec = total; // キャッシュに保存
      }catch{
        cell.textContent = "-";
        detailedSessions[r0.uid] = []; // エラー時は空配列
      }
    }

    // データをキャッシュ（会話ログ情報も含める）
    CACHED_SUMMARY_DATA = { rows, detailedSessions };

    // CSVダウンロードボタンのイベントハンドラ
    const btnCSV = $("btnDownloadSummaryCSV");
    if (btnCSV) {
      btnCSV.onclick = () => exportSummaryCSV();
    }

  }catch(e){
    box.innerHTML = `<div class="err">取得失敗: ${esc(e.message||String(e))}</div>`;
  }
}

function exportSummaryCSV() {
  if (!CACHED_SUMMARY_DATA || !CACHED_SUMMARY_DATA.rows || CACHED_SUMMARY_DATA.rows.length === 0) {
    alert("データがありません");
    return;
  }

  const { rows, detailedSessions } = CACHED_SUMMARY_DATA;

  // ヘッダー: 1セッション1行形式
  const headers = ["No.", "氏名", "メールアドレス", "セッション日時", "スコア", "時間(秒)", "会話ログ"];
  const csvRows = [];

  for (const user of rows) {
    const sessions = detailedSessions[user.uid] || [];

    if (sessions.length === 0) {
      // セッションがない場合も1行出力
      csvRows.push([
        user.userNo || "",
        user.name || "",
        user.email || "",
        "",
        "",
        "",
        ""
      ]);
      continue;
    }

    // 各セッションを1行ずつ
    for (const s of sessions) {
      const timestamp = s.createdAt ? new Date(s.createdAt).toLocaleString("ja-JP") : "";
      const score = s.score100 != null ? s.score100 : "";
      const duration = getSessionDurationSec(s);

      // 会話ログを1つの文字列にまとめる
      const messages = Array.isArray(s.messages) ? s.messages : [];
      const conversationLog = messages.map(m => {
        const who = m.who === "nurse" ? "看護師" : "患者";
        return `${who}: ${m.text || ""}`;
      }).join("\n");

      csvRows.push([
        user.userNo || "",
        user.name || "",
        user.email || "",
        timestamp,
        score,
        duration,
        conversationLog
      ]);
    }
  }

  const csvLines = [
    headers.map(escapeCSV).join(","),
    ...csvRows.map(row => row.map(escapeCSV).join(","))
  ];

  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  downloadCSV(`学修状況_会話ログ付き_${timestamp}.csv`, csvLines.join("\n"));
}

function renderRow(r){
  const safe = (v)=> (v==null || v==="") ? "-" : v;
  return `
    <tr data-uid="${r.uid}">
      <td>${safe(r.userNo)}</td>
      <td class="nowrap">${esc(r.name||"")}</td>
      <td>${esc(r.email||"")}</td>
      <td style="text-align:center">${r.practiceCount ?? 0}</td>
      <td style="text-align:center">${r.examCount ?? 0}</td>
      <td style="text-align:center">${r.bestExamScore100 ?? "-"}</td>
      <td style="text-align:center" data-col="dur">…</td>
      <td style="text-align:center"><a href="#" class="lnk btnLog">会話</a></td>
    </tr>
  `;
}

function getSessionDurationSec(s){
  if (Number.isFinite(s?.durationSec)) return Math.max(0, s.durationSec);
  const st = s?.startedAt ? Date.parse(s.startedAt) : (s?.createdAt ? Number(s.createdAt) : NaN);
  const ed = s?.finishedAt ? Date.parse(s.finishedAt) : (s?.endedAt ? Number(s.endedAt) : NaN);
  if (Number.isFinite(st) && Number.isFinite(ed) && ed>=st) return Math.min(4*3600, Math.floor((ed-st)/1000));

  const msgs = Array.isArray(s?.messages) ? s.messages : [];
  let first = NaN, last = NaN;
  for(const m of msgs){
    const t = m?.t ?? m?.time ?? m?.timestamp ?? m?.createdAt;
    const v = Number(t); const ms = Number.isFinite(v) ? v : Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(first) || ms < first) first = ms;
    if (!Number.isFinite(last)  || ms > last ) last  = ms;
  }
  if (Number.isFinite(first) && Number.isFinite(last) && last >= first){
    return Math.min(4*3600, Math.floor((last - first)/1000));
  }
  return 0;
}

async function toggleLogsRow(btn){
  const tr = btn.closest("tr");
  const uid = tr?.dataset?.uid;
  if (!uid) return;

  const next = tr.nextElementSibling;
  if (next && next.classList.contains("expand")){
    next.remove();
    return;
  }
  const tbody = tr.parentElement;
  tbody.querySelectorAll(".expand").forEach(x=>x.remove());

  const colspan = tr.children.length;
  const exp = document.createElement("tr");
  exp.className = "expand";
  exp.innerHTML = `<td colspan="${colspan}"><div class="muted">読み込み中...</div></td>`;
  tr.after(exp);

  try{
    const t = await getIdToken();
    const r = await fetch(`/api/admin/learning/user/${uid}/logs`, { headers:{ Authorization:"Bearer "+t } });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    const sessions = j.sessions || [];
    const html = sessions.map(s=>{
      const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : "-";
      const tag  = s.type || "training";
      const score= (s.score100==null) ? "" : ` / 点:${s.score100}`;
      const durS = getSessionDurationSec(s);
      const dur  = durS ? ` / 時間:${fmtDur(durS)}` : "";

      const lines = (s.messages||[]).map(m=>{
        const color = (m.who==="nurse") ? ' style="color:#2563eb"' : "";
        return `<div class="logline"><span${color}>${esc(m.text||"")}</span></div>`;
      }).join("") || `<div class="muted">（ログなし）</div>`;

      // 音声再生プレーヤー
      const isSignedUrl = s.audioUrl && (s.audioUrl.includes('X-Goog-Signature') || s.audioUrl.includes('Signature='));
      const crossoriginAttr = isSignedUrl ? '' : ' crossorigin="anonymous"';
      const audioPlayer = s.audioUrl ? `
        <div style="margin-top:8px;padding:8px;background:#f3f4f6;border-radius:6px;position:relative;z-index:200;pointer-events:auto;">
          <div style="font-weight:600;margin-bottom:6px;font-size:13px">📻 録音音声</div>
          <audio controls${crossoriginAttr} style="width:100%;max-width:400px;pointer-events:auto;cursor:pointer;position:relative;z-index:201;">
            <source src="${esc(s.audioUrl)}" type="audio/webm">
            お使いのブラウザは音声再生に対応していません。
          </audio>
        </div>
      ` : "";

      return `
        <div style="margin:8px 0; padding:6px; border:1px solid #eee; position:relative">
          <div style="margin-bottom:.25rem"><b>実施:</b> ${when}${score}${dur}</div>
          <button class="delete-session-btn" data-session-id="${s.id}" style="position:absolute; top:6px; right:6px; background:#dc2626; color:#fff; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer; border:none">削除</button>
          ${audioPlayer}
          ${lines}
        </div>
      `;
    }).join("") || `<div class="muted">実施履歴がありません。</div>`;

    exp.innerHTML = `<td colspan="${colspan}">${html}</td>`;
    
    // audio要素にイベントリスナーを追加してクリック可能性を確保
    const audioElements = exp.querySelectorAll('audio');
    audioElements.forEach((audio, index) => {
      // 強制的にスタイルを再適用
      audio.style.pointerEvents = 'auto';
      audio.style.cursor = 'pointer';
      audio.style.position = 'relative';
      audio.style.zIndex = '201';
      
      // クリックイベントのデバッグ
      audio.addEventListener('click', (e) => {
        console.log('[Admin Audio] Click captured on audio element', index);
        e.stopPropagation();
      }, true);
      
      audio.addEventListener('play', () => {
        console.log('[Admin Audio] Play event - audio started', index);
      });
      
      audio.addEventListener('error', (e) => {
        console.error('[Admin Audio] Error loading audio', index, e);
        console.error('[Admin Audio] Error details:', {
          src: audio.src,
          networkState: audio.networkState,
          readyState: audio.readyState,
          errorCode: audio.error?.code,
          errorMessage: audio.error?.message
        });
      });
    });

    // 削除ボタンのイベントリスナーを追加
    const deleteButtons = exp.querySelectorAll('.delete-session-btn');
    deleteButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 行のクリックイベントを防止
        const sessionId = btn.getAttribute('data-session-id');
        if (!sessionId) return;

        const confirmed = confirm('このセッションを削除しますか？\n\nこの操作は取り消せません。');
        if (!confirmed) return;

        try {
          btn.disabled = true;
          btn.textContent = '削除中...';
          console.log('[Delete Session] Starting deletion for:', sessionId);
          const t = await getIdToken();
          console.log('[Delete Session] Token obtained, sending request');
          const r = await fetch(`/api/admin/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + t }
          });
          console.log('[Delete Session] Response status:', r.status);
          const j = await r.json().catch(() => ({}));
          console.log('[Delete Session] Response body:', j);
          if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

          alert('セッションを削除しました');
          console.log('[Delete Session] Reloading learning pane');
          // 学習状況を再読み込み
          loadLearningPane();
        } catch (err) {
          console.error('[Delete Session] Error:', err);
          alert('削除失敗: ' + (err.message || err));
          btn.disabled = false;
          btn.textContent = '削除';
        }
      });
    });
  }catch(e){
    exp.innerHTML = `<td colspan="${colspan}"><div class="err">取得失敗: ${esc(e.message||String(e))}</div></td>`;
  }
}

/* ====================== 成長分析 ====================== */
async function loadGrowthAnalysis(){
  const box = $("growthBox"); if (!box) return;
  box.innerHTML = `<div class="muted">読み込み中...</div>`;
  try{
    const t = await getIdToken();
    if (!t) {
      box.innerHTML = `<div class="err">認証トークンが取得できません。ログインし直してください。</div>`;
      return;
    }

    const r = await fetch("/api/admin/learning/growth-analysis", {
      headers:{ Authorization:"Bearer "+t },
      credentials: 'include'
    });

    let j;
    try {
      j = await r.json();
    } catch(parseError) {
      throw new Error(`レスポンスのパースに失敗しました (HTTP ${r.status})`);
    }

    if (!r.ok) {
      const errorMsg = j?.error || `HTTP ${r.status}`;
      console.error('[loadGrowthAnalysis] Error:', errorMsg, j);
      throw new Error(errorMsg);
    }

    const students = Array.isArray(j.students) ? j.students : [];

    if (students.length === 0) {
      box.innerHTML = `<div class="muted">練習データがある学生がいません。</div>`;
      return;
    }

    box.innerHTML = `
      <table class="tbl" id="growthTable">
        <thead>
          <tr>
            <th style="width:60px">No.</th>
            <th>氏名</th>
            <th style="width:80px">総回数</th>
            <th style="width:140px">初期スコア<br><span style="font-weight:400;font-size:11px">(0-2点)</span></th>
            <th style="width:140px">直近スコア<br><span style="font-weight:400;font-size:11px">(0-2点)</span></th>
            <th style="width:100px">成長率</th>
            <th style="width:120px">初期速度<br><span style="font-weight:400;font-size:11px">(回/分)</span></th>
            <th style="width:120px">直近速度<br><span style="font-weight:400;font-size:11px">(回/分)</span></th>
            <th>弱点項目</th>
            <th>改善項目</th>
          </tr>
        </thead>
        <tbody>
          ${students.map(s => renderGrowthRow(s)).join("")}
        </tbody>
      </table>
    `;

    // データをキャッシュ
    CACHED_GROWTH_DATA = students;

    // CSVダウンロードボタンのイベントハンドラ
    const btnCSV = $("btnDownloadGrowthCSV");
    if (btnCSV) {
      btnCSV.onclick = () => exportGrowthCSV();
    }

  }catch(e){
    console.error('[loadGrowthAnalysis] Exception:', e);
    box.innerHTML = `
      <div class="err">
        取得失敗: ${esc(e.message||String(e))}
        <br><br>
        <button class="secondary" onclick="loadGrowthAnalysis()">再試行</button>
      </div>
    `;
  }
}

function exportGrowthCSV() {
  if (!CACHED_GROWTH_DATA || CACHED_GROWTH_DATA.length === 0) {
    alert("データがありません");
    return;
  }

  const headers = [
    "No.", "氏名", "総回数",
    "初期セッション数", "初期平均スコア(0-2)", "初期会話速度(回/分)",
    "直近セッション数", "直近平均スコア(0-2)", "直近会話速度(回/分)",
    "成長率(%)", "弱点項目", "改善項目"
  ];

  const rows = CACHED_GROWTH_DATA.map(s => {
    const weakItems = s.weakItems?.map(w => `${w.name}(${w.avg})`).join("; ") || "";
    const improvedItems = s.improvedItems?.map(i => `${i.name}(+${i.improvement})`).join("; ") || "";

    return [
      s.userNo || "",
      s.name || "",
      s.totalSessions || 0,
      s.initial?.count || 0,
      s.initial?.avgScore ?? "",
      s.initial?.avgSpeakingRate ?? "",
      s.recent?.count || 0,
      s.recent?.avgScore ?? "",
      s.recent?.avgSpeakingRate ?? "",
      s.growthRate ?? "",
      weakItems,
      improvedItems
    ];
  });

  const csvLines = [
    headers.map(escapeCSV).join(","),
    ...rows.map(row => row.map(escapeCSV).join(","))
  ];

  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  downloadCSV(`成長分析_${timestamp}.csv`, csvLines.join("\n"));
}

function renderGrowthRow(s){
  // 成長率の表示
  let growthHtml = "-";
  let growthClass = "growth-neutral";
  if (s.growthRate !== null && s.growthRate !== undefined) {
    if (s.growthRate > 0) {
      growthHtml = `<span class="growth-up">↑${s.growthRate}%</span>`;
    } else if (s.growthRate < 0) {
      growthHtml = `<span class="growth-down">↓${Math.abs(s.growthRate)}%</span>`;
    } else {
      growthHtml = `<span class="growth-neutral">→ 0%</span>`;
    }
  }

  // 弱点項目の表示
  const weakHtml = (s.weakItems && s.weakItems.length > 0)
    ? s.weakItems.map(item => `<span class="badge-weak">${esc(item.name)} (${item.avg})</span>`).join("")
    : `<span class="muted small">なし</span>`;

  // 改善項目の表示
  const improvedHtml = (s.improvedItems && s.improvedItems.length > 0)
    ? s.improvedItems.map(item => `<span class="badge-improved">${esc(item.name)} (+${item.improvement})</span>`).join("")
    : `<span class="muted small">なし</span>`;

  // 初期・直近スコアと速度
  const initialScore = s.initial.avgScore !== null ? s.initial.avgScore : "-";
  const recentScore = s.recent.avgScore !== null ? s.recent.avgScore : "-";
  const initialRate = s.initial.avgSpeakingRate !== null ? s.initial.avgSpeakingRate : "-";
  const recentRate = s.recent.avgSpeakingRate !== null ? s.recent.avgSpeakingRate : "-";

  return `
    <tr>
      <td style="text-align:center">${s.userNo || "-"}</td>
      <td class="nowrap">${esc(s.name || "")}</td>
      <td style="text-align:center">${s.totalSessions}</td>
      <td style="text-align:center">${initialScore}<br><span class="muted small">(${s.initial.count}回)</span></td>
      <td style="text-align:center">${recentScore}<br><span class="muted small">(${s.recent.count}回)</span></td>
      <td style="text-align:center">${growthHtml}</td>
      <td style="text-align:center">${initialRate}</td>
      <td style="text-align:center">${recentRate}</td>
      <td style="line-height:1.6">${weakHtml}</td>
      <td style="line-height:1.6">${improvedHtml}</td>
    </tr>
  `;
}

/* ====================== 全般設定 ====================== */
function mountSettingsPane(){
  const pane = $("pane-settings"); if (!pane) return;

  pane.innerHTML = `
    <h3>全般設定</h3>
    <div class="muted small" style="margin-bottom:1rem">
      システム全体の動作設定を管理します。
    </div>

    <div class="card" style="padding:20px;margin:8px 0">
      <div style="font-weight:700;margin-bottom:12px;font-size:16px">練習時間設定</div>

      <div style="margin-bottom:20px">
        <label style="display:block;margin-bottom:8px;font-weight:600">症状別練習の制限時間
          <div class="muted small" style="font-weight:normal;margin-top:4px">
            症状別練習モードで使用する制限時間を設定します。患者モードは患者ごとに個別設定されます。
          </div>
        </label>
        <select id="settingsPracticeTimeLimit" style="width:250px">
          <option value="30">30秒</option>
          <option value="60">1分（60秒）</option>
          <option value="90">1分30秒</option>
          <option value="120">2分（120秒）</option>
          <option value="150">2分30秒</option>
          <option value="180" selected>3分（180秒）</option>
          <option value="210">3分30秒</option>
          <option value="240">4分（240秒）</option>
          <option value="270">4分30秒</option>
          <option value="300">5分（300秒）</option>
          <option value="360">6分（360秒）</option>
          <option value="420">7分（420秒）</option>
          <option value="480">8分（480秒）</option>
          <option value="540">9分（540秒）</option>
          <option value="600">10分（600秒）</option>
        </select>
      </div>

      <div style="border-top:1px solid #e5e7eb;margin:20px 0;padding-top:20px">
        <div style="font-weight:700;margin-bottom:12px;font-size:16px">録音設定</div>

        <div style="margin-bottom:20px">
          <label style="display:flex;align-items:center;cursor:pointer">
            <input type="checkbox" id="settingsRecordingEnabled" style="width:20px;height:20px;margin-right:10px">
            <span style="font-weight:600">対話音声を自動録音する</span>
          </label>
          <div class="muted small" style="margin-top:8px;margin-left:30px">
            有効にすると、練習中の対話音声（学生と患者の両方）が自動的に録音され、
            学習履歴から再生できるようになります。
            録音データはCloud Storageに保存されます（追加費用: 約$0.40/月）。
          </div>
        </div>
      </div>

      <div style="border-top:1px solid #e5e7eb;margin:20px 0;padding-top:20px">
        <div style="font-weight:700;margin-bottom:12px;font-size:16px">AI Coach使用制限（Version 3.0）</div>

        <div style="margin-bottom:20px">
          <label style="display:flex;align-items:center;cursor:pointer">
            <input type="checkbox" id="settingsAiCoachLimitEnabled" style="width:20px;height:20px;margin-right:10px">
            <span style="font-weight:600">AI Coach使用回数を制限する</span>
          </label>
          <div class="muted small" style="margin-top:8px;margin-left:30px">
            有効にすると、学生のAI Coach使用回数を期間ごとに制限できます。
          </div>
        </div>

        <div id="aiCoachLimitDetailsArea" style="margin-left:30px;display:none">
          <div style="margin-bottom:16px">
            <label style="display:block;margin-bottom:6px;font-weight:600">制限期間</label>
            <select id="settingsAiCoachPeriod" style="width:200px;padding:8px;border:1px solid #d1d5db;border-radius:4px">
              <option value="daily">1日あたり</option>
              <option value="weekly" selected>1週間あたり</option>
              <option value="monthly">1ヶ月あたり</option>
            </select>
          </div>

          <div style="margin-bottom:16px">
            <label style="display:block;margin-bottom:6px;font-weight:600">最大使用回数</label>
            <input type="number" id="settingsAiCoachMaxCount" min="1" max="100" value="3" style="width:100px;padding:8px;border:1px solid #d1d5db;border-radius:4px">
            <span class="muted small" style="margin-left:8px">回</span>
          </div>

          <div class="muted small" style="background:#fef3c7;padding:10px;border-radius:6px;border-left:4px solid #f59e0b">
            <strong>💡 推奨設定：</strong> 1週間あたり3回<br>
            学生が計画的に練習を進めることを促しながら、必要な時にAI Coachを活用できるバランスです。
          </div>
        </div>
      </div>

      <div style="margin-top:16px">
        <button id="btnSaveSettings" class="primary">保存</button>
        <span id="settingsSaveStatus" class="muted small" style="margin-left:12px"></span>
      </div>
    </div>
  `;

  // 設定を読み込み
  loadSettings();

  // AI Coach制限の有効/無効でdetailsエリアの表示を制御
  const aiCoachLimitCheckbox = $("settingsAiCoachLimitEnabled");
  const aiCoachDetailsArea = $("aiCoachLimitDetailsArea");
  
  const updateAiCoachDetailsVisibility = () => {
    if (aiCoachLimitCheckbox && aiCoachDetailsArea) {
      aiCoachDetailsArea.style.display = aiCoachLimitCheckbox.checked ? "block" : "none";
    }
  };
  
  if (aiCoachLimitCheckbox) {
    aiCoachLimitCheckbox.addEventListener("change", updateAiCoachDetailsVisibility);
  }

  // 保存ボタン
  const btnSave = $("btnSaveSettings");
  if (btnSave) {
    btnSave.onclick = async () => {
      await saveSettings();
    };
  }
}

async function loadSettings(){
  try{
    const status = $("settingsSaveStatus");
    if (status) status.textContent = "読み込み中...";

    const t = await getIdToken();
    if (!t) {
      if (status) status.textContent = "未ログインです";
      return;
    }

    const r = await fetch("/api/admin/settings", {
      headers:{ Authorization:"Bearer "+t }
    });
    const j = await r.json().catch(()=>({}));

    if (!r.ok) {
      console.error("Settings load error:", j?.error || r.status);
      if (status) status.textContent = "";
      return;
    }

    // 症状別練習の制限時間を設定
    const practiceTimeLimit = j.settings?.practiceTimeLimit || 180;
    const select = $("settingsPracticeTimeLimit");
    if (select) select.value = practiceTimeLimit;

    // 録音設定を取得
    const recordingEnabled = j.settings?.recordingEnabled || false;
    const recordingCheckbox = $("settingsRecordingEnabled");
    if (recordingCheckbox) recordingCheckbox.checked = recordingEnabled;

    // AI Coach制限設定を取得（Version 3.0）
    const aiCoachLimit = j.settings?.aiCoachLimit || {};
    const aiCoachLimitEnabled = aiCoachLimit.enabled || false;
    const aiCoachPeriod = aiCoachLimit.period || "weekly";
    const aiCoachMaxCount = aiCoachLimit.maxCount || 3;

    const aiCoachLimitCheckbox = $("settingsAiCoachLimitEnabled");
    const aiCoachPeriodSelect = $("settingsAiCoachPeriod");
    const aiCoachMaxCountInput = $("settingsAiCoachMaxCount");
    const aiCoachDetailsArea = $("aiCoachLimitDetailsArea");

    if (aiCoachLimitCheckbox) aiCoachLimitCheckbox.checked = aiCoachLimitEnabled;
    if (aiCoachPeriodSelect) aiCoachPeriodSelect.value = aiCoachPeriod;
    if (aiCoachMaxCountInput) aiCoachMaxCountInput.value = aiCoachMaxCount;
    
    // detailsエリアの表示を更新
    if (aiCoachDetailsArea) {
      aiCoachDetailsArea.style.display = aiCoachLimitEnabled ? "block" : "none";
    }

    if (status) status.textContent = "";
  }catch(e){
    console.error("Settings load exception:", e);
    const status = $("settingsSaveStatus");
    if (status) status.textContent = "読み込みエラー";
  }
}

async function saveSettings(){
  try{
    const status = $("settingsSaveStatus");
    if (status) status.textContent = "保存中...";

    const t = await getIdToken();
    if (!t) {
      alert("ログインしてください");
      if (status) status.textContent = "";
      return;
    }

    const practiceTimeLimit = parseInt($("settingsPracticeTimeLimit")?.value || "180", 10);
    const recordingEnabled = $("settingsRecordingEnabled")?.checked || false;

    // AI Coach制限設定（Version 3.0）
    const aiCoachLimitEnabled = $("settingsAiCoachLimitEnabled")?.checked || false;
    const aiCoachPeriod = $("settingsAiCoachPeriod")?.value || "weekly";
    const aiCoachMaxCount = parseInt($("settingsAiCoachMaxCount")?.value || "3", 10);

    const r = await fetch("/api/admin/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + t
      },
      body: JSON.stringify({
        practiceTimeLimit,
        recordingEnabled,
        aiCoachLimit: {
          enabled: aiCoachLimitEnabled,
          period: aiCoachPeriod,
          maxCount: aiCoachMaxCount,
          resetDay: 1  // Monday
        }
      })
    });

    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    if (status) {
      status.textContent = "✓ 保存しました";
      status.style.color = "#10b981";
      setTimeout(() => {
        status.textContent = "";
        status.style.color = "";
      }, 3000);
    }
  }catch(e){
    alert("保存失敗: " + (e.message || e));
    const status = $("settingsSaveStatus");
    if (status) status.textContent = "";
  }
}

/* ====================== 統計（評価項目可視化 + テキストマイニング） ====================== */
function mountAnalysisPane(){
  const pane = $("pane-analysis"); if (!pane) return;
  pane.innerHTML = `
    <h3>統計 - 評価項目の傾向</h3>
    <div class="muted small" style="margin-bottom:1rem">
      不適切なセッション（評価なし、メッセージ10件未満）は自動的に除外されます。
    </div>

    <div style="margin-bottom:32px">
      <h4>評価項目別の全体平均スコア</h4>
      <div class="muted small" style="margin-bottom:1rem">
        全学生の評価項目ごとの平均スコアを表示します。各項目は0点・1点・2点の3段階評価で、平均値を100点満点に換算しています。
      </div>
      <div id="barChartBox"><div class="muted">読み込み中…</div></div>
    </div>

    <div style="margin-bottom:32px; border-top:2px solid #e5e7eb; padding-top:24px">
      <h4>学生×評価項目 ヒートマップ</h4>
      <div class="muted small" style="margin-bottom:1rem">
        各学生の評価項目ごとのスコアをヒートマップで可視化します。色が濃いほど高スコアです。
      </div>
      <div id="heatmapBox"><div class="muted">読み込み中…</div></div>
    </div>

    <div style="margin-bottom:32px; border-top:2px solid #e5e7eb; padding-top:24px">
      <h4>テキストマイニング分析 - 対話の特徴</h4>
      <div class="muted small" style="margin-bottom:1rem">
        学生の対話特徴（質問の質、共感表現、情報収集）を自動分析します。
      </div>
      <div id="textMiningBox"><div class="muted">読み込み中…</div></div>
    </div>

    <style>
      .bar-chart{ margin:16px 0; }
      .bar-item{ display:flex; align-items:center; margin:8px 0; gap:8px; }
      .bar-label{ min-width:160px; font-size:13px; text-align:right; }
      .bar-track{ flex:1; height:32px; background:#f3f4f6; border-radius:6px; position:relative; overflow:hidden; }
      .bar-fill{ height:100%; transition:width 0.3s ease; display:flex; align-items:center; padding:0 8px; color:#fff; font-weight:600; font-size:12px; }
      .bar-fill.good{ background:#10b981; }
      .bar-fill.ok{ background:#f59e0b; }
      .bar-fill.bad{ background:#ef4444; }

      .heatmap-table{ border-collapse:collapse; width:100%; font-size:12px; }
      .heatmap-table th, .heatmap-table td{ border:1px solid #e5e7eb; padding:8px; text-align:center; }
      .heatmap-table th{ background:#f9fafb; font-weight:700; }
      .heatmap-cell{ width:60px; height:40px; }
      .heatmap-cell.good{ background:#d1fae5; color:#065f46; }
      .heatmap-cell.ok{ background:#fef3c7; color:#92400e; }
      .heatmap-cell.bad{ background:#fee2e2; color:#991b1b; }
      .tm-table{ border-collapse:collapse; width:100%; font-size:13px; margin-top:16px; }
      .tm-table th, .tm-table td{ border:1px solid #e5e7eb; padding:8px; text-align:center; }
      .tm-table th{ background:#f9fafb; font-weight:700; }
      .metric-card{ background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:12px; display:inline-block; min-width:140px; margin:8px; }
      .metric-value{ font-size:24px; font-weight:700; color:#6366f1; }
      .metric-label{ font-size:12px; color:#6b7280; margin-top:4px; }
    </style>
  `;
  loadRubricAnalysis();
  loadTextMiningAnalysis();
}

async function loadRubricAnalysis(){
  const barBox = $("barChartBox");
  const heatmapBox = $("heatmapBox");
  if (!barBox || !heatmapBox) return;

  try{
    const t = await getIdToken();
    if (!t) {
      barBox.innerHTML = `<div class="err">認証トークンが取得できません。</div>`;
      heatmapBox.innerHTML = "";
      return;
    }

    const r = await fetch("/api/admin/learning/rubric-analysis", {
      headers:{ Authorization:"Bearer "+t },
      credentials: 'include'
    });

    let j;
    try {
      j = await r.json();
    } catch(parseError) {
      throw new Error(`レスポンスのパースに失敗しました (HTTP ${r.status})`);
    }

    if (!r.ok) {
      const errorMsg = j?.error || `HTTP ${r.status}`;
      console.error('[loadRubricAnalysis] Error:', errorMsg, j);
      throw new Error(errorMsg);
    }

    const { globalItemAvg, studentItemScores } = j;

    if (!globalItemAvg || Object.keys(globalItemAvg).length === 0) {
      barBox.innerHTML = `<div class="muted">データがありません。</div>`;
      heatmapBox.innerHTML = "";
      return;
    }

    // 棒グラフを描画
    renderBarChart(barBox, globalItemAvg);

    // ヒートマップを描画
    renderHeatmap(heatmapBox, studentItemScores, Object.keys(globalItemAvg));

  }catch(e){
    console.error('[loadRubricAnalysis] Exception:', e);
    barBox.innerHTML = `<div class="err">取得失敗: ${esc(e.message||String(e))}</div>`;
    heatmapBox.innerHTML = "";
  }
}

function renderBarChart(container, globalItemAvg) {
  // スコアの高い順にソート
  const items = Object.entries(globalItemAvg).sort((a, b) => b[1] - a[1]);

  const html = `
    <div class="bar-chart">
      ${items.map(([itemName, avgScore]) => {
        const percentage = (avgScore / 2) * 100; // 0-2スケールを0-100%に変換
        let colorClass = 'bad';
        if (avgScore >= 1.5) colorClass = 'good';
        else if (avgScore >= 1.0) colorClass = 'ok';

        return `
          <div class="bar-item">
            <div class="bar-label">${esc(itemName)}</div>
            <div class="bar-track">
              <div class="bar-fill ${colorClass}" style="width:${percentage}%">${avgScore}</div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
    <div class="muted small" style="margin-top:8px">
      <span style="color:#10b981">■</span> 良好(1.5以上)
      <span style="color:#f59e0b;margin-left:12px">■</span> 普通(1.0-1.5)
      <span style="color:#ef4444;margin-left:12px">■</span> 要改善(1.0未満)
    </div>
  `;

  container.innerHTML = html;
}

function renderHeatmap(container, studentItemScores, itemNames) {
  if (!studentItemScores || studentItemScores.length === 0) {
    container.innerHTML = `<div class="muted">学生データがありません。</div>`;
    return;
  }

  // 学生番号順にソート
  const students = studentItemScores.sort((a, b) => (a.userNo || 0) - (b.userNo || 0));

  const html = `
    <div style="overflow:auto">
      <table class="heatmap-table">
        <thead>
          <tr>
            <th style="width:60px">No.</th>
            <th style="width:120px">氏名</th>
            <th style="width:60px">回数</th>
            ${itemNames.map(name => `<th class="heatmap-cell">${esc(name)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${students.map(s => {
            return `
              <tr>
                <td>${s.userNo || "-"}</td>
                <td class="nowrap">${esc(s.name || "")}</td>
                <td>${s.sessionCount || 0}</td>
                ${itemNames.map(itemName => {
                  const score = s.itemScores[itemName];
                  if (score == null) {
                    return `<td class="heatmap-cell">-</td>`;
                  }
                  let colorClass = 'bad';
                  if (score >= 1.5) colorClass = 'good';
                  else if (score >= 1.0) colorClass = 'ok';
                  return `<td class="heatmap-cell ${colorClass}">${score}</td>`;
                }).join("")}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="muted small" style="margin-top:8px">
      <span style="background:#d1fae5;padding:2px 6px">■</span> 良好(1.5以上)
      <span style="background:#fef3c7;padding:2px 6px;margin-left:12px">■</span> 普通(1.0-1.5)
      <span style="background:#fee2e2;padding:2px 6px;margin-left:12px">■</span> 要改善(1.0未満)
    </div>
  `;

  container.innerHTML = html;
}

/* ====================== テキストマイニング分析 ====================== */
async function loadTextMiningAnalysis(){
  const box = $("textMiningBox");
  if (!box) return;

  try{
    const t = await getIdToken();
    if (!t) {
      box.innerHTML = `<div class="err">認証トークンが取得できません。</div>`;
      return;
    }

    const r = await fetch("/api/admin/learning/text-mining", {
      headers:{ Authorization:"Bearer "+t },
      credentials: 'include'
    });

    let j;
    try {
      j = await r.json();
    } catch(parseError) {
      throw new Error(`レスポンスのパースに失敗しました (HTTP ${r.status})`);
    }

    if (!r.ok) {
      const errorMsg = j?.error || `HTTP ${r.status}`;
      console.error('[loadTextMiningAnalysis] Error:', errorMsg, j);
      throw new Error(errorMsg);
    }

    const students = Array.isArray(j.students) ? j.students : [];

    if (students.length === 0) {
      box.innerHTML = `<div class="muted">データがありません。</div>`;
      return;
    }

    // 全体統計を計算
    const globalStats = calculateGlobalTextMiningStats(students);

    // 可視化を描画
    renderTextMiningAnalysis(box, students, globalStats);

  }catch(e){
    console.error('[loadTextMiningAnalysis] Exception:', e);
    box.innerHTML = `<div class="err">取得失敗: ${esc(e.message||String(e))}</div>`;
  }
}

function calculateGlobalTextMiningStats(students) {
  // ヒストグラム用のデータ配列
  const openQuestionRatios = [];
  const empathyWordsCounts = [];
  const opqrstRates = [];

  // 全体の単語頻度を集計
  const nurseWordFreq = {};
  const patientWordFreq = {};
  const nurseUtterances = [];
  const patientUtterances = [];

  for (const s of students) {
    if (s.nurse) {
      openQuestionRatios.push(s.nurse.openQuestionRatio || 0);
      empathyWordsCounts.push(s.nurse.empathyWords || 0);
      opqrstRates.push(s.nurse.opqrstCoverageRate || 0);

      // 看護師の単語頻度を集計
      if (Array.isArray(s.nurse.topWords)) {
        s.nurse.topWords.forEach(item => {
          nurseWordFreq[item.word] = (nurseWordFreq[item.word] || 0) + item.count;
        });
      }

      // 看護師の発話例を収集
      if (Array.isArray(s.nurse.utteranceExamples)) {
        nurseUtterances.push(...s.nurse.utteranceExamples);
      }
    }

    if (s.patient) {
      // 患者の単語頻度を集計
      if (Array.isArray(s.patient.topWords)) {
        s.patient.topWords.forEach(item => {
          patientWordFreq[item.word] = (patientWordFreq[item.word] || 0) + item.count;
        });
      }

      // 患者の発話例を収集
      if (Array.isArray(s.patient.utteranceExamples)) {
        patientUtterances.push(...s.patient.utteranceExamples);
      }
    }
  }

  // ヒストグラムデータを作成
  const createHistogram = (values, ranges) => {
    const bins = ranges.map(r => ({ range: r.label, count: 0, min: r.min, max: r.max }));
    values.forEach(v => {
      for (const bin of bins) {
        if (v >= bin.min && v < bin.max) {
          bin.count++;
          break;
        }
      }
    });
    return bins;
  };

  const openQuestionHistogram = createHistogram(openQuestionRatios, [
    { label: '0-20%', min: 0, max: 20 },
    { label: '20-40%', min: 20, max: 40 },
    { label: '40-60%', min: 40, max: 60 },
    { label: '60-80%', min: 60, max: 80 },
    { label: '80-100%', min: 80, max: 101 }
  ]);

  const empathyWordsHistogram = createHistogram(empathyWordsCounts, [
    { label: '0-2', min: 0, max: 3 },
    { label: '3-5', min: 3, max: 6 },
    { label: '6-10', min: 6, max: 11 },
    { label: '11-15', min: 11, max: 16 },
    { label: '16+', min: 16, max: 99999 }
  ]);

  const opqrstHistogram = createHistogram(opqrstRates, [
    { label: '0-20%', min: 0, max: 20 },
    { label: '20-40%', min: 20, max: 40 },
    { label: '40-60%', min: 40, max: 60 },
    { label: '60-80%', min: 60, max: 80 },
    { label: '80-100%', min: 80, max: 101 }
  ]);

  // TOP 20を抽出（意味のある単語のみ）
  const getTop20 = (freqMap) => {
    return Object.entries(freqMap)
      .filter(([word, count]) => word.length >= 2 && count >= 3) // 2文字以上、3回以上出現
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));
  };

  // 発話をクラスタリング（類似発話をグループ化）
  const clusterUtterances = (utterances) => {
    const clusters = {};

    utterances.forEach(utterance => {
      // 5文字未満は除外
      if (utterance.length < 5) return;

      // 類似発話を探す
      let foundCluster = false;
      let bestMatch = null;
      let bestSimilarity = 0;

      for (const key in clusters) {
        // 簡易的な類似度判定：一方が他方を含む、または45%以上一致
        const similarity = calculateSimilarity(utterance, key);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = key;
        }
      }

      // 45%以上の類似度で既存クラスタに追加
      if (bestMatch && bestSimilarity > 0.45) {
        clusters[bestMatch].count++;
        clusters[bestMatch].examples.push(utterance);
        foundCluster = true;
      }

      if (!foundCluster) {
        clusters[utterance] = { count: 1, examples: [utterance], representative: utterance };
      }
    });

    // 出現頻度順にソート
    return Object.values(clusters)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  };

  return {
    openQuestionHistogram,
    empathyWordsHistogram,
    opqrstHistogram,
    nurseTopWords: getTop20(nurseWordFreq),
    patientTopWords: getTop20(patientWordFreq),
    nurseUtteranceClusters: clusterUtterances(nurseUtterances),
    patientUtteranceClusters: clusterUtterances(patientUtterances)
  };
}

// 簡易的な類似度計算（共通部分文字列の割合）
function calculateSimilarity(str1, str2) {
  const shorter = str1.length < str2.length ? str1 : str2;
  const longer = str1.length < str2.length ? str2 : str1;

  // 一方が他方を含む場合
  if (longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  // 共通部分文字列を探す
  let maxCommon = 0;
  for (let i = 0; i < shorter.length; i++) {
    for (let len = shorter.length - i; len > maxCommon; len--) {
      const substr = shorter.substring(i, i + len);
      if (longer.includes(substr)) {
        maxCommon = Math.max(maxCommon, len);
      }
    }
  }

  return maxCommon / Math.max(str1.length, str2.length);
}

function renderTextMiningAnalysis(container, students, globalStats) {
  // 学生番号順にソート
  const sortedStudents = students.sort((a, b) => (a.userNo || 0) - (b.userNo || 0));

  // ヒストグラム描画用ヘルパー
  const renderHistogram = (data, title, color) => {
    const maxCount = Math.max(...data.map(d => d.count));
    return `
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #e5e7eb">
        <h6 style="color:${color}; margin-bottom:12px">${title}</h6>
        <div style="display:flex; flex-direction:column; gap:8px">
          ${data.map(bin => {
            const percentage = maxCount > 0 ? (bin.count / maxCount) * 100 : 0;
            return `
              <div style="display:flex; align-items:center; gap:8px">
                <div style="width:80px; font-size:0.85em; color:#666">${bin.range}</div>
                <div style="flex:1; background:#f3f4f6; border-radius:4px; height:24px; position:relative; overflow:hidden">
                  <div style="background:${color}; height:100%; width:${percentage}%; transition:width 0.3s"></div>
                </div>
                <div style="width:40px; text-align:right; font-weight:600; font-size:0.9em">${bin.count}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  };

  // 統計サマリーを計算
  const totalStudents = students.length;
  const totalSessions = students.reduce((sum, s) => sum + (s.sessionCount || 0), 0);

  const html = `
    <div style="margin-bottom:24px">
      <div style="background:#fce7f3; border:2px solid #ec4899; border-radius:8px; padding:12px">
        <div style="font-weight:700; font-size:16px; color:#9f1239">
          分析対象: 受講者${totalStudents}名、総セッション数${totalSessions}件
        </div>
      </div>
    </div>

    <div style="margin-bottom:24px">
      <h5>全体統計 - 学生の分布</h5>
      <div class="muted small" style="margin-bottom:8px">
        各指標における学生の分布を示します。横軸は指標の範囲、縦軸は該当学生数です。
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:16px; margin-top:12px">
        ${renderHistogram(globalStats.openQuestionHistogram || [], '開放質問比率の分布', '#4f46e5')}
        ${renderHistogram(globalStats.empathyWordsHistogram || [], '共感語使用の分布', '#0891b2')}
        ${renderHistogram(globalStats.opqrstHistogram || [], 'OPQRST網羅率の分布', '#059669')}
      </div>
    </div>

    <div>
      <h5>学生別の対話特徴</h5>
      <div class="muted small" style="margin-bottom:8px">
        各学生の対話特徴を詳細に分析した結果です。看護師役の発話の質と患者役の応答特性を評価しています。
      </div>
      <div style="overflow:auto">
        <table class="tm-table">
          <thead>
            <tr>
              <th rowspan="2" style="width:60px">No.</th>
              <th rowspan="2" style="width:120px">氏名</th>
              <th rowspan="2" style="width:60px">回数</th>
              <th colspan="5" style="background:#eef2ff">看護師の対話特徴</th>
              <th colspan="2" style="background:#fef3c7">患者の応答</th>
            </tr>
            <tr>
              <th style="background:#eef2ff">開放質問比率</th>
              <th style="background:#eef2ff">共感語</th>
              <th style="background:#eef2ff">OPQRST網羅率</th>
              <th style="background:#eef2ff">平均発話長</th>
              <th style="background:#eef2ff">総発言数</th>
              <th style="background:#fef3c7">平均発話長</th>
              <th style="background:#fef3c7">総応答数</th>
            </tr>
          </thead>
          <tbody>
            ${sortedStudents.map(s => renderTextMiningRow(s)).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div style="margin-top:32px">
      <h5>頻出語分析 (TOP 20)</h5>
      <div class="muted small" style="margin-bottom:8px">
        看護師役と患者役の発話から自動抽出した頻出語彙です。カタカナ、漢字＋ひらがな、ひらがな（3文字以上）のパターンで抽出しています。
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px">
        <div>
          <h6 style="color:#4f46e5; margin-bottom:8px">看護師の頻出語</h6>
          <div style="background:#f5f5f5; padding:12px; border-radius:6px; max-height:300px; overflow-y:auto">
            ${(globalStats.nurseTopWords || []).map((item, idx) => `
              <div style="display:flex; justify-content:space-between; padding:4px 8px; ${idx % 2 === 0 ? 'background:white' : ''}; border-radius:3px">
                <span style="font-weight:500">${esc(item.word)}</span>
                <span style="color:#666; font-size:0.9em">${item.count}回</span>
              </div>
            `).join("")}
          </div>
        </div>
        <div>
          <h6 style="color:#d97706; margin-bottom:8px">患者の頻出語</h6>
          <div style="background:#fef3c7; padding:12px; border-radius:6px; max-height:300px; overflow-y:auto">
            ${(globalStats.patientTopWords || []).map((item, idx) => `
              <div style="display:flex; justify-content:space-between; padding:4px 8px; ${idx % 2 === 0 ? 'background:white' : ''}; border-radius:3px">
                <span style="font-weight:500">${esc(item.word)}</span>
                <span style="color:#666; font-size:0.9em">${item.count}回</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>

    <div style="margin-top:32px">
      <h5>頻出発話パターン - 類似発話をグループ化</h5>
      <div class="muted small" style="margin-bottom:8px">
        類似度45%以上の発話を自動的にグループ化し、出現頻度順に表示しています。各パターンの代表的な発話と、バリエーションを確認できます。
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px">
        <div>
          <h6 style="color:#4f46e5; margin-bottom:8px">看護師の発話パターン（出現頻度順）</h6>
          <div style="background:#eef2ff; padding:12px; border-radius:6px; max-height:500px; overflow-y:auto">
            ${(globalStats.nurseUtteranceClusters || []).map((cluster, idx) => `
              <div style="background:white; padding:12px; margin-bottom:10px; border-radius:6px; border-left:4px solid #4f46e5">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
                  <span style="background:#4f46e5; color:white; padding:2px 8px; border-radius:12px; font-size:0.85em; font-weight:600">${cluster.count}回</span>
                  <span style="color:#666; font-size:0.8em">${cluster.examples.length}バリエーション</span>
                </div>
                <div style="font-size:0.9em; line-height:1.5">
                  ${esc(cluster.representative)}
                </div>
                ${cluster.examples.length > 1 ? `
                  <details style="margin-top:8px">
                    <summary style="cursor:pointer; color:#4f46e5; font-size:0.85em">類似発話を表示 (${cluster.examples.length - 1}件)</summary>
                    <div style="margin-top:6px; padding-left:8px; border-left:2px solid #e5e7eb">
                      ${cluster.examples.slice(1, 6).map(ex => `
                        <div style="font-size:0.85em; color:#666; margin-top:4px">• ${esc(ex)}</div>
                      `).join('')}
                      ${cluster.examples.length > 6 ? `<div style="font-size:0.8em; color:#999; margin-top:4px">...他${cluster.examples.length - 6}件</div>` : ''}
                    </div>
                  </details>
                ` : ''}
              </div>
            `).join("")}
          </div>
        </div>
        <div>
          <h6 style="color:#d97706; margin-bottom:8px">患者の発話パターン（出現頻度順）</h6>
          <div style="background:#fef9e6; padding:12px; border-radius:6px; max-height:500px; overflow-y:auto">
            ${(globalStats.patientUtteranceClusters || []).map((cluster, idx) => `
              <div style="background:white; padding:12px; margin-bottom:10px; border-radius:6px; border-left:4px solid #d97706">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
                  <span style="background:#d97706; color:white; padding:2px 8px; border-radius:12px; font-size:0.85em; font-weight:600">${cluster.count}回</span>
                  <span style="color:#666; font-size:0.8em">${cluster.examples.length}バリエーション</span>
                </div>
                <div style="font-size:0.9em; line-height:1.5">
                  ${esc(cluster.representative)}
                </div>
                ${cluster.examples.length > 1 ? `
                  <details style="margin-top:8px">
                    <summary style="cursor:pointer; color:#d97706; font-size:0.85em">類似発話を表示 (${cluster.examples.length - 1}件)</summary>
                    <div style="margin-top:6px; padding-left:8px; border-left:2px solid #e5e7eb">
                      ${cluster.examples.slice(1, 6).map(ex => `
                        <div style="font-size:0.85em; color:#666; margin-top:4px">• ${esc(ex)}</div>
                      `).join('')}
                      ${cluster.examples.length > 6 ? `<div style="font-size:0.8em; color:#999; margin-top:4px">...他${cluster.examples.length - 6}件</div>` : ''}
                    </div>
                  </details>
                ` : ''}
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="muted small" style="margin-top:24px">
      <strong>用語説明:</strong><br>
      • <strong>開放質問比率</strong>: 「どのように」「何が」などの開放質問の割合<br>
      • <strong>共感語</strong>: 「つらい」「大変」などの共感表現の使用回数<br>
      • <strong>OPQRST網羅率</strong>: 発症時期・緩和因子・性質・放散・重症度・時間の確認率<br>
      • <strong>平均発話長</strong>: 1回の発言の平均文字数<br>
      • <strong>頻出語</strong>: 全学生の対話で最も多く使われた単語<br>
      • <strong>語の組み合わせ</strong>: 2つの語が連続して現れるパターン<br>
      • <strong>発話例</strong>: 実際に使われた発言のサンプル（システム評価用）
    </div>
  `;

  container.innerHTML = html;
}

function renderTextMiningRow(s) {
  const nurse = s.nurse || {};
  const patient = s.patient || {};

  // 色分け用のクラス
  const getOpenQuestionClass = (ratio) => {
    if (ratio >= 60) return 'style="background:#d1fae5;color:#065f46"';
    if (ratio >= 40) return 'style="background:#fef3c7;color:#92400e"';
    return 'style="background:#fee2e2;color:#991b1b"';
  };

  const getOpqrstClass = (rate) => {
    if (rate >= 80) return 'style="background:#d1fae5;color:#065f46"';
    if (rate >= 50) return 'style="background:#fef3c7;color:#92400e"';
    return 'style="background:#fee2e2;color:#991b1b"';
  };

  return `
    <tr>
      <td>${s.userNo || "-"}</td>
      <td class="nowrap">${esc(s.name || "")}</td>
      <td>${s.sessionCount || 0}</td>
      <td ${getOpenQuestionClass(nurse.openQuestionRatio || 0)}>${nurse.openQuestionRatio || 0}%</td>
      <td>${nurse.empathyWords || 0}</td>
      <td ${getOpqrstClass(nurse.opqrstCoverageRate || 0)}>${nurse.opqrstCoverageRate || 0}%</td>
      <td>${nurse.avgLength || 0}</td>
      <td>${nurse.totalMessages || 0}</td>
      <td>${patient.avgLength || 0}</td>
      <td>${patient.totalMessages || 0}</td>
    </tr>
  `;
}

/* ====================== AI分析 ====================== */
async function mountAIAnalysisPane() {
  const pane = $("pane-ai-analysis");
  if (!pane) return;

  pane.innerHTML = `
    <h3>AI分析</h3>
    <div class="muted small" style="margin-bottom:1rem">
      全学生の対話データをAIが分析します。自然言語で質問を入力してください。<br>
      <strong>例:</strong> 「学生の傾向を分析してください」「開放質問の使用状況を教えてください」「改善が必要な学生は誰ですか」
    </div>

    <div style="display:flex; gap:1rem; align-items:flex-start">
      <!-- 左側: 分析履歴リスト -->
      <div style="flex:0 0 280px; max-height:600px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:6px; padding:8px">
        <div style="font-weight:600; margin-bottom:8px; padding:4px">分析履歴</div>
        <div id="ai-history-list-admin">
          <div class="muted small" style="padding:8px">読み込み中...</div>
        </div>
      </div>

      <!-- 右側: 新規分析 & 詳細表示 -->
      <div style="flex:1">
        <div style="margin-bottom:1.5rem">
          <label style="display:block; margin-bottom:0.5rem; font-weight:600">質問を入力:</label>
          <textarea id="ai-query-admin" rows="3" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; font-size:14px"
            placeholder="例: 全学生の対話の傾向を分析し、良い点と改善点を教えてください"></textarea>
          <button id="ai-analyze-btn-admin" style="margin-top:0.5rem; padding:10px 20px; background:#ec4899; color:white; border:none; border-radius:12px; cursor:pointer; font-size:14px; font-weight:600">
            分析を実行
          </button>
        </div>

        <div id="ai-result-admin" style="display:none">
          <h4>分析結果</h4>
          <div id="ai-metadata-admin" style="background:#f3f4f6; padding:12px; border-radius:6px; margin-bottom:1rem; font-size:0.9em"></div>
          <div id="ai-content-admin" style="background:white; padding:20px; border:1px solid #e5e7eb; border-radius:6px; line-height:1.8"></div>
        </div>

        <div id="ai-loading-admin" style="display:none; text-align:center; padding:2rem">
          <div style="font-size:2rem">⏳</div>
          <div>AIが分析中です。しばらくお待ちください...</div>
        </div>

        <div id="ai-error-admin" style="display:none" class="err"></div>
      </div>
    </div>
  `;

  // 分析ボタンのイベントリスナー
  const analyzeBtn = document.getElementById("ai-analyze-btn-admin");
  const queryInput = document.getElementById("ai-query-admin");

  if (analyzeBtn && queryInput) {
    analyzeBtn.addEventListener("click", async () => {
      const query = queryInput.value.trim();
      if (!query) {
        alert("質問を入力してください");
        return;
      }

      await executeAIAnalysisAdmin(query);
    });
  }

  // 画面を開いたときに入力欄と結果をクリア
  if (queryInput) queryInput.value = "";
  const resultDiv = document.getElementById("ai-result-admin");
  if (resultDiv) resultDiv.style.display = "none";

  // 履歴を読み込む
  loadAdminAIAnalysisHistory();
}

async function executeAIAnalysisAdmin(query) {
  const loadingDiv = document.getElementById("ai-loading-admin");
  const errorDiv = document.getElementById("ai-error-admin");
  const resultDiv = document.getElementById("ai-result-admin");
  const metadataDiv = document.getElementById("ai-metadata-admin");
  const contentDiv = document.getElementById("ai-content-admin");

  // UI状態リセット
  if (loadingDiv) loadingDiv.style.display = "block";
  if (errorDiv) errorDiv.style.display = "none";
  if (resultDiv) resultDiv.style.display = "none";

  try {
    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    const response = await fetch("/api/admin/ai-analysis", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      credentials: "include",
      body: JSON.stringify({ query })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    // 結果を表示
    if (loadingDiv) loadingDiv.style.display = "none";
    if (resultDiv) resultDiv.style.display = "block";

    // メタデータ表示
    if (metadataDiv && result.metadata) {
      const hasUnevaluated = result.metadata.sessionsWithoutScore > 0;
      metadataDiv.innerHTML = `
        <strong>データ概要:</strong>
        合計セッション数: ${result.metadata.totalSessions}
        ${hasUnevaluated ? `（評価済み: ${result.metadata.sessionsWithScore}, 評価未実行: ${result.metadata.sessionsWithoutScore}）` : ''} |
        学生数: ${result.metadata.totalUsers} |
        平均スコア: ${result.metadata.avgScore}点（評価済みセッションのみ）
        ${hasUnevaluated ? `<br><span style="color:#d97706; font-weight:600;">⚠️ ${result.metadata.sessionsWithoutScore}個のセッションで評価が未実行です。学生に対話後は必ず「評価に進む」ボタンを押すよう指導してください。</span>` : ''}
      `;
    }

    // AI分析結果をマークダウンとして表示
    if (contentDiv) {
      // marked.jsが利用可能な場合はマークダウンをレンダリング
      if (typeof marked !== 'undefined') {
        contentDiv.innerHTML = marked.parse(result.analysis);

        // Mermaidグラフをレンダリング
        if (typeof mermaid !== 'undefined') {
          setTimeout(() => {
            const mermaidDivs = contentDiv.querySelectorAll('code.language-mermaid');
            mermaidDivs.forEach((code, index) => {
              const pre = code.parentElement;
              const mermaidDiv = document.createElement('div');
              mermaidDiv.className = 'mermaid';
              mermaidDiv.textContent = code.textContent;
              pre.replaceWith(mermaidDiv);
            });
            mermaid.run({ querySelector: '.mermaid' });
          }, 100);
        }

        // Chart.jsグラフをレンダリング
        if (typeof Chart !== 'undefined') {
          setTimeout(() => {
            const chartCodeBlocks = contentDiv.querySelectorAll('code.language-chartjs');
            chartCodeBlocks.forEach((code, index) => {
              try {
                const chartConfig = JSON.parse(code.textContent);
                const pre = code.parentElement;

                // キャンバスコンテナを作成
                const canvasContainer = document.createElement('div');
                canvasContainer.style.cssText = 'max-width: 600px; margin: 20px auto; padding: 20px; background: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';

                const canvas = document.createElement('canvas');
                canvas.id = `chart-admin-${index}`;
                canvasContainer.appendChild(canvas);
                pre.replaceWith(canvasContainer);

                // Chart.jsでグラフを描画
                new Chart(canvas.getContext('2d'), chartConfig);
              } catch (error) {
                console.error('[Chart.js] Failed to render chart:', error);
              }
            });
          }, 150);
        }
      } else {
        // フォールバック: プレーンテキスト表示
        contentDiv.innerHTML = `<pre style="white-space: pre-wrap; font-family: inherit">${esc(result.analysis)}</pre>`;
      }
    }

  } catch (error) {
    console.error("[AI Analysis Admin] Error:", error);
    if (loadingDiv) loadingDiv.style.display = "none";
    if (errorDiv) {
      errorDiv.style.display = "block";
      errorDiv.textContent = `エラー: ${error.message}`;
    }
  } finally {
    // 分析完了後に入力欄をクリアして履歴をリロード
    const queryInput = document.getElementById("ai-query-admin");
    if (queryInput) queryInput.value = "";
    loadAdminAIAnalysisHistory();
  }
}

// 管理者用AI分析履歴読み込み関数
async function loadAdminAIAnalysisHistory() {
  const listDiv = document.getElementById("ai-history-list-admin");
  if (!listDiv) return;

  try {
    const token = await getIdToken();
    if (!token) {
      listDiv.innerHTML = '<div class="muted small" style="padding:8px">認証が必要です</div>';
      return;
    }

    const response = await fetch("/api/admin/ai-analysis-history", {
      headers: { "Authorization": `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.ok || !result.history || result.history.length === 0) {
      listDiv.innerHTML = '<div class="muted small" style="padding:8px">履歴がありません</div>';
      return;
    }

    // 履歴アイテムをレンダリング
    listDiv.innerHTML = result.history.map(item => {
      const date = new Date(item.createdAt).toLocaleString('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      const queryPreview = item.query.length > 40
        ? item.query.substring(0, 40) + '...'
        : item.query;

      return `
        <div class="admin-history-item" data-id="${item.id}" style="padding:8px; cursor:pointer; border-bottom:1px solid #f3f4f6; transition:background 0.2s">
          <div style="font-size:0.75em; color:#9ca3af; margin-bottom:2px">${date}</div>
          <div style="font-size:0.85em; color:#374151">${escapeHtmlAdmin(queryPreview)}</div>
        </div>
      `;
    }).join('');

    // クリックハンドラーを追加
    listDiv.querySelectorAll('.admin-history-item').forEach(item => {
      item.addEventListener('click', async function() {
        const itemId = this.dataset.id;
        const historyItem = result.history.find(h => h.id === itemId);
        if (historyItem) {
          await displayAdminHistoryItem(historyItem);
        }
      });

      // ホバーエフェクト
      item.addEventListener('mouseenter', function() {
        this.style.background = '#f9fafb';
      });
      item.addEventListener('mouseleave', function() {
        this.style.background = 'transparent';
      });
    });

  } catch (error) {
    console.error('[AI Analysis History Admin] Failed to load:', error);
    listDiv.innerHTML = '<div class="muted small" style="padding:8px; color:#dc2626">履歴の読み込みに失敗しました</div>';
  }
}

// 管理者用履歴アイテムを表示する関数
async function displayAdminHistoryItem(item) {
  const resultDiv = document.getElementById("ai-result-admin");
  const metadataDiv = document.getElementById("ai-metadata-admin");
  const contentDiv = document.getElementById("ai-content-admin");
  const loadingDiv = document.getElementById("ai-loading-admin");
  const errorDiv = document.getElementById("ai-error-admin");

  // UI状態リセット
  if (loadingDiv) loadingDiv.style.display = "none";
  if (errorDiv) errorDiv.style.display = "none";
  if (resultDiv) resultDiv.style.display = "block";

  // メタデータ表示
  if (metadataDiv && item.metadata) {
    const hasUnevaluated = item.metadata.sessionsWithoutScore > 0;
    metadataDiv.innerHTML = `
      <strong>データ概要（分析時点）:</strong>
      合計セッション数: ${item.metadata.totalSessions}
      ${hasUnevaluated ? `（評価済み: ${item.metadata.sessionsWithScore}, 評価未実行: ${item.metadata.sessionsWithoutScore}）` : ''} |
      学生数: ${item.metadata.totalUsers} |
      平均スコア: ${item.metadata.avgScore}点（評価済みセッションのみ）
    `;
  }

  // AI分析結果をマークダウンとして表示
  if (contentDiv) {
    if (typeof marked !== 'undefined') {
      contentDiv.innerHTML = marked.parse(item.analysis);

      // Mermaidグラフをレンダリング
      if (typeof mermaid !== 'undefined') {
        setTimeout(() => {
          const mermaidDivs = contentDiv.querySelectorAll('code.language-mermaid');
          mermaidDivs.forEach((code, index) => {
            const pre = code.parentElement;
            const mermaidDiv = document.createElement('div');
            mermaidDiv.className = 'mermaid';
            mermaidDiv.textContent = code.textContent;
            pre.replaceWith(mermaidDiv);
          });
          mermaid.run({ querySelector: '.mermaid' });
        }, 100);
      }

      // Chart.jsグラフをレンダリング
      if (typeof Chart !== 'undefined') {
        setTimeout(() => {
          const chartCodeBlocks = contentDiv.querySelectorAll('code.language-chartjs');
          chartCodeBlocks.forEach((code, index) => {
            try {
              const chartConfig = JSON.parse(code.textContent);
              const pre = code.parentElement;

              const canvasContainer = document.createElement('div');
              canvasContainer.style.cssText = 'max-width: 600px; margin: 20px auto; padding: 20px; background: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';

              const canvas = document.createElement('canvas');
              canvas.id = `chart-admin-history-${index}-${Date.now()}`;
              canvasContainer.appendChild(canvas);
              pre.replaceWith(canvasContainer);

              new Chart(canvas.getContext('2d'), chartConfig);
            } catch (error) {
              console.error('[Chart.js] Failed to render chart:', error);
            }
          });
        }, 150);
      }
    } else {
      contentDiv.innerHTML = `<pre style="white-space: pre-wrap; font-family: inherit">${escapeHtmlAdmin(item.analysis)}</pre>`;
    }
  }
}

// HTMLエスケープ関数（管理者用）
function escapeHtmlAdmin(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/* ====================== キーワード設定 (Version 3.40: シナリオ削除) ====================== */
async function mountScenariosPane() {
  const saveBtn = $("saveScenarioConfig");
  const statusSpan = $("scenarioConfigStatus");

  if (!saveBtn) return;

  // キーワード設定を読み込む（シナリオID "global" を使用）
  const loadKeywordConfig = async () => {
    statusSpan.textContent = "読み込み中...";
    statusSpan.style.color = "#6b7280";

    try {
      const token = await getIdToken();
      if (!token) {
        statusSpan.textContent = "認証エラー";
        statusSpan.style.color = "#ef4444";
        return;
      }

      // Version 3.40: シナリオ削除のため、"global" という固定IDを使用
      const res = await fetch(`/api/scenarios/global/config`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.ok && data.config) {
        // バイタルサインのキーワードを入力欄に表示
        const vitalKeywords = data.config.vitalKeywords || {};
        $("vital_temperature").value = (vitalKeywords.temperature || []).join(", ");
        $("vital_bloodPressure").value = (vitalKeywords.bloodPressure || []).join(", ");
        $("vital_pulse").value = (vitalKeywords.pulse || []).join(", ");
        $("vital_respiration").value = (vitalKeywords.respiration || []).join(", ");
        $("vital_spo2").value = (vitalKeywords.spo2 || []).join(", ");

        // 身体診察のキーワードを入力欄に表示
        const examKeywords = data.config.examKeywords || {};
        $("exam_inspection").value = (examKeywords.inspection || []).join(", ");
        $("exam_palpation").value = (examKeywords.palpation || []).join(", ");
        $("exam_auscultation").value = (examKeywords.auscultation || []).join(", ");
        $("exam_percussion").value = (examKeywords.percussion || []).join(", ");

        statusSpan.textContent = "";
      }
    } catch (err) {
      console.error("Failed to load keyword config:", err);
      statusSpan.textContent = "読み込みエラー";
      statusSpan.style.color = "#ef4444";
    }
  };

  // 保存ボタンのイベントハンドラ
  const saveConfig = async () => {
    statusSpan.textContent = "保存中...";
    statusSpan.style.color = "#6b7280";

    try {
      const token = await getIdToken();
      if (!token) {
        statusSpan.textContent = "認証エラー";
        statusSpan.style.color = "#ef4444";
        return;
      }

      // 入力値を配列に変換（カンマ区切り → trim → 空文字列を除外）
      const parseKeywords = (value) => {
        return value.split(",").map(k => k.trim()).filter(k => k.length > 0);
      };

      const vitalKeywords = {
        temperature: parseKeywords($("vital_temperature").value),
        bloodPressure: parseKeywords($("vital_bloodPressure").value),
        pulse: parseKeywords($("vital_pulse").value),
        respiration: parseKeywords($("vital_respiration").value),
        spo2: parseKeywords($("vital_spo2").value)
      };

      const examKeywords = {
        inspection: parseKeywords($("exam_inspection").value),
        palpation: parseKeywords($("exam_palpation").value),
        auscultation: parseKeywords($("exam_auscultation").value),
        percussion: parseKeywords($("exam_percussion").value)
      };

      // Version 3.40: シナリオ削除のため、"global" という固定IDを使用
      const res = await fetch(`/api/admin/scenarios/global/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ vitalKeywords, examKeywords })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.ok) {
        statusSpan.textContent = "✓ 保存しました";
        statusSpan.style.color = "#10b981";
        setTimeout(() => {
          statusSpan.textContent = "";
        }, 3000);
      }
    } catch (err) {
      console.error("Failed to save scenario config:", err);
      statusSpan.textContent = "保存エラー";
      statusSpan.style.color = "#ef4444";
    }
  };

  // イベントリスナーを設定（重複を防ぐため一度削除してから追加）
  saveBtn.removeEventListener("click", saveConfig);
  saveBtn.addEventListener("click", saveConfig);

  // 初回読み込み
  await loadKeywordConfig();
}

/* =======================================================================
 * 患者作成パネル (Version 3.0)
 * 症状別モードから移行、Admin専用の患者プロフィール作成機能
 * ======================================================================= */
async function mountPatientCreationPane() {
  const pane = $("pane-patient-creation");
  if (!pane) return;

  pane.innerHTML = `
    <h3>患者管理</h3>
    <div class="muted small" style="margin-bottom:16px">
      AIを使用して患者プロフィールを生成します。生成後、内容を編集してから保存できます。
      <br>作成した患者は全学生が「問診練習」で使用できます。
    </div>

    <!-- 患者生成フォーム -->
    <div class="card" style="padding:20px; margin-bottom:24px; background:#f9fafb">
      <h4 style="margin-top:0; color:#ec4899">新規患者プロフィール生成</h4>

      <div style="margin-bottom:20px">
        <label style="display:block; margin-bottom:8px; font-weight:600">症状キーワード <span class="muted small">（必須）</span></label>
        <textarea id="pcSymptomKeywords" rows="2" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:6px; font-size:14px"
          placeholder="例: 胸痛、息切れ、冷や汗"></textarea>
        <div class="muted small" style="margin-top:4px">患者が訴える主な症状をカンマ区切りで入力してください</div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px">
        <div>
          <label style="display:block; margin-bottom:8px; font-weight:600">言語</label>
          <select id="pcLanguage" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:6px; font-size:14px">
            <option value="ja">日本語</option>
            <option value="en">英語</option>
            <option value="ko">韓国語</option>
            <option value="zh">中国語</option>
            <option value="th">タイ語</option>
          </select>
        </div>

        <div id="pcBrokenJapaneseContainer" style="display:none">
          <label style="display:block; margin-bottom:8px; font-weight:600">カタコト日本語</label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
            <input type="checkbox" id="pcBrokenJapanese" style="width:20px; height:20px; cursor:pointer">
            <span>簡単な日本語で会話する</span>
          </label>
          <div class="muted small" style="margin-top:4px">
            チェックすると、英語患者が約100文字程度の簡単な日本語を理解・話せるようになります
          </div>
        </div>
      </div>

      <div style="margin-top:20px">
        <button id="pcGenerateBtn" class="primary" style="padding:12px 24px; font-size:15px">
          ✨ AIで患者プロフィールを生成
        </button>
        <span id="pcGenerateStatus" class="muted small" style="margin-left:12px"></span>
      </div>
    </div>

    <!-- 生成結果プレビュー＆編集 -->
    <div id="pcPreviewArea" style="display:none">
      <div class="card" style="padding:20px; background:white; border:2px solid #ec4899">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
          <h4 style="margin:0; color:#ec4899">生成された患者プロフィール（編集可能）</h4>
          <button id="pcResetBtn" class="secondary" style="font-size:13px">🔄 最初から作り直す</button>
        </div>

        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:20px">
          <div>
            <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">患者氏名</label>
            <input type="text" id="pcPatientName" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
          </div>
          <div>
            <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">年齢</label>
            <input type="number" id="pcPatientAge" min="0" max="120" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
          </div>
          <div>
            <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">性別</label>
            <select id="pcPatientGender" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
              <option value="male">男性</option>
              <option value="female">女性</option>
            </select>
          </div>
        </div>

        <div style="margin-bottom:20px">
          <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">年齢帯</label>
          <select id="pcPatientAgeBand" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
            <option value="child">子供</option>
            <option value="adult">大人</option>
            <option value="elderly">高齢者</option>
          </select>
        </div>

        <div style="margin-bottom:20px">
          <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">患者プロフィール詳細</label>
          <textarea id="pcProfileText" rows="8" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; line-height:1.6; min-height:180px; resize:vertical"></textarea>
          <div class="muted small" style="margin-top:4px">
            この内容がAI患者のベースとなります。症状の詳細、経過、患者の背景などを含めてください。
          </div>
        </div>

        <div style="margin-bottom:20px">
          <label style="display:block; margin-bottom:6px; font-weight:600; color:#6b7280">制限時間（秒）</label>
          <select id="pcTimeLimit" style="width:250px; padding:8px; border:1px solid #d1d5db; border-radius:4px">
            <option value="30">30秒</option>
            <option value="60">1分（60秒）</option>
            <option value="90">1分30秒</option>
            <option value="120">2分（120秒）</option>
            <option value="150">2分30秒</option>
            <option value="180" selected>3分（180秒）</option>
            <option value="210">3分30秒</option>
            <option value="240">4分（240秒）</option>
            <option value="270">4分30秒</option>
            <option value="300">5分（300秒）</option>
            <option value="360">6分（360秒）</option>
            <option value="420">7分（420秒）</option>
            <option value="480">8分（480秒）</option>
            <option value="540">9分（540秒）</option>
            <option value="600">10分（600秒）</option>
          </select>
        </div>

        <!-- Version 3.42: 想定バイタル異常設定 -->
        <div style="margin:20px 0; padding:20px; background:#fef3c7; border-radius:8px; border:1px solid #fbbf24">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px">
            <h4 style="margin:0; color:#92400e">📊 想定バイタル異常</h4>
            <button id="pcAddCustomVital" class="secondary" style="font-size:12px; padding:4px 12px">＋ カスタム項目追加</button>
          </div>
          <div class="muted small" style="margin-bottom:16px; color:#78350f">
            この患者で異常となるバイタルサインを選択してください。選択された項目は練習時に異常値が表示されます。
          </div>
          
          <!-- デフォルト7項目 -->
          <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px; transition:all 0.2s">
              <input type="checkbox" id="pcVital_fever" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">🌡️ 発熱（37.5℃以上）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_highBP" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">⬆️ 高血圧（140/90以上）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_lowBP" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">⬇️ 低血圧（100/60以下）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_tachycardia" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">💓 頻脈（90回/分以上）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_bradycardia" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">💙 徐脈（60回/分以下）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_tachypnea" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">🫁 頻呼吸（20回/分以上）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:10px; background:white; border:1px solid #d1d5db; border-radius:6px">
              <input type="checkbox" id="pcVital_hypoxia" class="vital-checkbox" style="width:18px; height:18px; cursor:pointer">
              <span style="font-weight:600">🫧 低酸素（酸素飽和度 95%未満）</span>
            </label>
          </div>

          <!-- カスタム項目エリア -->
          <div id="pcCustomVitalsArea" style="margin-top:12px"></div>
        </div>

        <div style="margin-top:24px; padding-top:20px; border-top:2px solid #e5e7eb">
          <button id="pcSaveBtn" class="primary" style="padding:12px 32px; font-size:16px; font-weight:600">
            患者を保存
          </button>
          <button id="pcCancelBtn" class="secondary" style="display:none; padding:12px 32px; font-size:16px; font-weight:600; margin-left:12px">
            キャンセル
          </button>
          <span id="pcSaveStatus" class="muted small" style="margin-left:12px"></span>
        </div>
      </div>
    </div>

    <!-- 保存済み患者一覧 -->
    <div style="margin-top:32px">
      <h4>保存済み患者一覧</h4>
      <div class="muted small" style="margin-bottom:12px">管理者が作成した患者の一覧です。編集・削除ができます。</div>
      <div id="pcPatientListArea">
        <div class="muted">読み込み中...</div>
      </div>
    </div>
  `;

  // 言語選択でカタコトチェックボックスの表示を制御
  const langSelect = $("pcLanguage");
  const brokenJapaneseContainer = $("pcBrokenJapaneseContainer");
  const updateBrokenJapaneseVisibility = () => {
    const isEnglish = langSelect && langSelect.value === "en";
    if (brokenJapaneseContainer) {
      brokenJapaneseContainer.style.display = isEnglish ? "block" : "none";
    }
    if (!isEnglish) {
      const checkbox = $("pcBrokenJapanese");
      if (checkbox) checkbox.checked = false;
    }
  };
  if (langSelect) {
    langSelect.addEventListener("change", updateBrokenJapaneseVisibility);
    updateBrokenJapaneseVisibility();
  }

  // 生成ボタン
  const generateBtn = $("pcGenerateBtn");
  if (generateBtn) {
    generateBtn.addEventListener("click", async () => {
      await generatePatientProfile();
    });
  }

  // リセットボタン
  const resetBtn = $("pcResetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const previewArea = $("pcPreviewArea");
      if (previewArea) previewArea.style.display = "none";
      
      // フォームをクリア
      const symptomInput = $("pcSymptomKeywords");
      if (symptomInput) symptomInput.value = "";
      
      const statusSpan = $("pcGenerateStatus");
      if (statusSpan) statusSpan.textContent = "";
    });
  }

  // Version 3.42: カスタムバイタル項目追加ボタン
  // Version 3.45: グローバルカウンターと関数化
  window.customVitalCounter = window.customVitalCounter || 0;
  
  // カスタムバイタル項目を追加する関数
  window.addCustomVitalItem = function(customId, label, description, checked) {
    const customArea = $("pcCustomVitalsArea");
    if (!customArea) return;
    
    if (!customId) {
      window.customVitalCounter++;
      customId = `custom${window.customVitalCounter}`;
    } else {
      // 既存IDの番号を抽出してカウンターを更新
      const match = customId.match(/custom(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= window.customVitalCounter) {
          window.customVitalCounter = num + 1;
        }
      }
    }
    
    const customDiv = document.createElement("div");
    customDiv.id = `pcVital_${customId}_container`;
    customDiv.style.cssText = "margin-top:12px; padding:12px; background:white; border:1px solid #d1d5db; border-radius:6px";
    customDiv.innerHTML = `
      <div style="display:flex; gap:12px; align-items:center">
        <label style="flex:1">
          <div style="font-size:12px; color:#6b7280; margin-bottom:4px">項目名（キーワード）</div>
          <input type="text" id="pcVital_${customId}_label" placeholder="例: 体温" 
            value="${esc(label || '')}"
            style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
        </label>
        <label style="flex:2">
          <div style="font-size:12px; color:#6b7280; margin-bottom:4px">説明（表示用）</div>
          <input type="text" id="pcVital_${customId}_desc" placeholder="例: 35℃以下" 
            value="${esc(description || '')}"
            style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px">
        </label>
        <button onclick="document.getElementById('pcVital_${customId}_container').remove()" 
          style="margin-top:20px; padding:8px 12px; background:#ef4444; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px">
          削除
        </button>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-top:8px; cursor:pointer">
        <input type="checkbox" id="pcVital_${customId}" class="vital-checkbox custom-vital" 
          ${checked ? 'checked' : ''}
          style="width:18px; height:18px; cursor:pointer">
        <span style="font-weight:600; font-size:14px">この項目を有効にする</span>
      </label>
    `;
    customArea.appendChild(customDiv);
  };
  
  const addCustomVitalBtn = $("pcAddCustomVital");
  if (addCustomVitalBtn) {
    addCustomVitalBtn.addEventListener("click", () => {
      window.addCustomVitalItem();
    });
  }

  // 保存ボタン
  // Version 3.45: 編集モード判定を追加
  const saveBtn = $("pcSaveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      // 編集モードかどうかを確認
      const isEditMode = saveBtn.dataset.editMode === "true";
      const patientId = saveBtn.dataset.editPatientId;
      
      if (isEditMode && patientId) {
        await updateAdminPatient(patientId);
      } else {
        await saveAdminPatient();
      }
    });
  }

  // キャンセルボタン
  const cancelBtn = $("pcCancelBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      // プレビューエリアを非表示
      const previewArea = $("pcPreviewArea");
      if (previewArea) previewArea.style.display = "none";
      
      // フォームをクリア
      const symptomInput = $("pcSymptomKeywords");
      if (symptomInput) symptomInput.value = "";
      
      const statusSpan = $("pcGenerateStatus");
      if (statusSpan) statusSpan.textContent = "";
      
      const saveStatusSpan = $("pcSaveStatus");
      if (saveStatusSpan) saveStatusSpan.textContent = "";
      
      // 保存ボタンを元に戻す（Version 3.45: dataset も クリア）
      if (saveBtn) {
        saveBtn.textContent = "患者を保存";
        saveBtn.dataset.editMode = "false";
        saveBtn.dataset.editPatientId = "";
      }
      
      // カスタムバイタル項目をクリア
      const customArea = $("pcCustomVitalsArea");
      if (customArea) customArea.innerHTML = "";
      
      // キャンセルボタンを非表示
      if (cancelBtn) cancelBtn.style.display = "none";
    });
  }

  // 保存済み患者一覧を読み込む
  await loadAdminPatientList();
}

// AIで患者プロフィールを生成
async function generatePatientProfile() {
  // Version 3.45: 編集モードをクリア（AI生成は新規作成とみなす）
  const saveBtn = $("pcSaveBtn");
  if (saveBtn) {
    saveBtn.textContent = "患者を保存";
    saveBtn.dataset.editMode = "false";
    saveBtn.dataset.editPatientId = "";
  }
  
  const symptomInput = $("pcSymptomKeywords");
  const languageSelect = $("pcLanguage");
  const brokenJapaneseCheckbox = $("pcBrokenJapanese");
  const statusSpan = $("pcGenerateStatus");
  const generateBtn = $("pcGenerateBtn");

  const symptomKeywords = symptomInput ? symptomInput.value.trim() : "";
  const language = languageSelect ? languageSelect.value : "ja";
  const brokenJapanese = brokenJapaneseCheckbox ? brokenJapaneseCheckbox.checked : false;

  if (!symptomKeywords) {
    if (statusSpan) {
      statusSpan.textContent = "エラー: 症状キーワードを入力してください";
      statusSpan.style.color = "#ef4444";
    }
    return;
  }

  try {
    if (generateBtn) generateBtn.disabled = true;
    if (statusSpan) {
      statusSpan.textContent = "生成中...（10-20秒かかります）";
      statusSpan.style.color = "#6b7280";
    }

    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    const response = await fetch("/api/admin/patients/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        symptomKeywords,
        language,
        brokenJapanese
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    if (statusSpan) {
      statusSpan.textContent = "✓ 生成完了";
      statusSpan.style.color = "#10b981";
      setTimeout(() => {
        statusSpan.textContent = "";
      }, 3000);
    }

    // プレビューエリアに生成結果を表示
    displayGeneratedProfile(result.profile, symptomKeywords, language, brokenJapanese);

  } catch (error) {
    console.error("[generatePatientProfile] Error:", error);
    if (statusSpan) {
      statusSpan.textContent = "エラー: " + (error.message || String(error));
      statusSpan.style.color = "#ef4444";
    }
    alert("患者プロフィールの生成に失敗しました: " + (error.message || String(error)));
  } finally {
    if (generateBtn) generateBtn.disabled = false;
  }
}

// 生成されたプロフィールをプレビューエリアに表示
function displayGeneratedProfile(profile, symptomKeywords, language, brokenJapanese) {
  const previewArea = $("pcPreviewArea");
  if (!previewArea) return;

  // フィールドに値を設定
  const nameInput = $("pcPatientName");
  const ageInput = $("pcPatientAge");
  const genderSelect = $("pcPatientGender");
  const ageBandSelect = $("pcPatientAgeBand");
  const profileTextarea = $("pcProfileText");

  if (nameInput) nameInput.value = profile.name || "";
  if (ageInput) ageInput.value = profile.age || "";
  if (genderSelect) genderSelect.value = profile.gender || "male";
  if (ageBandSelect) ageBandSelect.value = profile.ageBand || "adult";
  if (profileTextarea) profileTextarea.value = profile.profileText || "";

  // プレビューエリアを表示
  previewArea.style.display = "block";

  // スムーズにスクロール
  setTimeout(() => {
    previewArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

// 患者を保存
async function saveAdminPatient() {
  const nameInput = $("pcPatientName");
  const ageInput = $("pcPatientAge");
  const genderSelect = $("pcPatientGender");
  const ageBandSelect = $("pcPatientAgeBand");
  const profileTextarea = $("pcProfileText");
  const timeLimitSelect = $("pcTimeLimit");
  const symptomInput = $("pcSymptomKeywords");
  const languageSelect = $("pcLanguage");
  const brokenJapaneseCheckbox = $("pcBrokenJapanese");
  const saveBtn = $("pcSaveBtn");
  const statusSpan = $("pcSaveStatus");

  const name = nameInput ? nameInput.value.trim() : "";
  const age = ageInput ? parseInt(ageInput.value, 10) : 0;
  const gender = genderSelect ? genderSelect.value : "male";
  const ageBand = ageBandSelect ? ageBandSelect.value : "adult";
  const profileText = profileTextarea ? profileTextarea.value.trim() : "";
  const timeLimit = timeLimitSelect ? parseInt(timeLimitSelect.value, 10) : 180;
  const symptomKeywords = symptomInput ? symptomInput.value.trim() : "";
  const language = languageSelect ? languageSelect.value : "ja";
  const brokenJapanese = brokenJapaneseCheckbox ? brokenJapaneseCheckbox.checked : false;

  // Version 3.42: 想定バイタル異常を収集
  const expectedVitals = {
    fever: !!$("pcVital_fever")?.checked,
    highBP: !!$("pcVital_highBP")?.checked,
    lowBP: !!$("pcVital_lowBP")?.checked,
    tachycardia: !!$("pcVital_tachycardia")?.checked,
    bradycardia: !!$("pcVital_bradycardia")?.checked,
    tachypnea: !!$("pcVital_tachypnea")?.checked,
    hypoxia: !!$("pcVital_hypoxia")?.checked
  };

  // Version 3.46: カスタムバイタル項目を収集（デバッグログ追加）
  const customVitals = [];
  const customCheckboxes = document.querySelectorAll('.custom-vital');
  console.log('[saveAdminPatient] Found custom checkboxes:', customCheckboxes.length);
  
  customCheckboxes.forEach(checkbox => {
    console.log('[saveAdminPatient] Checkbox:', checkbox.id, 'checked:', checkbox.checked);
    if (checkbox.checked) {
      const customId = checkbox.id;
      const labelInput = document.getElementById(`${customId}_label`);
      const descInput = document.getElementById(`${customId}_desc`);
      console.log('[saveAdminPatient] Label input:', labelInput?.id, 'value:', labelInput?.value);
      console.log('[saveAdminPatient] Desc input:', descInput?.id, 'value:', descInput?.value);
      
      if (labelInput && descInput && labelInput.value.trim()) {
        const customVital = {
          id: customId,
          label: labelInput.value.trim(),
          description: descInput.value.trim()
        };
        customVitals.push(customVital);
        console.log('[saveAdminPatient] Added custom vital:', customVital);
      }
    }
  });
  
  console.log('[saveAdminPatient] Total custom vitals:', customVitals.length, customVitals);

  if (!name || !profileText || !symptomKeywords) {
    if (statusSpan) {
      statusSpan.textContent = "エラー: 患者氏名、症状キーワード、プロフィール詳細は必須です";
      statusSpan.style.color = "#ef4444";
    }
    return;
  }

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (statusSpan) {
      statusSpan.textContent = "保存中...";
      statusSpan.style.color = "#6b7280";
    }

    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    const response = await fetch("/api/admin/patients", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        name,
        age,
        gender,
        ageBand,
        language,
        brokenJapanese,
        profile: profileText,
        symptomKeywords,
        timeLimit,
        expectedVitals,
        customVitals,
        isAdminCreated: true,
        isPublic: true
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    if (statusSpan) {
      statusSpan.textContent = "✓ 保存しました";
      statusSpan.style.color = "#10b981";
      setTimeout(() => {
        statusSpan.textContent = "";
      }, 3000);
    }

    // Success message already shown in inline status span

    // プレビューエリアを非表示にしてフォームをリセット
    const previewArea = $("pcPreviewArea");
    if (previewArea) previewArea.style.display = "none";
    if (symptomInput) symptomInput.value = "";

    // 患者一覧を再読み込み
    await loadAdminPatientList();

  } catch (error) {
    console.error("[saveAdminPatient] Error:", error);
    if (statusSpan) {
      statusSpan.textContent = "エラー: " + (error.message || String(error));
      statusSpan.style.color = "#ef4444";
    }
    // Error is already shown in inline status span
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// 保存済み患者一覧を読み込み
async function loadAdminPatientList() {
  const listArea = $("pcPatientListArea");
  if (!listArea) return;

  listArea.innerHTML = '<div class="muted">読み込み中...</div>';

  try {
    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    const response = await fetch("/api/admin/patients?isAdminCreated=true", {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    const patients = result.patients || [];

    if (patients.length === 0) {
      listArea.innerHTML = '<div class="muted">保存済み患者はまだありません</div>';
      return;
    }

    // テーブル表示
    const tableHTML = `
      <div style="overflow-x:auto">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:50px">No</th>
              <th style="width:150px">氏名</th>
              <th style="width:120px">年齢・性別</th>
              <th style="width:110px">言語</th>
              <th style="width:80px">制限時間</th>
              <th style="width:80px">使用回数</th>
              <th style="width:140px">操作</th>
            </tr>
          </thead>
          <tbody>
            ${patients.map((p, index) => {
              const timeLimitSec = p.timeLimit || 180;
              const timeLimitMin = Math.floor(timeLimitSec / 60);
              const timeLimitSecRem = timeLimitSec % 60;
              const timeLimitDisplay = timeLimitSecRem > 0 ? `${timeLimitMin}分${timeLimitSecRem}秒` : `${timeLimitMin}分`;
              
              const langDisplay = p.language === "ja" ? "日本語" :
                                  p.language === "en" ? "英語" :
                                  p.language === "ko" ? "韓国語" :
                                  p.language === "zh" ? "中国語" :
                                  p.language === "th" ? "タイ語" : p.language;
              
              const brokenJapFlag = (p.language === "en" && p.brokenJapanese) ? 
                '<span class="muted small">(カタコト)</span>' : '';
              
              return `
                <tr data-patient-id="${p.id}" class="pc-patient-row" style="cursor:pointer">
                  <td>${p.patientNo || index + 1}</td>
                  <td><strong>${esc(p.name || "")}</strong></td>
                  <td>${p.age || "?"}歳・${p.gender === "male" ? "男性" : "女性"}</td>
                  <td>${langDisplay}${brokenJapFlag}</td>
                  <td>${timeLimitDisplay}</td>
                  <td style="text-align:center">${p.usedCount || 0}回</td>
                  <td onclick="event.stopPropagation()">
                    <button class="secondary pc-edit-btn" style="font-size:12px; padding:4px 8px">編集</button>
                    <button class="secondary pc-delete-btn" style="font-size:12px; padding:4px 8px; background:#fee2e2; color:#991b1b">削除</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    listArea.innerHTML = tableHTML;

    // Version 3.47: 行クリックで詳細ポップアップを表示
    listArea.querySelectorAll(".pc-patient-row").forEach(row => {
      row.addEventListener("click", function() {
        const patientId = this.dataset.patientId;
        if (patientId) {
          showPatientDetailModal(patientId, patients);
        }
      });
    });

    // 編集ボタンのイベントリスナー
    listArea.querySelectorAll(".pc-edit-btn").forEach(btn => {
      btn.addEventListener("click", async function(event) {
        event.stopPropagation(); // 行クリックイベントを防ぐ
        const tr = this.closest("tr");
        const patientId = tr ? tr.dataset.patientId : null;
        if (patientId) {
          await editAdminPatient(patientId, patients);
        }
      });
    });

    // 削除ボタンのイベントリスナー
    listArea.querySelectorAll(".pc-delete-btn").forEach(btn => {
      btn.addEventListener("click", async function(event) {
        event.stopPropagation(); // 行クリックイベントを防ぐ
        const tr = this.closest("tr");
        const patientId = tr ? tr.dataset.patientId : null;
        if (patientId) {
          await deleteAdminPatient(patientId);
        }
      });
    });

  } catch (error) {
    console.error("[loadAdminPatientList] Error:", error);
    listArea.innerHTML = `<div class="err">読み込みエラー: ${esc(error.message || String(error))}</div>`;
  }
}

// Version 3.47: 患者詳細をモーダルで表示
function showPatientDetailModal(patientId, patientsList) {
  const patient = patientsList.find(p => p.id === patientId);
  if (!patient) {
    console.error("患者が見つかりません: ", patientId);
    return;
  }

  // モーダル背景を作成
  const modalBg = document.createElement('div');
  modalBg.id = 'patientDetailModalBg';
  modalBg.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;

  // モーダル内容を作成
  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 12px;
    padding: 24px;
    max-width: 800px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  `;

  // 想定バイタル異常の表示を構築
  let vitalStatusHTML = '<div class="muted">設定なし</div>';
  if (patient.expectedVitals) {
    const vitals = [];
    if (patient.expectedVitals.fever) vitals.push('🌡️ 発熱');
    if (patient.expectedVitals.highBP) vitals.push('📈 高血圧');
    if (patient.expectedVitals.lowBP) vitals.push('📉 低血圧');
    if (patient.expectedVitals.tachycardia) vitals.push('💓 頻脈');
    if (patient.expectedVitals.bradycardia) vitals.push('💙 徐脈');
    if (patient.expectedVitals.tachypnea) vitals.push('🫁 頻呼吸');
    if (patient.expectedVitals.hypoxia) vitals.push('🩺 低酸素');
    
    if (vitals.length > 0) {
      vitalStatusHTML = vitals.map(v => `<span style="display:inline-block; padding:4px 8px; background:#fef3c7; border-radius:4px; margin:2px; font-size:13px">${v}</span>`).join('');
    }
  }

  // カスタムバイタル項目の表示
  let customVitalsHTML = '<div class="muted">なし</div>';
  if (patient.customVitals && Array.isArray(patient.customVitals) && patient.customVitals.length > 0) {
    customVitalsHTML = patient.customVitals.map(cv => 
      `<div style="padding:8px; background:#f3f4f6; border-radius:4px; margin:4px 0">
        <strong>${esc(cv.label)}</strong>: ${esc(cv.description)}
      </div>`
    ).join('');
  }

  const timeLimitSec = patient.timeLimit || 180;
  const timeLimitMin = Math.floor(timeLimitSec / 60);
  const timeLimitSecRem = timeLimitSec % 60;
  const timeLimitDisplay = timeLimitSecRem > 0 ? `${timeLimitMin}分${timeLimitSecRem}秒` : `${timeLimitMin}分`;

  const langDisplay = patient.language === "ja" ? "日本語" :
                      patient.language === "en" ? "英語" :
                      patient.language === "ko" ? "韓国語" :
                      patient.language === "zh" ? "中国語" :
                      patient.language === "th" ? "タイ語" : patient.language;

  const brokenJapFlag = (patient.language === "en" && patient.brokenJapanese) ? '<span class="muted">(カタコト日本語)</span>' : '';

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:20px">
      <h3 style="margin:0">患者詳細</h3>
      <button id="closePatientDetailModal" style="background:none; border:none; font-size:24px; cursor:pointer; color:#6b7280">&times;</button>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:20px">
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">患者番号</div>
        <div style="font-weight:600">${patient.patientNo || "-"}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">患者氏名</div>
        <div style="font-weight:600; font-size:18px">${esc(patient.name || "")}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">年齢</div>
        <div>${patient.age || "?"}歳</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">性別</div>
        <div>${patient.gender === "male" ? "男性" : "女性"}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">年齢層</div>
        <div>${patient.ageBand === "child" ? "子供" : patient.ageBand === "elderly" ? "高齢者" : "大人"}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">言語</div>
        <div>${langDisplay} ${brokenJapFlag}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">制限時間</div>
        <div>${timeLimitDisplay}</div>
      </div>
      <div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px">使用回数</div>
        <div>${patient.usedCount || 0}回</div>
      </div>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:12px; color:#6b7280; margin-bottom:4px">プロフィール</div>
      <div style="padding:12px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; white-space:pre-wrap">${esc(patient.profile || "-")}</div>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:12px; color:#6b7280; margin-bottom:8px">想定バイタル異常</div>
      <div>${vitalStatusHTML}</div>
    </div>

    <div style="margin-bottom:24px">
      <div style="font-size:12px; color:#6b7280; margin-bottom:8px">カスタムバイタル項目</div>
      <div>${customVitalsHTML}</div>
    </div>

    <div style="display:flex; gap:12px; justify-content:flex-end">
      <button id="closePatientDetailModalBtn" class="primary">閉じる</button>
    </div>
  `;

  modalBg.appendChild(modal);
  document.body.appendChild(modalBg);

  // 閉じるボタンのイベント
  const closeModal = () => {
    document.body.removeChild(modalBg);
  };

  $("closePatientDetailModal").addEventListener("click", closeModal);
  $("closePatientDetailModalBtn").addEventListener("click", closeModal);
  modalBg.addEventListener("click", (e) => {
    if (e.target === modalBg) closeModal();
  });
}

// 患者を編集
async function editAdminPatient(patientId, patientsList) {
  const patient = patientsList.find(p => p.id === patientId);
  if (!patient) {
    console.error("患者が見つかりません: ", patientId);
    return;
  }

  // フォームに既存データを設定
  const symptomInput = $("pcSymptomKeywords");
  const languageSelect = $("pcLanguage");
  const brokenJapaneseCheckbox = $("pcBrokenJapanese");

  if (symptomInput) symptomInput.value = patient.symptomKeywords || "";
  if (languageSelect) languageSelect.value = patient.language || "ja";
  if (brokenJapaneseCheckbox) brokenJapaneseCheckbox.checked = patient.brokenJapanese || false;

  // カタコトチェックボックスの表示を更新
  const brokenJapaneseContainer = $("pcBrokenJapaneseContainer");
  if (brokenJapaneseContainer) {
    brokenJapaneseContainer.style.display = (patient.language === "en") ? "block" : "none";
  }

  // プレビューエリアに既存データを表示
  displayGeneratedProfile({
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    ageBand: patient.ageBand,
    profileText: patient.profile
  }, patient.symptomKeywords, patient.language, patient.brokenJapanese);

  // Version 3.42: 想定バイタル異常をフォームに設定
  if (patient.expectedVitals) {
    if ($("pcVital_fever")) $("pcVital_fever").checked = !!patient.expectedVitals.fever;
    if ($("pcVital_highBP")) $("pcVital_highBP").checked = !!patient.expectedVitals.highBP;
    if ($("pcVital_lowBP")) $("pcVital_lowBP").checked = !!patient.expectedVitals.lowBP;
    if ($("pcVital_tachycardia")) $("pcVital_tachycardia").checked = !!patient.expectedVitals.tachycardia;
    if ($("pcVital_bradycardia")) $("pcVital_bradycardia").checked = !!patient.expectedVitals.bradycardia;
    if ($("pcVital_tachypnea")) $("pcVital_tachypnea").checked = !!patient.expectedVitals.tachypnea;
    if ($("pcVital_hypoxia")) $("pcVital_hypoxia").checked = !!patient.expectedVitals.hypoxia;
  }

  // Version 3.45: カスタムバイタル項目をフォームに復元
  // Version 3.46: デバッグログ追加
  console.log('[editAdminPatient] Patient data:', patient);
  console.log('[editAdminPatient] Custom vitals:', patient.customVitals);
  
  const customVitalsArea = $("pcCustomVitalsArea");
  if (customVitalsArea) {
    customVitalsArea.innerHTML = ""; // 既存のカスタム項目をクリア
    console.log('[editAdminPatient] Cleared custom vitals area');
    
    if (patient.customVitals && Array.isArray(patient.customVitals)) {
      console.log('[editAdminPatient] Restoring', patient.customVitals.length, 'custom vitals');
      patient.customVitals.forEach((cv, index) => {
        console.log(`[editAdminPatient] Restoring custom vital ${index}:`, cv);
        addCustomVitalItem(cv.id, cv.label, cv.description, true);
      });
    } else {
      console.log('[editAdminPatient] No custom vitals to restore');
    }
  }

  // 保存ボタンを「更新」モードに変更
  const saveBtn = $("pcSaveBtn");
  if (saveBtn) {
    saveBtn.textContent = "患者を更新";
    saveBtn.onclick = async () => {
      await updateAdminPatient(patientId);
    };
    // Version 3.45: 更新モードフラグを保存ボタンに追加
    saveBtn.dataset.editMode = "true";
    saveBtn.dataset.editPatientId = patientId;
  }

  // キャンセルボタンを表示（Version 3.0.2）
  const cancelBtn = $("pcCancelBtn");
  if (cancelBtn) {
    cancelBtn.style.display = "inline-block";
  }

  // 画面をスクロール
  const pane = $("pane-patient-creation");
  if (pane) {
    pane.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// 患者を更新
async function updateAdminPatient(patientId) {
  const nameInput = $("pcPatientName");
  const ageInput = $("pcPatientAge");
  const genderSelect = $("pcPatientGender");
  const ageBandSelect = $("pcPatientAgeBand");
  const profileTextarea = $("pcProfileText");
  const timeLimitSelect = $("pcTimeLimit");
  const symptomInput = $("pcSymptomKeywords");
  const languageSelect = $("pcLanguage");
  const brokenJapaneseCheckbox = $("pcBrokenJapanese");
  const saveBtn = $("pcSaveBtn");
  const statusSpan = $("pcSaveStatus");

  const name = nameInput ? nameInput.value.trim() : "";
  const age = ageInput ? parseInt(ageInput.value, 10) : 0;
  const gender = genderSelect ? genderSelect.value : "male";
  const ageBand = ageBandSelect ? ageBandSelect.value : "adult";
  const profileText = profileTextarea ? profileTextarea.value.trim() : "";
  const timeLimit = timeLimitSelect ? parseInt(timeLimitSelect.value, 10) : 180;
  const symptomKeywords = symptomInput ? symptomInput.value.trim() : "";
  const language = languageSelect ? languageSelect.value : "ja";
  const brokenJapanese = brokenJapaneseCheckbox ? brokenJapaneseCheckbox.checked : false;

  // Version 3.42: 想定バイタル異常を収集
  const expectedVitals = {
    fever: !!$("pcVital_fever")?.checked,
    highBP: !!$("pcVital_highBP")?.checked,
    lowBP: !!$("pcVital_lowBP")?.checked,
    tachycardia: !!$("pcVital_tachycardia")?.checked,
    bradycardia: !!$("pcVital_bradycardia")?.checked,
    tachypnea: !!$("pcVital_tachypnea")?.checked,
    hypoxia: !!$("pcVital_hypoxia")?.checked
  };

  // Version 3.46: カスタムバイタル項目を収集（デバッグログ追加）
  const customVitals = [];
  const customCheckboxes = document.querySelectorAll('.custom-vital');
  console.log('[updateAdminPatient] Found custom checkboxes:', customCheckboxes.length);
  
  customCheckboxes.forEach(checkbox => {
    console.log('[updateAdminPatient] Checkbox:', checkbox.id, 'checked:', checkbox.checked);
    if (checkbox.checked) {
      const customId = checkbox.id;
      const labelInput = document.getElementById(`${customId}_label`);
      const descInput = document.getElementById(`${customId}_desc`);
      console.log('[updateAdminPatient] Label input:', labelInput?.id, 'value:', labelInput?.value);
      console.log('[updateAdminPatient] Desc input:', descInput?.id, 'value:', descInput?.value);
      
      if (labelInput && descInput && labelInput.value.trim()) {
        const customVital = {
          id: customId,
          label: labelInput.value.trim(),
          description: descInput.value.trim()
        };
        customVitals.push(customVital);
        console.log('[updateAdminPatient] Added custom vital:', customVital);
      }
    }
  });
  
  console.log('[updateAdminPatient] Total custom vitals:', customVitals.length, customVitals);

  if (!name || !profileText || !symptomKeywords) {
    if (statusSpan) {
      statusSpan.textContent = "エラー: 患者氏名、症状キーワード、プロフィール詳細は必須です";
      statusSpan.style.color = "#ef4444";
    }
    return;
  }

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (statusSpan) {
      statusSpan.textContent = "更新中...";
      statusSpan.style.color = "#6b7280";
    }

    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    const response = await fetch(`/api/admin/patients/${patientId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        name,
        age,
        gender,
        ageBand,
        language,
        brokenJapanese,
        profile: profileText,
        symptomKeywords,
        timeLimit,
        expectedVitals,
        customVitals
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    if (statusSpan) {
      statusSpan.textContent = "✓ 更新しました";
      statusSpan.style.color = "#10b981";
      setTimeout(() => {
        statusSpan.textContent = "";
      }, 3000);
    }

    // Success message is shown in inline status span

    // プレビューエリアを非表示にしてフォームをリセット
    const previewArea = $("pcPreviewArea");
    if (previewArea) previewArea.style.display = "none";
    if (symptomInput) symptomInput.value = "";

    // 保存ボタンを元に戻す（Version 3.45: dataset も クリア）
    if (saveBtn) {
      saveBtn.textContent = "患者を保存";
      saveBtn.dataset.editMode = "false";
      saveBtn.dataset.editPatientId = "";
    }

    // キャンセルボタンを非表示（Version 3.0.2）
    const cancelBtn = $("pcCancelBtn");
    if (cancelBtn) {
      cancelBtn.style.display = "none";
    }
    
    // カスタムバイタル項目をクリア
    const customArea = $("pcCustomVitalsArea");
    if (customArea) customArea.innerHTML = "";

    // 患者一覧を再読み込み
    await loadAdminPatientList();

  } catch (error) {
    console.error("[updateAdminPatient] Error:", error);
    if (statusSpan) {
      statusSpan.textContent = "エラー: " + (error.message || String(error));
      statusSpan.style.color = "#ef4444";
    }
    // Error is already shown in inline status span
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// 患者を削除（Version 3.54: 削除確認を強化）
async function deleteAdminPatient(patientId) {
  if (!confirm("この患者を削除してもよろしいですか？\n削除すると元に戻せません。")) {
    return;
  }

  try {
    const token = await getIdToken();
    if (!token) {
      throw new Error("認証トークンを取得できません");
    }

    console.log(`[deleteAdminPatient] 削除開始: ${patientId}`);

    const response = await fetch(`/api/admin/patients/${patientId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const result = await response.json();
    console.log(`[deleteAdminPatient] サーバーレスポンス:`, result);

    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    console.log(`[deleteAdminPatient] ✓ 削除成功: ${patientId}`);

    // 削除成功メッセージ
    alert("患者を削除しました");

    // 患者一覧を再読み込み
    await loadAdminPatientList();
    
    console.log(`[deleteAdminPatient] ✓ 患者一覧を再読み込み完了`);

  } catch (error) {
    console.error("[deleteAdminPatient] Error:", error);
    alert("患者の削除に失敗しました: " + (error.message || String(error)));
    throw error; // エラーを上位に伝播
  }
}

