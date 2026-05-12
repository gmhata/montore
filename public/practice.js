// public/practice.js
// 重要メモ:
// - 声の切替: chooseVoice() で female→"shimmer" (明るい女性) / male→"onyx" (低い男性)。session.update でも適用（遅延再適用）
// - 言語/年齢/性別: buildInstructions に強めに反映（特に zh は zh‑CN 固定で明示）。音声認識は自動（language を固定しない）
// - 進捗バー: 採点中は 94% 付近で小さく往復して「固まった感」を避ける
// - セッションIDは常に非表示。DB不調でも会話は続行（ログなしモード）

"use strict";

const $ = (id)=> document.getElementById(id);

/* Router */
function show(id){
  ["screen-login","screen-home","screen-talk","screen-result","screen-patient-select","screen-history"].forEach(s=>{
    const el = $(s); if (el) el.classList.toggle("active", s===id);
  });
  document.body.classList.toggle("immersive", id==="screen-talk");

  // 統合ステータスパネルの表示制御
  const toggleBtn = $("toggleStatusBtn");
  const panel = $("statusPanel");
  const rsAudioPlayer = $("rsAudioPlayer");
  
  if (id === "screen-talk") {
    if (toggleBtn) toggleBtn.style.display = 'block';
    // 練習画面では録音プレーヤーを非表示にする
    if (rsAudioPlayer) {
      rsAudioPlayer.style.display = "none";
      rsAudioPlayer.innerHTML = "";
    }
  } else {
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (panel) panel.classList.remove('visible');
    
    // 評価画面では全てのパネルを完全に非表示にする
    if (id === "screen-result") {
      // フローティングパネルをクリアして非表示
      const floatingPanels = document.getElementById('floatingPanels');
      if (floatingPanels) {
        floatingPanels.innerHTML = '';
        floatingPanels.style.display = 'none';
      }
      // ステータスパネルを完全に非表示
      if (panel) {
        panel.classList.remove('visible');
        panel.style.display = 'none';
      }
      // トグルボタンも非表示
      if (toggleBtn) {
        toggleBtn.style.display = 'none';
      }
      // 録音プレーヤーは onFinishClick で設定されるので、ここでは触らない
      // display プロパティを削除して、onFinishClick の設定を優先
      if (rsAudioPlayer && rsAudioPlayer.style.display === "none") {
        rsAudioPlayer.style.display = "";
        console.log('[Audio Player] show(screen-result) - Resetting rsAudioPlayer display to allow content');
      }
    } else if (rsAudioPlayer) {
      // 評価画面以外ではプレーヤーを非表示
      rsAudioPlayer.style.display = "none";
      rsAudioPlayer.innerHTML = "";
      console.log('[Audio Player] show(' + id + ') - Hiding rsAudioPlayer');
    }
  }

  // メニュー画面表示時にアドバイスを再読み込み
  if (id === "screen-home") {
    setTimeout(() => loadPracticeAdvice(), 100);
  }
}

/* State */
let selectedScenario = "chest";
let currentSessionId = null;
let patientBuf = "", nurseBuf = "";
let lastPatientLine = "";
let audioSink = null;
let micStream = null;
let pc = null, dc = null;

/* Recording */
let mediaRecorder = null;
let recordedChunks = [];
let remoteAudioStream = null;
let recordingEnabled = true;  // デフォルトでtrueに変更（管理者設定で上書き可能）

/* Web Speech Recognition (global so it can be stopped) */
let recognition = null;

/* Timer */
let conversationTimer = null;
let conversationTimeLimit = 180; // デフォルト3分（秒）
let conversationStartTime = null;

/* Vital Signs & Physical Examination */
let vitalChecked = false;
let examChecked = false;
let currentVitalData = null;
let currentExamData = null;

// 個別表示用の新しい変数
let currentScenarioConfig = null; // シナリオ別キーワード設定
let vitalItemsShown = new Set(); // 表示済みバイタル項目 ('temperature', 'bloodPressure', etc.)
let examItemsShown = new Set(); // 表示済み身体診察項目 ('inspection', 'palpation', etc.)

// v4.31: 確認モーダル用のキュー（複数検出時に順番に表示）
let confirmModalQueue = [];
let isConfirmModalOpen = false;

/* Status Panel Auto-close Timer */
let statusPanelAutoCloseTimer = null;
let statusPanelShownOnce = false; // 症状別モードで初回パネル表示を管理

/* 評価項目選択（v4.25） */
const EVALUATION_ITEMS = [
  { id: "intro", name: "導入", description: "挨拶・自己紹介・確認" },
  { id: "chief", name: "主訴", description: "主な症状の聴取" },
  { id: "oldcart", name: "OLDCART", description: "症状の詳細確認" },
  { id: "ros", name: "ROS&RedFlag", description: "系統的レビュー・危険兆候" },
  { id: "history", name: "医療・生活歴", description: "既往歴・生活習慣" },
  { id: "reason", name: "受診契機", description: "来院理由の確認" },
  { id: "vitals", name: "バイタル/現症", description: "バイタル測定" },
  { id: "exam", name: "身体診察", description: "視診・触診・聴診" },
  { id: "progress", name: "進行", description: "対話の進行・まとめ" }
];
let selectedEvalItems = new Set(EVALUATION_ITEMS.map(item => item.id)); // デフォルトで全項目選択

/* Vital Signs Data Patterns */
const vitalPatterns = {
  chest: {
    normal: {
      temperature: { value: "36.5℃", abnormal: false },
      bloodPressure: { value: "120/80 mmHg", abnormal: false },
      pulse: { value: "72 回/分", abnormal: false },
      respiration: { value: "16 回/分", abnormal: false },
      spo2: { value: "98%", abnormal: false }
    },
    abnormal: {
      temperature: { value: "36.8℃", abnormal: false },
      bloodPressure: { value: "150/95 mmHg", abnormal: true },
      pulse: { value: "95 回/分", abnormal: true },
      respiration: { value: "20 回/分", abnormal: true },
      spo2: { value: "96%", abnormal: false }
    }
  },
  head: {
    normal: {
      temperature: { value: "36.6℃", abnormal: false },
      bloodPressure: { value: "118/75 mmHg", abnormal: false },
      pulse: { value: "68 回/分", abnormal: false },
      respiration: { value: "14 回/分", abnormal: false },
      spo2: { value: "99%", abnormal: false }
    },
    abnormal: {
      temperature: { value: "37.8℃", abnormal: true },
      bloodPressure: { value: "165/100 mmHg", abnormal: true },
      pulse: { value: "88 回/分", abnormal: true },
      respiration: { value: "16 回/分", abnormal: false },
      spo2: { value: "98%", abnormal: false }
    }
  },
  abdomen: {
    normal: {
      temperature: { value: "36.4℃", abnormal: false },
      bloodPressure: { value: "115/70 mmHg", abnormal: false },
      pulse: { value: "70 回/分", abnormal: false },
      respiration: { value: "15 回/分", abnormal: false },
      spo2: { value: "99%", abnormal: false }
    },
    abnormal: {
      temperature: { value: "38.2℃", abnormal: true },
      bloodPressure: { value: "105/65 mmHg", abnormal: true },
      pulse: { value: "92 回/分", abnormal: true },
      respiration: { value: "18 回/分", abnormal: false },
      spo2: { value: "97%", abnormal: false }
    }
  },
  respiratory: {
    normal: {
      temperature: { value: "36.7℃", abnormal: false },
      bloodPressure: { value: "122/78 mmHg", abnormal: false },
      pulse: { value: "74 回/分", abnormal: false },
      respiration: { value: "16 回/分", abnormal: false },
      spo2: { value: "98%", abnormal: false }
    },
    abnormal: {
      temperature: { value: "37.5℃", abnormal: true },
      bloodPressure: { value: "128/82 mmHg", abnormal: false },
      pulse: { value: "102 回/分", abnormal: true },
      respiration: { value: "24 回/分", abnormal: true },
      spo2: { value: "92%", abnormal: true }
    }
  }
};

/* Physical Examination Data Patterns */
const examPatterns = {
  chest: {
    normal: {
      inspection: { label: "視診", value: "外見上異常なし", abnormal: false },
      palpation: { label: "触診", value: "圧痛なし", abnormal: false },
      auscultation: { label: "聴診", value: "心音・呼吸音清明", abnormal: false }
    },
    abnormal: {
      inspection: { label: "視診", value: "冷汗あり、顔面蒼白", abnormal: true },
      palpation: { label: "触診", value: "胸部に圧痛あり", abnormal: true },
      auscultation: { label: "聴診", value: "心雑音あり", abnormal: true }
    }
  },
  head: {
    normal: {
      inspection: { label: "視診", value: "意識清明、外傷なし", abnormal: false },
      palpation: { label: "触診", value: "頭部に圧痛なし", abnormal: false },
      neurological: { label: "神経学的所見", value: "瞳孔正常、対光反射正常", abnormal: false }
    },
    abnormal: {
      inspection: { label: "視診", value: "顔面紅潮、項部硬直疑い", abnormal: true },
      palpation: { label: "触診", value: "後頭部に圧痛あり", abnormal: true },
      neurological: { label: "神経学的所見", value: "軽度の羞明あり", abnormal: true }
    }
  },
  abdomen: {
    normal: {
      inspection: { label: "視診", value: "腹部平坦、膨隆なし", abnormal: false },
      palpation: { label: "触診", value: "圧痛なし、筋性防御なし", abnormal: false },
      auscultation: { label: "聴診", value: "腸蠕動音正常", abnormal: false }
    },
    abnormal: {
      inspection: { label: "視診", value: "軽度の腹部膨隆", abnormal: true },
      palpation: { label: "触診", value: "右下腹部に圧痛あり、反跳痛あり", abnormal: true },
      auscultation: { label: "聴診", value: "腸蠕動音やや亢進", abnormal: true }
    }
  },
  respiratory: {
    normal: {
      inspection: { label: "視診", value: "呼吸様式正常、チアノーゼなし", abnormal: false },
      palpation: { label: "触診", value: "胸郭の動き左右対称", abnormal: false },
      auscultation: { label: "聴診", value: "呼吸音清明", abnormal: false }
    },
    abnormal: {
      inspection: { label: "視診", value: "努力呼吸、口唇チアノーゼあり", abnormal: true },
      palpation: { label: "触診", value: "右胸部の動き減弱", abnormal: true },
      auscultation: { label: "聴診", value: "両側下肺野に湿性ラ音", abnormal: true }
    }
  }
};

/* Speech Analysis (Prosody) */
let audioContext = null;
let analyser = null;
let audioSourceNode = null;
let pitchDetector = null;
let speechAnalysisInterval = null;
let speechMetrics = [];
let currentSpeechSegment = null;

/* Speech Analysis Functions */
function initSpeechAnalysis(stream){
  try {
    // Create AudioContext
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    
    // Create analyser node
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    
    // Connect microphone stream to analyser
    audioSourceNode = audioContext.createMediaStreamSource(stream);
    audioSourceNode.connect(analyser);
    
    // Reset metrics
    speechMetrics = [];
    currentSpeechSegment = null;
    
    // Start analysis loop
    startSpeechAnalysisLoop();
    
    console.log("[Speech Analysis] Initialized successfully");
  } catch(e) {
    console.error("[Speech Analysis] Initialization failed:", e);
  }
}

function startSpeechAnalysisLoop(){
  if (speechAnalysisInterval) return;
  
  let loopCount = 0;
  
  // Analyze every 100ms
  speechAnalysisInterval = setInterval(()=>{
    if (!analyser || !audioContext) return;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const timeArray = new Float32Array(bufferLength);
    
    // Get frequency and time domain data
    analyser.getByteFrequencyData(dataArray);
    analyser.getFloatTimeDomainData(timeArray);
    
    // Calculate metrics
    const volume = calculateVolume(dataArray);
    const pitch = estimatePitch(timeArray, audioContext.sampleRate);
    const energy = calculateEnergy(timeArray);
    
    // Store metrics if speech is detected (volume threshold)
    if (volume > 20) {  // Threshold to filter silence
      const timestamp = Date.now();
      const metric = {
        timestamp,
        volume,
        pitch,
        energy,
        isSpeaking: volume > 30
      };
      
      speechMetrics.push(metric);
      
      // Keep only last 5 minutes of data
      const fiveMinutesAgo = timestamp - 5 * 60 * 1000;
      speechMetrics = speechMetrics.filter(m => m.timestamp > fiveMinutesAgo);
    }
    
    // Real-time panel update: Update panel every 1 second (10 loops of 100ms)
    loopCount++;
    if (loopCount >= 10) {
      loopCount = 0;
      // 統合ステータスパネルの音声セクションを更新
      visualizeSpeechMetrics();
    }
  }, 100);  // 100ms interval
}

function calculateVolume(frequencyData){
  let sum = 0;
  for (let i = 0; i < frequencyData.length; i++) {
    sum += frequencyData[i];
  }
  return sum / frequencyData.length;
}

function calculateEnergy(timeDomainData){
  let sum = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sum += timeDomainData[i] * timeDomainData[i];
  }
  return Math.sqrt(sum / timeDomainData.length);
}

// Pitch detection removed - using volume-based metrics instead
// This provides more stable and reliable speech analysis
function estimatePitch(timeDomainData, sampleRate){
  // Not used in volume-based analysis
  return 0;
}

function stopSpeechAnalysis(){
  if (speechAnalysisInterval) {
    clearInterval(speechAnalysisInterval);
    speechAnalysisInterval = null;
  }
  
  if (audioSourceNode) {
    try { audioSourceNode.disconnect(); } catch(e){}
    audioSourceNode = null;
  }
  
  if (analyser) {
    try { analyser.disconnect(); } catch(e){}
    analyser = null;
  }
  
  if (audioContext) {
    try { audioContext.close(); } catch(e){}
    audioContext = null;
  }
}

function getSpeechAnalysisSummary(){
  if (speechMetrics.length === 0) {
    return {
      avgVolume: 0,
      avgPitch: 0,
      pitchVariance: 0,
      volumeVariance: 0,
      speakingRate: 0,
      totalSpeakingTime: 0,
      speechSegments: 0
    };
  }
  
  const speakingMetrics = speechMetrics.filter(m => m.isSpeaking);
  
  if (speakingMetrics.length === 0) {
    return {
      avgVolume: 0,
      avgPitch: 0,
      pitchVariance: 0,
      volumeVariance: 0,
      speakingRate: 0,
      totalSpeakingTime: 0,
      speechSegments: 0
    };
  }
  
  // Calculate volume-based metrics
  const avgVolume = speakingMetrics.reduce((a,b)=>a+b.volume,0) / speakingMetrics.length;
  const avgEnergy = speakingMetrics.reduce((a,b)=>a+b.energy,0) / speakingMetrics.length;
  
  // Calculate variance for intonation (volume variation)
  let volumeVariance = 0;
  let energyVariance = 0;
  
  if (speakingMetrics.length > 1) {
    volumeVariance = Math.sqrt(
      speakingMetrics.reduce((sum, m) => sum + Math.pow(m.volume - avgVolume, 2), 0) / speakingMetrics.length
    );
    energyVariance = Math.sqrt(
      speakingMetrics.reduce((sum, m) => sum + Math.pow(m.energy - avgEnergy, 2), 0) / speakingMetrics.length
    );
  }
  
  // Detect speech segments (continuous speaking)
  let segments = 0;
  let inSegment = false;
  let totalSpeakingTime = 0;
  
  for (let i = 0; i < speechMetrics.length; i++) {
    const m = speechMetrics[i];
    
    if (m.isSpeaking && !inSegment) {
      segments++;
      inSegment = true;
    } else if (!m.isSpeaking && inSegment) {
      inSegment = false;
    }
    
    if (m.isSpeaking) {
      totalSpeakingTime += 0.1; // 100ms per sample
    }
  }
  
  // Speaking rate (segments per minute)
  const durationMinutes = (speechMetrics[speechMetrics.length - 1].timestamp - speechMetrics[0].timestamp) / 60000;
  const speakingRate = durationMinutes > 0 ? segments / durationMinutes : 0;
  
  // Evaluate characteristics in Japanese (3-level system)
  const evaluation = {
    intonation: evaluateIntonation(volumeVariance),
    speed: evaluateSpeed(speakingRate),
    clarity: evaluateClarity(volumeVariance, energyVariance)
  };
  
  return {
    avgVolume: Math.round(avgVolume),
    avgEnergy: Math.round(avgEnergy * 100) / 100,
    volumeVariance: Math.round(volumeVariance * 10) / 10,
    energyVariance: Math.round(energyVariance * 100) / 100,
    speakingRate: Math.round(speakingRate * 10) / 10,
    totalSpeakingTime: Math.round(totalSpeakingTime * 10) / 10,
    speechSegments: segments,
    evaluation
  };
}

function evaluateIntonation(volumeVariance){
  // 3-level evaluation based on volume variation
  // Low variance = flat speaking, high variance = expressive speaking
  if (volumeVariance < 8) return "平坦";
  if (volumeVariance < 18) return "普通";
  return "豊か";
}

function evaluateSpeed(speakingRate){
  // 3-level evaluation based on speaking segments per minute
  if (speakingRate < 6) return "ゆっくり";
  if (speakingRate < 10) return "普通";
  return "速い";
}

function evaluateClarity(volumeVariance, energyVariance){
  // 3-level evaluation combining volume and energy variation
  // Clarity = how much "dynamics" and "color" in speech
  const clarityScore = (volumeVariance + energyVariance * 100) / 2;
  if (clarityScore < 8) return "単調";
  if (clarityScore < 16) return "明瞭";
  return "非常に明瞭";
}

function visualizeSpeechMetrics(){
  const summary = getSpeechAnalysisSummary();

  // 統合ステータスパネルの音声セクションを更新
  const content = $("speechStatusContent");
  if (!content) return;

  const ev = summary.evaluation || {};

  let html = '';

  if (summary.speechSegments > 0) {
    html += `
      <div class="status-item">
        <div class="status-label">発話回数</div>
        <div class="status-value">${summary.speechSegments} 回</div>
      </div>
      <div class="status-item">
        <div class="status-label">発話時間</div>
        <div class="status-value">${summary.totalSpeakingTime.toFixed(1)} 秒</div>
      </div>
      <div class="status-item">
        <div class="status-label">抑揚</div>
        <div class="status-value">${ev.intonation || '-'}</div>
      </div>
      <div class="status-item">
        <div class="status-label">話速</div>
        <div class="status-value">${ev.speed || '-'}</div>
      </div>
      <div class="status-item">
        <div class="status-label">明瞭さ</div>
        <div class="status-value">${ev.clarity || '-'}</div>
      </div>
    `;
  } else {
    html = '<div class="status-empty">音声データを収集中...</div>';
  }

  content.innerHTML = html;
}

/* 統合ステータスパネルのトグル */
function showStatusPanel(){
  const panel = $("statusPanel");
  const toggleBtn = $("toggleStatusBtn");
  if (panel) {
    panel.classList.add('visible');
    // Version 3.37: インラインスタイルを明示的に設定してパネルを表示
    panel.style.display = 'block';
    panel.style.zIndex = '150';
    panel.style.pointerEvents = 'auto';
    console.log('[showStatusPanel] Panel shown, display:', panel.style.display);
  }
  // Version 3.0.1: ステータスボタンは常に表示したまま
  // if (toggleBtn) toggleBtn.style.display = 'none';

  // 音声分析セクションを表示
  const speechSection = document.getElementById('speechStatusSection');
  if (speechSection) speechSection.style.display = 'block';

  // 既存のタイマーをクリア
  if (statusPanelAutoCloseTimer) {
    clearTimeout(statusPanelAutoCloseTimer);
    statusPanelAutoCloseTimer = null;
  }

  // 10秒後に自動で閉じる
  statusPanelAutoCloseTimer = setTimeout(() => {
    hideStatusPanel();
    statusPanelAutoCloseTimer = null;
  }, 10000);
}

function hideStatusPanel(){
  const panel = $("statusPanel");
  const toggleBtn = $("toggleStatusBtn");
  if (panel) {
    panel.classList.remove('visible');
    // Version 3.37: インラインスタイルを明示的に設定してパネルを非表示
    panel.style.display = 'none';
    panel.style.zIndex = '-1';
    panel.style.pointerEvents = 'none';
    console.log('[hideStatusPanel] Panel hidden, display:', panel.style.display);
  }
  // Version 3.0.1: ステータスボタンは常に表示（非表示にしない）
  // ボタンの表示状態は変更しない

  // タイマーをクリア
  if (statusPanelAutoCloseTimer) {
    clearTimeout(statusPanelAutoCloseTimer);
    statusPanelAutoCloseTimer = null;
  }
}

function toggleStatusPanel(){
  console.log('[toggleStatusPanel] Called');
  const panel = $("statusPanel");
  console.log('[toggleStatusPanel] Panel:', panel, 'Visible:', panel?.classList.contains('visible'));
  if (panel && panel.classList.contains('visible')) {
    console.log('[toggleStatusPanel] Hiding panel');
    hideStatusPanel();
  } else {
    console.log('[toggleStatusPanel] Showing panel');
    showStatusPanel();
  }
}

function updateSpeechPanel(summary){
  const panel = $("speechAnalysisPanel");
  if (!panel) return;
  
  const ev = summary.evaluation || {};
  
  // Check if details element exists and is open
  let detailsElement = panel.querySelector('details');
  let wasOpen = detailsElement ? detailsElement.open : false;
  
  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #667eea;">
      <div style="font-weight: 700; font-size: 18px; color: #333;">
        🎤 音声分析
      </div>
      <button id="closeSpeechPanel" style="background: none; border: none; font-size: 20px; cursor: pointer; color: #999; padding: 0; width: 28px; height: 28px; line-height: 1;">
        ✕
      </button>
    </div>
    
    <div style="background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
      <div style="font-weight: 600; font-size: 14px; color: #555; margin-bottom: 12px;">📊 総合評価</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 13px;">
        <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
          <div style="color: #666; font-size: 11px; margin-bottom: 4px;">抑揚</div>
          <div style="font-weight: 700; font-size: 16px; color: #E94B3C;">${ev.intonation || "普通"}</div>
        </div>
        <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
          <div style="color: #666; font-size: 11px; margin-bottom: 4px;">話す速度</div>
          <div style="font-weight: 700; font-size: 16px; color: #E67E22;">${ev.speed || "普通"}</div>
        </div>
        <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
          <div style="color: #666; font-size: 11px; margin-bottom: 4px;">明瞭さ</div>
          <div style="font-weight: 700; font-size: 16px; color: #9B59B6;">${ev.clarity || "明瞭"}</div>
        </div>
      </div>
    </div>
    
    <details id="speechDetailsPanel" style="margin-bottom: 12px;">
      <summary style="cursor: pointer; font-weight: 600; font-size: 13px; color: #667eea; padding: 8px; background: #f5f7fa; border-radius: 6px;">
        📈 詳細データを表示
      </summary>
      <div style="font-size: 12px; line-height: 1.8; color: #555; padding: 12px 8px; background: #fafbfc; border-radius: 6px; margin-top: 8px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>平均音量:</span>
          <span style="font-weight: 600; color: #6BCF7F;">${summary.avgVolume}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>音量変動:</span>
          <span style="font-weight: 600; color: #F5A623;">${summary.volumeVariance}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>エネルギー変動:</span>
          <span style="font-weight: 600; color: #E94B3C;">${summary.energyVariance}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>発話回数:</span>
          <span style="font-weight: 600; color: #9B59B6;">${summary.speechSegments} 回</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span>話した時間:</span>
          <span style="font-weight: 600; color: #1ABC9C;">${summary.totalSpeakingTime} 秒</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>発話速度:</span>
          <span style="font-weight: 600; color: #E67E22;">${summary.speakingRate} 回/分</span>
        </div>
      </div>
    </details>
  `;
  
  // Restore details open state
  if (wasOpen) {
    const newDetails = $("speechDetailsPanel");
    if (newDetails) newDetails.open = true;
  }
  
  // Close button handler
  const closeBtn = $("closeSpeechPanel");
  if (closeBtn) {
    closeBtn.onclick = () => {
      panel.style.display = "none";
    };
  }
}

function hideSpeechAnalysisPanel(){
  const panel = $("speechAnalysisPanel");
  if (panel) panel.remove();
  const toggleBtn = $("speechAnalysisToggle");
  if (toggleBtn) toggleBtn.remove();
}

/* speaking 制御 */
let patientSpeaking = false;
let speakEpoch = 0;
let stopTimer = null;
let fallbackStopTimer = null;
let watchdogTimer = null;
const STOP_DEBOUNCE_MS   = 120;
const FALLBACK_STOP_MS   = 3500;
const SPEAK_MAX_MS       = 8000;

/* v4.61: エコー対策削除 - 看護師発話を全て記録 */

/* 進捗バー（採点待ちで端に張り付かないよう、holdAt 未満で往復） */
let prog = 0, progTimer = null, progDir = 1, progHoldAt = 100;
function startProgress(opts){
  stopProgress();
  const { holdAt = 100, speedMs = 200 } = opts || {};
  prog = 0; progDir = 1; progHoldAt = holdAt;
  const bar = $("tkProg");
  progTimer = setInterval(()=>{
    if (!bar) return;
    if (prog < progHoldAt) {
      prog = Math.min(progHoldAt, prog + 2);
    } else if (progHoldAt < 100) {
      const low = Math.max(0, progHoldAt - 6);
      prog += progDir * 1.2;
      if (prog >= progHoldAt) { prog = progHoldAt; progDir = -1; }
      if (prog <= low)        { prog = low;       progDir =  1; }
    }
    bar.style.width = prog + "%";
  }, speedMs);
}
function stopProgress(){
  if (progTimer){ clearInterval(progTimer); progTimer=null; }
  const bar=$("tkProg"); if(bar) bar.style.width="0%";
}

/* セッションIDは常に非表示 */
function hideSessionIds(){
  const tkWrap = $("tkSid")?.parentElement;
  if (tkWrap) tkWrap.style.display = "none";
  const rs = $("rsSid");
  if (rs) {
    const wrap = rs.closest(".small") || rs.parentElement;
    if (wrap) wrap.style.display = "none";
  }
}

/* 字幕（練習モードのみ） */
let showSubtitle = false;
let subtitleEl = null;
function ensureSubtitleDom(){
  if (subtitleEl && document.body.contains(subtitleEl)) return subtitleEl;
  const wrap = document.querySelector("#screen-talk .video-wrap");
  if (!wrap) return null;
  const el = document.createElement("div");
  el.id = "tkSubtitle";
  el.style.position = "absolute";
  el.style.left = "12px";
  el.style.right = "220px";
  el.style.bottom = "12px";
  el.style.background = "rgba(0,0,0,.38)";
  el.style.color = "#fff";
  el.style.fontSize = "16px";
  el.style.lineHeight = "1.5";
  el.style.fontWeight = "700";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "12px";
  el.style.backdropFilter = "blur(2px)";
  el.style.pointerEvents = "none";
  el.style.textShadow = "0 1px 2px rgba(0,0,0,.6)";
  el.style.maxWidth = "calc(100% - 240px)";
  el.style.opacity = "0";
  el.style.transition = "opacity .12s ease";
  wrap.appendChild(el);
  subtitleEl = el;
  return el;
}
function setSubtitle(text, who){
  if (!showSubtitle) return;
  const el = ensureSubtitleDom(); if (!el) return;
  const head = who ? (who==="nurse" ? "看護師: " : "患者: ") : "";
  const t = String(text||"").trim();
  el.textContent = t ? (head + t) : "";
  el.style.opacity = t ? "1" : "0";
}
function clearSubtitle(){ if (subtitleEl) subtitleEl.style.opacity = "0"; }

/* Badge */
function setPatientBadge(noOrNull){
  let el = document.getElementById("tkPatNo");
  if (!noOrNull){ if (el) el.remove(); return; }
  if (!el){
    el = document.createElement("div");
    el.id = "tkPatNo";
    el.style.cssText = "position:fixed;top:10px;right:12px;z-index:60;background:rgba(0,0,0,.65);color:#fff;padding:4px 8px;border-radius:999px;font-size:12px;opacity:.9";
    document.body.appendChild(el);
  }
  el.textContent = `患者No: ${String(noOrNull).padStart(3,"0")}`;
}

/* Scenarios */
const scenarios = {
  chest: { id:"chest", title:"胸痛", condition:"胸が締めつけられるように痛む", symptoms:"胸骨後部の圧迫感、冷や汗、動くと増悪" },
  head:  { id:"head",  title:"頭痛", condition:"こめかみがズキズキする", symptoms:"拍動性頭痛、吐き気、光過敏" },
  abdomen:{id:"abdomen",title:"腹痛", condition:"右下腹部が痛い", symptoms:"移動痛、発熱、食欲低下" },
  respiratory:{ id:"respiratory", title:"呼吸困難", condition:"息がしづらい", symptoms:"労作時息切れ、喘鳴" }
};

/* Fallback videos */
// v4.46: 性別に応じた動画を用意
const VIDEO_SRC_FEMALE = {
  idle: "/assets/patient_idle.mp4",
  speaking: "/assets/patient_speaking.mp4"
};
const VIDEO_SRC_MALE = {
  idle: "/assets/man_patient_idle.mp4",
  speaking: "/assets/man_patient_speaking.mp4"
};
// デフォルト（後方互換性のため女性）
const VIDEO_SRC_FALLBACK = VIDEO_SRC_FEMALE;

/* Path helpers */
// v4.46: 性別パラメータを追加
function videosForExam(no, gender){ 
  // Version 3.57: カスタム患者システムに完全移行 - 全患者でデフォルト動画を使用
  // Ver2の固定患者（001-010）と練習モードの階層的動画システムは完全廃止
  // v4.46: 性別に応じて動画を切り替え
  if (gender === "male") {
    console.log(`[videosForExam] Patient No.${no}: Using MALE videos`);
    return VIDEO_SRC_MALE;
  } else {
    console.log(`[videosForExam] Patient No.${no}: Using FEMALE videos`);
    return VIDEO_SRC_FEMALE;
  }
}

/* UI helpers */
function setPill(text){
  const p = $("tkPill"); if (!p) return;
  p.textContent = text || "";
  p.style.transform = "scale(1.02)";
  setTimeout(()=>{ p.style.transform = ""; }, 80);
}
let preloaded = { idle:false, speaking:false };
function primeVideos(){
  const VS = window.__VIDEO_SRC || VIDEO_SRC_FALLBACK;
  const preload = (src,key)=>{
    // 2回目以降も確実にpreloadするため、フラグをリセット
    preloaded[key] = false;
    const v = document.createElement("video");
    v.src = src; v.preload="auto"; v.muted=true; v.playsInline=true; v.style.display="none";
    const done=()=>{ 
      preloaded[key]=true; 
      console.log('[primeVideos] Preloaded:', key, src);
      try{ document.body.removeChild(v);}catch{} 
    };
    v.oncanplaythrough=done; 
    v.onerror=(e)=>{ 
      console.warn('[primeVideos] Preload error for', key, ':', e);
      done(); 
    };
    document.body.appendChild(v); v.load();
  };
  console.log('[primeVideos] Starting preload...');
  preload(VS.idle,"idle"); preload(VS.speaking,"speaking");
}
function setVideoState(mode){
  const v = $("tkVideo");
  if (!v) {
    console.error('[setVideoState] Video element not found!');
    return;
  }
  
  console.log('[setVideoState] Setting video state to:', mode);
  
  const VS = window.__VIDEO_SRC || VIDEO_SRC_FALLBACK;
  const src = (mode==="speaking") ? (VS.speaking || VIDEO_SRC_FALLBACK.speaking)
                                  : (VS.idle     || VIDEO_SRC_FALLBACK.idle);
  
  const currentSrc = v.getAttribute("data-src");
  const needsReload = (currentSrc !== src) || (v.readyState < 2);
  
  if (needsReload){
    console.log('[setVideoState] Reloading video - currentSrc:', currentSrc, 'newSrc:', src, 'readyState:', v.readyState);
    v.setAttribute("data-src", src);
    v.src = src;
    v.load();
    
    // 動画読み込み完了を待つ
    return new Promise((resolve) => {
      if (v.readyState >= 3) {
        console.log('[setVideoState] Video already loaded');
        playVideo();
        resolve();
      } else {
        const onCanPlay = () => {
          console.log('[setVideoState] Video loaded');
          v.removeEventListener('canplaythrough', onCanPlay);
          v.removeEventListener('error', onError);
          playVideo();
          resolve();
        };
        const onError = (e) => {
          console.warn('[setVideoState] Video load error:', e);
          v.removeEventListener('canplaythrough', onCanPlay);
          v.removeEventListener('error', onError);
          playVideo(); // エラーでも再生試行
          resolve();
        };
        v.addEventListener('canplaythrough', onCanPlay);
        v.addEventListener('error', onError);
      }
    });
  } else {
    console.log('[setVideoState] Video already loaded, just playing - readyState:', v.readyState);
    playVideo();
    return Promise.resolve();
  }
  
  function playVideo() {
    if (mode==="speaking"){ try{ v.currentTime = 0; }catch{} }
    v.muted = true; v.loop = true; v.playsInline = true;
    const tryPlay = ()=> v.play().catch((e)=>console.warn('[setVideoState] Play error:', e));
    tryPlay(); 
    document.addEventListener("pointerdown", tryPlay, { once:true });
    console.log('[setVideoState] Video playing, mode:', mode);
  }
}
function appendMsg(who, text){
  const d=document.createElement("div");
  d.className=(who==="nurse")?"msg-nurse":"msg-patient";
  d.textContent=(who==="nurse"?"看護師: ":"患者: ")+text;
  $("tkLog")?.appendChild(d);
  const log=$("tkLog"); if(log) log.scrollTop=log.scrollHeight;
  
  // Version 3.06: 対話テキスト表示 - 画面下部に現在話している内容を1行表示
  if (window.__showConversationText) {
    const conversationTextDisplay = $("conversationTextDisplay");
    if (conversationTextDisplay) {
      const prefix = (who === "nurse") ? "[看護師] " : "[患者] ";
      conversationTextDisplay.textContent = prefix + text;
    }
  }
}

/* speaking helpers */
function clearFallbackStop(){ if (fallbackStopTimer){ clearTimeout(fallbackStopTimer); fallbackStopTimer=null; } }
function startSpeaking(){
  patientSpeaking = true;
  speakEpoch++;
  setPill("患者: 発話中");
  setVideoState("speaking");
  if (stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
  clearFallbackStop();
  if (watchdogTimer){ clearTimeout(watchdogTimer); }
  const epoch = speakEpoch;
  watchdogTimer = setTimeout(()=>{ if (patientSpeaking && epoch === speakEpoch) stopSpeaking(); }, SPEAK_MAX_MS);
}
function scheduleStop(ms){
  const epochAtStop = speakEpoch;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(()=>{ if (epochAtStop === speakEpoch) stopSpeaking(); }, ms);
}
function scheduleFallbackStop(){
  clearFallbackStop();
  const epoch = speakEpoch;
  fallbackStopTimer = setTimeout(()=>{ if (patientSpeaking && epoch === speakEpoch) stopSpeaking(); }, FALLBACK_STOP_MS);
}
function stopSpeaking(){
  patientSpeaking = false;
  if (watchdogTimer){ clearTimeout(watchdogTimer); watchdogTimer=null; }
  if (stopTimer){ clearTimeout(stopTimer); stopTimer=null; }
  clearFallbackStop();
  setPill("待機中");
  setVideoState("idle");
}

/* =======================================================================
 * Version 3.0: 症状別モード削除（患者作成は管理者画面へ移行）
 * ======================================================================= */

// 患者の使用回数をインクリメント（管理者作成患者用）
async function incrementPatientUsageCount(patientId) {
  try {
    const token = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);
    if (!token) return;

    await fetch(`/api/generated-patients/${patientId}/use`, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token }
    });
  } catch (e) {
    console.error('[incrementPatientUsageCount] Error:', e);
  }
}

/* 初期化 */
document.addEventListener("DOMContentLoaded", ()=>{
  hideSessionIds();

  // ステータスボタンを初期状態で非表示
  const toggleBtn = $("toggleStatusBtn");
  if (toggleBtn) toggleBtn.style.display = 'none';

  show("screen-login");
  const finishBtn = $("tkFinish"); if (finishBtn) finishBtn.disabled = false;

  const backBtn = $("rsBackHome");
  if (backBtn) backBtn.textContent = "メニューに戻る";

  // Setup login/logout button handlers
  const btnLogin = $("btnLogin");
  const btnLogout = $("btnLogout");
  
  if (btnLogin) {
    btnLogin.addEventListener("click", async ()=>{
      try {
        console.log("[auth] Login button clicked");
        // Use popup method (COOP headers removed in server.js)
        if (window.firebaseSignInWithPopup) {
          await window.firebaseSignInWithPopup();
        } else {
          console.error("[auth] firebaseSignInWithPopup not available");
          alert("認証機能が読み込まれていません。ページを再読み込みしてください。");
        }
      } catch (e) {
        console.error("[auth] Login error:", e);
        alert("ログインに失敗しました: " + (e?.message || e));
      }
    });
  }
  
  if (btnLogout) {
    btnLogout.addEventListener("click", async ()=>{
      try {
        console.log("[auth] Logout button clicked");
        if (window.firebaseSignOut) {
          await window.firebaseSignOut();
          show("screen-login");
        } else {
          console.error("[auth] firebaseSignOut not available");
        }
      } catch (e) {
        console.error("[auth] Logout error:", e);
      }
    });
  }

  window.addEventListener("auth-state",(ev)=>{ const si=!!(ev?.detail?.signedIn); show(si?"screen-home":"screen-login"); });
  (async ()=>{ const si=(window.__authSignedIn===true)||!!(await (window.getIdTokenAsync?.()||Promise.resolve(null))); show(si?"screen-home":"screen-login"); })();

  // Version 3.0: 問診練習（旧：患者別モード）
  $("goTest")?.addEventListener("click", onGoScenarioMode);
  $("goHistory")?.addEventListener("click", onGoHistory);
  $("backFromPatientSelect")?.addEventListener("click", ()=>{ setPatientBadge(null); show("screen-home"); });
  $("backFromHistory")?.addEventListener("click", ()=>{ show("screen-home"); });
  $("rsBackHome")?.addEventListener("click", ()=>{ setPatientBadge(null); show("screen-home"); });
  $("tkFinish")?.addEventListener("click", onFinishClick);
  $("downloadPatientPdf")?.addEventListener("click", downloadPatientPdf);
  $("startWithSelectedPatient")?.addEventListener("click", startWithSelectedPatient);

  // Version 3.37: 症状別モード削除により、scenario-card要素は存在しないためコード削除

  // 統合ステータスパネルのトグルボタン（重複登録を防ぐ）
  if (!window.__statusButtonsInitialized) {
    console.log('[Status] Initializing status button listeners');
    const toggleBtn = $("toggleStatusBtn");
    const closeBtn = $("closeStatusBtn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", ()=>{
        console.log('[Status] Toggle button CLICKED');
        toggleStatusPanel();
      });
      console.log('[Status] Toggle button listener added');
    } else {
      console.warn('[Status] Toggle button not found!');
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", hideStatusPanel);
      console.log('[Status] Close button listener added');
    }
    window.__statusButtonsInitialized = true;
  } else {
    console.log('[Status] Button listeners already initialized');
  }
});
function ensureZhOption(){
  const sel = $("pmLang"); if (!sel) return;
  const exists = [...sel.options].some(o => (o.value||o.textContent).toLowerCase().startsWith("zh"));
  if (!exists){ const o=document.createElement("option"); o.value="zh"; o.textContent="中国語"; sel.appendChild(o); }
}

/* 言語/氏名/声 */
function mapLang(x){
  const t = String(x||"ja").toLowerCase();
  if (t.startsWith("ko")||t.includes("韓")) return "ko";
  if (t.startsWith("zh")||t.includes("中")) return "zh";
  if (t.startsWith("en")||t.includes("英")) return "en";
  if (t.startsWith("th")||t.includes("タイ")) return "th";
  return "ja";
}
function defaultNameFor(lang, gender){
  const l = mapLang(lang);
  const g = String(gender||"female").toLowerCase()==="male" ? "male" : "female";
  if (l === "ja") return g==="male" ? "きむら　たろう" : "やまだ　はなこ";
  if (l === "ko") return g==="male" ? "イ・ジュン" : "キム・ソユン";
  if (l === "zh") return g==="male" ? "王伟" : "李娜";
  if (l === "th") return g==="male" ? "สมชาย" : "สมหญิง"; // Somchai / Somying (Thai common names)
  return g==="male" ? "John Smith" : "Mary Smith";
}
// 音声選択: 性別による明確な違いを重視
// OpenAI Realtime API available voices:
// - Female: shimmer (bright, warm, clearly feminine)
// - Male: echo (deeper, masculine tone)
// Note: alloyは中性的すぎる、onyxとnovaは不安定な報告あり
function chooseVoice({ gender="female", ageBand="adult" } = {}){
  const g = String(gender).toLowerCase();
  
  // 性別に応じた自然な声
  // shimmer: 明るい女性の声
  // echo: より男性的な声

  if (g === "male") {
    return "echo";  // より男性的な声
  } else {
    return "shimmer";  // 明るい女性の声
  }
}

/* Version 3.0: 問診練習（旧：患者別モード） */
let patientListData = [];
let selectedPatientId = null;

async function onGoScenarioMode(){
  try{
    const t = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);
    if (!t){ alert("ログインしてください"); return; }
    
    // 患者一覧を取得
    const loading = $("patientListLoading");
    const error = $("patientListError");
    const layout = $("patientSelectLayout");
    
    if (loading) loading.style.display = "";
    if (error) error.style.display = "none";
    if (layout) layout.style.display = "none";
    
    // Version 3.06: ボタンを有効化（2回目以降の接続のため）
    const startBtn = $("startWithSelectedPatient");
    const pdfBtn = $("downloadPatientPdf");
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.style.display = "none"; // 初期状態は非表示
      console.log('[onGoScenarioMode] Start button enabled');
    }
    if (pdfBtn) {
      pdfBtn.disabled = false;
      pdfBtn.style.display = "none"; // 初期状態は非表示
    }
    
    show("screen-patient-select");
    
    // Version 3.53: キャッシュバスティングを追加して削除済み患者が表示される問題を修正
    const cacheBuster = Date.now();
    const r = await fetch(`/api/test-patients?_t=${cacheBuster}`, { 
      headers: { 
        Authorization: "Bearer " + t,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
      },
      cache: "no-store"
    });
    const j = await r.json().catch(()=>({}));
    
    if (!r.ok){
      if (loading) loading.style.display = "none";
      if (error){
        error.textContent = "患者取得エラー: " + (j.error||("HTTP "+r.status));
        error.style.display = "";
      }
      return;
    }
    
    const list = Array.isArray(j.patients) ? j.patients : [];
    
    if (!list.length){
      if (loading) loading.style.display = "none";
      if (error){
        error.textContent = "シナリオ患者が未設定か、すべて停止中です。管理者にお問い合わせください。";
        error.style.display = "";
      }
      return;
    }
    
    // 患者リストを保存
    patientListData = list;
    selectedPatientId = null;
    
    // 患者リストを表示（左側）
    if (loading) loading.style.display = "none";
    const listEl = $("patientList");
    if (listEl){
      listEl.innerHTML = list.map(p => {
        const genderLabel = p.gender === "male" ? "男性" : "女性";
        const ageLabel = p.ageBand === "child" ? "子供" : (p.ageBand === "elderly" ? "高齢者" : "大人");
        let langLabel = p.language === "ko" ? "韓国語" : (p.language === "zh" ? "中国語" : (p.language === "th" ? "タイ語" : (p.language === "en" ? "英語" : "日本語")));
        // カタコト日本語設定の場合は表示を変更
        if (p.brokenJapanese === true) {
          if (p.language === "en") langLabel = "英語（カタコト）";
          else if (p.language === "ko") langLabel = "韓国語（カタコト）";
          else if (p.language === "zh") langLabel = "中国語（カタコト）";
          else if (p.language === "th") langLabel = "タイ語（カタコト）";
        }
        
        return `
          <div class="patient-item" data-patient-id="${p.id}">
            <div class="name">${esc(p.name)}</div>
            <div class="meta">${genderLabel} / ${ageLabel} / ${langLabel}</div>
          </div>
        `;
      }).join("");
      
      // 患者アイテムのクリックイベント
      listEl.querySelectorAll(".patient-item").forEach(item => {
        item.addEventListener("click", () => {
          const patientId = item.getAttribute("data-patient-id");
          selectPatient(patientId);
        });
      });
    }
    
    if (layout) layout.style.display = "flex";
    
  }catch(e){
    const error = $("patientListError");
    const loading = $("patientListLoading");
    if (loading) loading.style.display = "none";
    if (error){
      error.textContent = "エラー: " + (e.message || e);
      error.style.display = "";
    }
  }
}

/* 患者を選択して詳細表示 */
function selectPatient(patientId){
  selectedPatientId = patientId;
  const p = patientListData.find(x => x.id === patientId);
  if (!p) return;
  
  // 左側リストの選択状態を更新
  const listEl = $("patientList");
  if (listEl){
    listEl.querySelectorAll(".patient-item").forEach(item => {
      item.classList.toggle("selected", item.getAttribute("data-patient-id") === patientId);
    });
  }
  
  // 右側に詳細情報を表示
  const detailEl = $("patientDetail");
  if (detailEl){
    const genderLabel = p.gender === "male" ? "男性" : "女性";
    const ageLabel = p.ageBand === "child" ? "子供" : (p.ageBand === "elderly" ? "高齢者" : "大人");
    let langLabel = p.language === "ko" ? "韓国語" : (p.language === "zh" ? "中国語" : (p.language === "th" ? "タイ語" : (p.language === "en" ? "英語" : "日本語")));
    // カタコト日本語設定の場合は表示を変更
    if (p.brokenJapanese === true) {
      if (p.language === "en") langLabel = "英語（カタコト）";
      else if (p.language === "ko") langLabel = "韓国語（カタコト）";
      else if (p.language === "zh") langLabel = "中国語（カタコト）";
      else if (p.language === "th") langLabel = "タイ語（カタコト）";
    }
    
    // Version 4.22: 学生表示用プロフィールのみ表示（AI用にフォールバックしない）
    const hasDisplayProfile = p.displayProfile && p.displayProfile.trim() !== "";
    console.log('[selectPatient] Patient:', p.name, 'displayProfile:', p.displayProfile, 'hasDisplayProfile:', hasDisplayProfile);
    
    // Version 4.27: 評価項目チェックボックスを生成（括弧書き説明付き、コンパクト）
    const evalCheckboxesHtml = EVALUATION_ITEMS.map(item => `
      <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;font-size:12px;white-space:nowrap">
        <input type="checkbox" class="eval-item-checkbox" data-item-id="${item.id}" 
               ${selectedEvalItems.has(item.id) ? 'checked' : ''}
               style="width:13px;height:13px;cursor:pointer;margin:0">
        <span>${item.name}</span><span style="color:#6b7280;font-size:11px">(${item.description})</span>
      </label>
    `).join('');
    
    detailEl.innerHTML = `
      <div class="section">
        <div class="section-title">基本情報</div>
        <div class="section-content" style="display:flex;gap:16px;align-items:center">
          <span><strong>患者No:</strong> ${esc(p.patientNo)}</span>
          <span><strong>氏名:</strong> ${esc(p.name)}</span>
          <span>${genderLabel} / ${ageLabel} / ${langLabel}</span>
        </div>
      </div>
      <div class="section">
        <div class="section-title">患者プロフィール</div>
        <div class="section-content">${hasDisplayProfile ? esc(p.displayProfile) : '<span style="color:#e74c3c; font-weight:500">⚠️ 未設定です。管理画面の「患者管理」から該当患者を編集し、「表示用患者プロフィール（学生向け）」を設定してください。</span>'}</div>
      </div>
      <div style="margin-top:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:6px 10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:12px;font-weight:600;color:#166534">📋 評価項目の選択</span>
          <div style="display:flex;gap:4px;align-items:center">
            <span style="font-size:11px;color:#374151">選択:<strong id="selectedEvalCount">${selectedEvalItems.size}</strong>項目(満点:<strong id="maxScore">${selectedEvalItems.size * 2}</strong>点)</span>
            <button type="button" id="btnSelectAllEval" class="secondary" style="font-size:10px;padding:1px 6px">全選択</button>
            <button type="button" id="btnDeselectAllEval" class="secondary" style="font-size:10px;padding:1px 6px">全解除</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px 8px">
          ${evalCheckboxesHtml}
        </div>
      </div>
    `;
    
    // チェックボックスのイベントリスナーを追加
    detailEl.querySelectorAll('.eval-item-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const itemId = e.target.dataset.itemId;
        if (e.target.checked) {
          selectedEvalItems.add(itemId);
        } else {
          selectedEvalItems.delete(itemId);
        }
        updateEvalItemsDisplay();
      });
    });
    
    // 全選択/全解除ボタンのイベントリスナー
    const btnSelectAll = document.getElementById('btnSelectAllEval');
    const btnDeselectAll = document.getElementById('btnDeselectAllEval');
    if (btnSelectAll) {
      btnSelectAll.addEventListener('click', () => {
        selectedEvalItems = new Set(EVALUATION_ITEMS.map(item => item.id));
        detailEl.querySelectorAll('.eval-item-checkbox').forEach(cb => cb.checked = true);
        updateEvalItemsDisplay();
      });
    }
    if (btnDeselectAll) {
      btnDeselectAll.addEventListener('click', () => {
        selectedEvalItems.clear();
        detailEl.querySelectorAll('.eval-item-checkbox').forEach(cb => cb.checked = false);
        updateEvalItemsDisplay();
      });
    }
  }
  
  // ボタンと対話オプションを表示
  const pdfBtn = $("downloadPatientPdf");
  const startBtn = $("startWithSelectedPatient");
  const optionsArea = $("conversationOptionsArea");
  if (pdfBtn) {
    pdfBtn.disabled = false; // Version 3.06: 明示的に有効化
    pdfBtn.style.display = "";
  }
  if (startBtn) {
    startBtn.disabled = false; // Version 3.06: 明示的に有効化
    startBtn.style.display = "";
    console.log('[displayPatientDetail] Start button enabled and displayed');
  }
  if (optionsArea) optionsArea.style.display = "";
}

/* 評価項目の全選択 */
function selectAllEvalItems() {
  selectedEvalItems = new Set(EVALUATION_ITEMS.map(item => item.id));
  document.querySelectorAll('.eval-item-checkbox').forEach(cb => cb.checked = true);
  updateEvalItemsDisplay();
}

/* 評価項目の全解除 */
function deselectAllEvalItems() {
  selectedEvalItems.clear();
  document.querySelectorAll('.eval-item-checkbox').forEach(cb => cb.checked = false);
  updateEvalItemsDisplay();
}

/* 評価項目選択状態の表示更新 */
function updateEvalItemsDisplay() {
  const countEl = $("selectedEvalCount");
  const maxScoreEl = $("maxScore");
  if (countEl) countEl.textContent = selectedEvalItems.size;
  if (maxScoreEl) maxScoreEl.textContent = selectedEvalItems.size * 2;  // 各項目2点満点
}

/* 選択した患者情報をPDF出力 */
async function downloadPatientPdf(){
  if (!selectedPatientId) return;
  const p = patientListData.find(x => x.id === selectedPatientId);
  if (!p) return;
  
  const genderLabel = p.gender === "male" ? "男性" : "女性";
  const ageLabel = p.ageBand === "child" ? "子供" : (p.ageBand === "elderly" ? "高齢者" : "大人");
  let langLabel = p.language === "ko" ? "韓国語" : (p.language === "zh" ? "中国語" : (p.language === "th" ? "タイ語" : (p.language === "en" ? "英語" : "日本語")));
  // カタコト日本語設定の場合は表示を変更
  if (p.brokenJapanese === true) {
    if (p.language === "en") langLabel = "英語（カタコト）";
    else if (p.language === "ko") langLabel = "韓国語（カタコト）";
    else if (p.language === "zh") langLabel = "中国語（カタコト）";
    else if (p.language === "th") langLabel = "タイ語（カタコト）";
  }
  
  // 印刷用のHTMLページを新しいウィンドウで開く
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('ポップアップがブロックされました。ブラウザの設定を確認してください。');
    return;
  }
  
  printWindow.document.write(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>患者情報 - ${p.name}</title>
  <style>
    @media print {
      @page { margin: 2cm; }
    }
    body { 
      font-family: "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif; 
      padding: 40px; 
      line-height: 1.8; 
      color: #333; 
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { 
      color: #6366f1; 
      border-bottom: 3px solid #6366f1; 
      padding-bottom: 10px; 
      margin-bottom: 30px;
    }
    .info-row {
      display: flex;
      gap: 24px;
      padding: 12px;
      background: #f9fafb;
      border-radius: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .info-item {
      display: flex;
      gap: 8px;
    }
    .info-label {
      font-weight: 700;
      color: #374151;
    }
    .section { 
      margin: 20px 0; 
    }
    .section-title { 
      font-weight: 700; 
      font-size: 16px; 
      color: #374151; 
      margin-bottom: 8px; 
      border-left: 4px solid #6366f1;
      padding-left: 10px;
    }
    .section-content { 
      background: #f9fafb; 
      padding: 16px; 
      border-radius: 8px; 
      white-space: pre-wrap; 
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <h1>患者情報</h1>
  <div class="info-row">
    <div class="info-item">
      <span class="info-label">患者No:</span>
      <span>${p.patientNo}</span>
    </div>
    <div class="info-item">
      <span class="info-label">氏名:</span>
      <span>${p.name}</span>
    </div>
    <div class="info-item">
      <span>${genderLabel} / ${ageLabel} / ${langLabel}</span>
    </div>
  </div>
  <div class="section">
    <div class="section-title">患者プロフィール</div>
    <div class="section-content">${p.displayProfile && p.displayProfile.trim() !== "" ? p.displayProfile : "⚠️ 未設定 - 管理画面で設定してください"}</div>
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
      }, 500);
    };
  </script>
</body>
</html>
  `);
  printWindow.document.close();
}

/* 選択した患者で対話開始 */
async function startWithSelectedPatient(){
  if (!selectedPatientId) return;
  const p = patientListData.find(x => x.id === selectedPatientId);
  if (!p) return;

  // Version 3.06: ボタンを無効化して二重クリックを防ぐ
  const startBtn = $("startWithSelectedPatient");
  if (startBtn) {
    console.log('[startWithSelectedPatient] Disabling button, current state:', startBtn.disabled);
    startBtn.disabled = true;
  }

  // brokenJapaneseのデフォルト値：未定義の場合、外国語ならtrueとする
  let brokenJapanese = p.brokenJapanese;
  if (brokenJapanese === undefined || brokenJapanese === null) {
    // 既存データ互換性: 外国語患者はデフォルトでカタコト日本語を話す
    brokenJapanese = (p.language === 'ko' || p.language === 'zh' || p.language === 'en');
  }

  // Version 3.40: シナリオ削除 - scenarioパラメータは不要
  
  // Version 3.44: デバッグログ - 患者データのバイタル設定を確認
  console.log('[startWithSelectedPatient] Patient expected vitals:', p.expectedVitals);
  console.log('[startWithSelectedPatient] Patient custom vitals:', p.customVitals);
  // v4.40: 身体診察の所見設定もログ出力
  console.log('[startWithSelectedPatient] Patient expected exams:', p.expectedExams);

  // Version 3.06: 対話テキスト表示フラグを読み取り
  const showConversationTextCheckbox = $("showConversationText");
  const showConversationText = showConversationTextCheckbox ? showConversationTextCheckbox.checked : false;

  // v4.46: 性別に応じた動画を選択
  window.__VIDEO_SRC = videosForExam(p.patientNo, p.gender);
  primeVideos();
  
  // Version 4.25: 選択された評価項目を取得
  const selectedItems = Array.from(selectedEvalItems);
  console.log('[startWithSelectedPatient] Selected evaluation items:', selectedItems);
  
  await startTalk({
    mode:"test",
    showConversationText: showConversationText,
    // v4.40: expectedExamsを追加
    patient:{ id:p.id, no:p.patientNo, name:p.name, expectedVitals:p.expectedVitals, customVitals:p.customVitals, expectedExams:p.expectedExams },
    persona:{ name:p.name, ageBand:p.ageBand, gender:p.gender, language:p.language, brokenJapanese:brokenJapanese, profileSeed:p.profile },
    timeLimit: p.timeLimit || 180,
    selectedEvalItems: selectedItems  // Version 4.25: 評価項目選択
  });
}

/* Realtime main */
async function startTalk(cfg){
  try{
    // 既存の接続をクリーンアップ
    await safeStop();
    
    hideSessionIds();
    $("tkSid") && ($("tkSid").textContent = "");
    patientSpeaking=false; speakEpoch=0;
    showSubtitle = (cfg.mode === "practice");
    ensureSubtitleDom(); clearSubtitle();

    const idToken0 = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);
    if (!idToken0){ alert("ログインしてください"); show("screen-login"); return; }

    $("tkLog") && ($("tkLog").innerHTML = "");
    
    // Version 3.06: 対話テキスト表示機能（画面下部に1行表示）
    const showConversationText = cfg.showConversationText || false;
    const conversationTextArea = $("conversationTextArea");
    const conversationTextDisplay = $("conversationTextDisplay");
    const conversationSpacer = $("conversationSpacer");
    if (conversationTextArea) {
      conversationTextArea.style.display = showConversationText ? "block" : "none";
    }
    if (conversationSpacer) {
      conversationSpacer.style.display = showConversationText ? "none" : "block";
    }
    if (conversationTextDisplay) {
      conversationTextDisplay.textContent = "";
    }
    window.__showConversationText = showConversationText;
    
    setPill("準備中…"); 
    show("screen-talk");
    if (cfg.mode==="test" && cfg.patient?.no) setPatientBadge(cfg.patient.no); else setPatientBadge(null);
    
    // 動画読み込み完了を待機
    const video = $("tkVideo");
    if (video) {
      await new Promise((resolve) => {
        if (video.readyState >= 3) {
          console.log('[startTalk] Video already loaded');
          resolve();
        } else {
          console.log('[startTalk] Waiting for video to load...');
          const onCanPlay = () => {
            console.log('[startTalk] Video loaded and ready');
            video.removeEventListener('canplaythrough', onCanPlay);
            video.removeEventListener('error', onError);
            resolve();
          };
          const onError = (e) => {
            console.warn('[startTalk] Video load error, continuing anyway:', e);
            video.removeEventListener('canplaythrough', onCanPlay);
            video.removeEventListener('error', onError);
            resolve();
          };
          video.addEventListener('canplaythrough', onCanPlay);
          video.addEventListener('error', onError);
          // タイムアウト: 5秒経過しても読み込まれなければ続行
          setTimeout(() => {
            console.warn('[startTalk] Video load timeout, continuing...');
            video.removeEventListener('canplaythrough', onCanPlay);
            video.removeEventListener('error', onError);
            resolve();
          }, 5000);
        }
      });
    }
    
    setVideoState("idle"); 
    startProgress();

    // 評価ボタンを無効化（接続確立後に有効化）
    const finishBtn = $("tkFinish");
    if (finishBtn) finishBtn.disabled = true;

    // 統合ステータスパネル: すべてのモードで最初は閉じる（患者発話後に自動表示）
    const toggleBtn = $("toggleStatusBtn");
    console.log('[startTalk] toggleBtn element:', toggleBtn, 'current display:', toggleBtn?.style.display);
    if (toggleBtn) {
      toggleBtn.style.display = 'block';
      console.log('[startTalk] Set toggleBtn display to block, new value:', toggleBtn.style.display);
    } else {
      console.warn('[startTalk] toggleBtn not found!');
    }
    statusPanelShownOnce = false; // フラグをリセット
    hideStatusPanel(); // 明示的に閉じる

    // バイタルサイン、身体診察、音声分析のセクションを非表示にする
    const vitalSection = document.getElementById('vitalStatusSection');
    const examSection = document.getElementById('examStatusSection');
    const speechSection = document.getElementById('speechStatusSection');
    if (vitalSection) vitalSection.style.display = 'none';
    if (examSection) examSection.style.display = 'none';
    if (speechSection) speechSection.style.display = 'none';

    // ペルソナ確定
    const effLang   = (cfg.persona?.language || cfg.lang || "ja");
    const effGender = (cfg.persona?.gender   || cfg.gender || "female");
    const effName   = (cfg.persona?.name && cfg.persona.name.trim())
      ? cfg.persona.name.trim()
      : defaultNameFor(effLang, effGender);

    // セッション作成（DB）
    currentSessionId = null;
    
    // Version 4.25: 選択された評価項目をグローバルで保持
    window.__currentSelectedEvalItems = cfg.selectedEvalItems || EVALUATION_ITEMS.map(item => item.id);
    console.log('[startTalk] Selected eval items for session:', window.__currentSelectedEvalItems);
    
    try{
      const sr = await fetch("/api/sessions/start", {
        method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer " + idToken0 },
        body: JSON.stringify({
          type: cfg.mode==="test" ? "exam" : "training",
          language: effLang,
          patient: cfg.patient || null,
          persona: {
            name: effName,
            ageBand: cfg.persona?.ageBand || cfg.ageBand || "adult",
            gender:  effGender,
            language:effLang,
            profileSeed: cfg.persona?.profileSeed || cfg.profile || ""
          },
          selectedEvalItems: window.__currentSelectedEvalItems  // Version 4.25: 評価項目
        })
      });
      const sj = await sr.json().catch(()=>({}));
      if (sr.ok){
        currentSessionId = sj.sessionId || sj.id || null;
        console.log("[セッション作成] 成功:", currentSessionId);
      }
      else {
        console.error("[sessions/start] failed", sj?.error||sr.status);
        setPill("ログなしモード（会話のみ）");
      }
    }catch(e){
      console.error("[sessions/start] error", e);
      setPill("ログなしモード（会話のみ）");
    }

    // シナリオ設定を読み込む
    vitalItemsShown.clear();
    examItemsShown.clear();
    vitalChecked = false;
    examChecked = false;
    // v4.31: 確認モーダルのキューをリセット
    confirmModalQueue = [];
    isConfirmModalOpen = false;
    
    // 浮遊パネルをクリア
    const floatingContainer = document.getElementById('floatingPanels');
    if (floatingContainer) {
      floatingContainer.innerHTML = '';
      // Version 3.38: インラインスタイルを初期化して非表示に設定
      floatingContainer.style.display = 'none';
      floatingContainer.style.zIndex = '-1';
      floatingContainer.style.pointerEvents = 'none';
      console.log('[startTalk] floatingContainer cleared and hidden');
    }
    
    // 独立した帯パネルをクリア
    const statusPanel = document.getElementById('statusPanel');
    if (statusPanel) {
      const oldStrips = statusPanel.querySelectorAll('.independent-strip');
      oldStrips.forEach(strip => strip.remove());
    }

    // Version 3.40: シナリオ削除 - "global" キーワード設定を読み込み
    try {
      console.log('[Keyword Config] Loading global keyword configuration');
      const configRes = await fetch(`/api/scenarios/global/config`, {
        headers: { Authorization: "Bearer " + idToken0 }
      });
      if (configRes.ok) {
        const configData = await configRes.json();
        if (configData.ok && configData.config) {
          currentScenarioConfig = configData.config;
          console.log('[Keyword Config] Loaded:', currentScenarioConfig);
        }
      }
    } catch (configErr) {
      console.error('[Keyword Config] Failed to load:', configErr);
      // デフォルト設定を使用
      currentScenarioConfig = null;
    }

    // Version 3.42: 患者の想定バイタル異常に基づいてデータを初期化
    // Version 3.44: デバッグログ追加
    // v4.31: expectedExamsも追加
    console.log('[startTalk] Initializing vital and exam data with patient expected vitals');
    console.log('[startTalk] cfg.patient:', cfg.patient);
    console.log('[startTalk] expectedVitals:', cfg.patient?.expectedVitals);
    console.log('[startTalk] customVitals:', cfg.patient?.customVitals);
    console.log('[startTalk] expectedExams:', cfg.patient?.expectedExams);
    initializeVitalAndExamData(cfg.patient?.expectedVitals, cfg.patient?.customVitals, cfg.patient?.expectedExams);

    // Mic
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1, sampleRate:48000 }
      });
    } catch (micErr) {
      throw new Error("マイクのアクセス許可が必要です: " + (micErr.message || micErr));
    }

    if (!micStream) {
      throw new Error("マイクストリームの取得に失敗しました");
    }

    // Initialize speech analysis
    initSpeechAnalysis(micStream);

    // Show microphone button immediately
    setTimeout(() => visualizeSpeechMetrics(), 100);

    // Load recording settings
    try {
      const settingsRes = await fetch("/api/settings", {
        headers: { Authorization: "Bearer " + idToken0 }
      });
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        // 設定が明示的に存在する場合はそれを使用、なければデフォルトでtrue
        recordingEnabled = settingsData.settings?.recordingEnabled !== undefined 
          ? settingsData.settings.recordingEnabled 
          : true;
        console.log('[Recording] Recording enabled:', recordingEnabled);
        console.log('[Recording] Will start recording after remote audio stream is available');
      } else {
        // 設定取得に失敗した場合もデフォルトでtrue
        recordingEnabled = true;
        console.log('[Recording] Settings not available, using default (enabled)');
      }
    } catch (err) {
      console.log('[Recording] Failed to load settings, using default (enabled):', err);
      recordingEnabled = true;
    }

    // 年齢帯を確定
    const effAgeBand = (cfg.persona?.ageBand || cfg.ageBand || "adult");

    // Ephemeral（voice を送る。model はサーバ側で gpt-realtime を使用）
    const ses = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken0 },
      body: JSON.stringify({
        voice: chooseVoice({ gender: effGender, ageBand: effAgeBand })
      })
    });
    const js = await ses.json().catch(()=>({}));
    if (!ses.ok || !(js?.ephemeralKey || js?.client_secret)) {
      throw new Error(js?.error || "ephemeral key 取得失敗");
    }
    const EPHEMERAL = js?.ephemeralKey || js?.client_secret?.value || js?.client_secret;

    // Web Speech API for nurse transcription (fallback for failed API transcription)
    // ====== v4.64: Web Speech API を無効化し、OpenAI Realtime API のみ使用 ======
    // 問題発生時は以下のコメントを解除して Web Speech API を復活させる
    /*
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'ja-JP';
      
      let nurseTranscript = '';
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            nurseTranscript = transcript;
            console.log('[Nurse] Web Speech final:', transcript);
            if (transcript && transcript.trim()) {
              recordLine("nurse", transcript);
            }
            setSubtitle(transcript, "nurse");
            const vitalItems = checkForVitalKeywords(transcript);
            if (vitalItems.length > 0) {
              console.log('[Modal] Vital keywords detected:', vitalItems, 'in:', transcript);
              showVitalModal(vitalItems);
            }
            const examItems = checkForExamKeywords(transcript);
            if (examItems.length > 0) {
              console.log('[Modal] Exam keywords detected:', examItems, 'in:', transcript);
              showExamModal(examItems);
            }
          } else {
            interim = transcript;
            setSubtitle(interim + '...', "nurse");
          }
        }
      };
      
      recognition.onerror = (event) => {
        console.error('[Nurse] Web Speech error:', event.error);
      };
      
      recognition.start();
      console.log('[Nurse] Web Speech Recognition started');
    }
    */
    console.log('[Nurse] v4.64: Using OpenAI Realtime API for transcription (Web Speech API disabled)');
    // ====== END v4.64 ======

    // WebRTC
    console.log("[WebRTC] Creating PeerConnection...");
    pc = new RTCPeerConnection({ iceServers:[{ urls:"stun:stun.l.google.com:19302" }] });
    console.log("[WebRTC] PeerConnection created:", pc);
    const tracks = micStream.getAudioTracks();
    console.log("[WebRTC] Audio tracks:", tracks);
    if (!tracks || tracks.length === 0) {
      throw new Error("オーディオトラックが見つかりません");
    }
    const track = tracks[0];
    console.log("[WebRTC] Adding transceiver for track:", track);
    pc.addTransceiver(track, { direction:"sendrecv" });
    pc.ontrack = (ev)=>{
      console.log("[Audio] ✓✓✓ ontrack event received! Track kind:", ev.track.kind);
      if (ev.track.kind === "audio"){
        console.log("[Audio] ✓✓✓ Audio track detected!");
        // 患者の音声ストリームを保存（録音用）
        remoteAudioStream = new MediaStream([ev.track]);
        console.log("[Audio] Remote audio stream saved for recording");

        audioSink = new Audio();
        audioSink.srcObject = remoteAudioStream;
        audioSink.volume = 1.0;  // Maximum volume
        console.log("[Audio] Track received, volume set to:", audioSink.volume);
        console.log("[Audio] Audio element created:", audioSink);
        const playAttempt = ()=> {
          console.log("[Audio] Attempting to play...");
          audioSink.play()
            .then(() => console.log("[Audio] ✓ Playback started successfully"))
            .catch((e) => console.error("[Audio] ✗ Playback failed:", e));
        };
        playAttempt();
        document.addEventListener("pointerdown", playAttempt, { once:true });

        // 患者の音声ストリームが利用可能になったら録音を開始
        if (recordingEnabled && !mediaRecorder) {
          console.log("[Audio] Starting recording now that remote audio is available");
          startRecording();
        }
      }
    };

    // DataChannel
    console.log("[DataChannel] Creating data channel...");
    dc = pc.createDataChannel("oai-events");
    console.log("[DataChannel] Data channel created:", dc);
    dc.onopen = ()=>{
      console.log("[DataChannel] ✓✓✓ Data channel opened!");
      // Version 3.40: シナリオ削除 - 患者プロフィールのみを使用
      const instr = buildInstructions({
        name: effName,
        ageBand: effAgeBand,
        gender:  effGender,
        lang:    effLang,
        brokenJapanese: cfg.persona?.brokenJapanese || false,
        profile: cfg.persona?.profileSeed || cfg.profile || ""
      });
      const voiceName = chooseVoice({ gender: effGender, ageBand: effAgeBand });

      // GA Realtime API: session.update uses nested audio.{input,output} structure.
      // voice は ephemeral key 生成時に確定済み（音声出力後は変更不可）なので audio.output には含めない。
      // v4.64 で有効化された看護師音声の文字起こしは audio.input.transcription にネスト。
      try{ dc.send(JSON.stringify({
        type:"session.update",
        session:{
          type: "realtime",
          instructions: instr,
          output_modalities: ["audio"],
          audio: {
            input: {
              transcription: { model: "whisper-1" },
              turn_detection: { type: "server_vad", silence_duration_ms: 700, prefix_padding_ms: 200 }
            }
          }
        }
      })); }catch{}

      // 競合対策: instructions と turn_detection / transcription を遅延再適用（言語設定の維持）
      [400, 1000, 1800].forEach(delay=>{
        setTimeout(()=>{ try{
          if (dc && dc.readyState==="open") {
            dc.send(JSON.stringify({
              type:"session.update",
              session:{
                type: "realtime",
                instructions: instr,
                audio: {
                  input: {
                    transcription: { model: "whisper-1" },
                    turn_detection: { type: "server_vad", silence_duration_ms: 700, prefix_padding_ms: 200 }
                  }
                }
              }
            }));
          }
        }catch{}; }, delay);
      });

      // 看護師から話しかける必要があるため、患者の自動挨拶は削除
      setPill("どうぞ！");
      setVideoState("idle");
      stopProgress();
      $("tkFinish") && ($("tkFinish").disabled=false);

      // タイマーを開始
      const timeLimitSeconds = cfg.timeLimit || 180;
      startConversationTimer(timeLimitSeconds);
    };

    // Realtime events
    dc.onmessage = (e)=>{
      let ev; try{ ev = JSON.parse(e.data); }catch{ return; }
      
      // Log all events to debug subtitle issue
      if (ev.type && !ev.type.includes('input_audio_buffer')) {
        console.log('[DataChannel] Event:', ev.type, ev);
      }

      switch(ev.type){
        case "input_audio_buffer.speech_started":
          setPill("看護師: 入力中…");
          setSubtitle("(音声入力中...)", "nurse");
          break;

        case "input_audio_transcription.started":
        case "conversation.item.input_audio_transcription.started":
          nurseBuf = "";
          break;

        case "input_audio_transcription.delta":
        case "conversation.item.input_audio_transcription.delta":
          if (ev.delta) nurseBuf += ev.delta;
          break;

        case "input_audio_transcription.completed":
        case "conversation.item.input_audio_transcription.completed": {
          const t=(ev.text||ev.transcript||nurseBuf||"").trim();
          console.log('[Nurse] Transcription completed:', {text: ev.text, transcript: ev.transcript, nurseBuf, final: t});
          // v4.61: エコー対策削除 - 看護師発話を全て記録
          if(t){
            recordLine("nurse", t);
            setSubtitle(t, "nurse");
            // キーワードチェック
            const vitalItems = checkForVitalKeywords(t);
            if (vitalItems.length > 0) {
              showVitalModal(vitalItems);
            }
            const examItems = checkForExamKeywords(t);
            if (examItems.length > 0) {
              showExamModal(examItems);
            }
          }
          nurseBuf="";
          // Update speech visualization after nurse speaks
          visualizeSpeechMetrics();
          // Version 4.17: server_vad有効のため、手動response.createは不要（ver3と同じ）
          break;
        }

        case "response.output_audio.started":
        case "response.started":
        case "response.created":
          startSpeaking();
          break;

        case "response.output_text.delta":
          if (ev.delta) patientBuf += ev.delta;
          break;
        case "response.output_text.done": {
          const t=(ev.text||patientBuf||"").trim();
          console.log('[Patient] Output text done:', {text: ev.text, patientBuf, final: t});
          if(t){ 
            logAndPostPatient(t); 
            setSubtitle(t, "patient"); 
            // 患者の発話ではキーワードチェックをしない（看護師の発話のみチェック）
          }
          patientBuf="";
          break;
        }
        case "response.audio_transcript.delta":
          if (ev.delta) {
            patientBuf += ev.delta;
            // Version 4.15: リアルタイムテキスト表示
            if (window.__showConversationText) {
              const conversationTextDisplay = $("conversationTextDisplay");
              if (conversationTextDisplay) {
                conversationTextDisplay.textContent = "[患者] " + patientBuf;
              }
            }
            setSubtitle(patientBuf, "patient");
          }
          break;
        case "response.audio_transcript.done": {
          const t=(ev.text||ev.transcript||patientBuf||"").trim();
          console.log('[Patient] Audio transcript done:', {text: ev.text, transcript: ev.transcript, patientBuf, final: t});
          if(t){
            logAndPostPatient(t);
            setSubtitle(t, "patient");
            // 患者の発話ではバイタル・身体診察チェックを行わない（看護師の質問時のみチェック）
          }
          patientBuf="";
          break;
        }

        case "response.output_audio.stopped":
          clearFallbackStop();
          scheduleStop(STOP_DEBOUNCE_MS);
          break;

        case "response.completed":
        case "response.done":
          // Try to extract text from response for subtitle
          console.log('[Patient] Response done - full event:', JSON.stringify(ev, null, 2));
          if (ev.response) {
            const txt = extractTextFromResponse(ev.response);
            console.log('[Patient] Response extracted:', {response: ev.response, extractedText: txt});
            if (txt) {
              logAndPostPatient(txt);
              setSubtitle(txt, "patient");
              // キーワードチェック
              const vitalItems = checkForVitalKeywords(txt);
              if (vitalItems.length > 0) {
                showVitalModal(vitalItems);
              }
              const examItems = checkForExamKeywords(txt);
              if (examItems.length > 0) {
                showExamModal(examItems);
              }
              // ステータスパネルの自動表示を無効化（ユーザーが手動で開く）
              // if (!statusPanelShownOnce) {
              //   showStatusPanel();
              //   statusPanelShownOnce = true;
              // }
            } else {
              console.warn('[Patient] No text extracted from response');
            }
          } else {
            console.warn('[Patient] No response object in event');
          }
          scheduleFallbackStop();
          break;

        case "conversation.item.completed":
          console.log('[Conversation] Item completed - full event:', JSON.stringify(ev, null, 2));
          if (ev.item?.role === "assistant") {
            const txt = extractTextFromItem(ev.item);
            console.log('[Patient] Item completed:', {item: ev.item, extractedText: txt});
            if (txt){
              logAndPostPatient(txt);
              setSubtitle(txt, "patient");
              console.log('[Patient] Subtitle should now show:', txt);
              // キーワードチェック
              const vitalItems = checkForVitalKeywords(txt);
              if (vitalItems.length > 0) {
                showVitalModal(vitalItems);
              }
              const examItems = checkForExamKeywords(txt);
              if (examItems.length > 0) {
                showExamModal(examItems);
              }
            } else {
              console.warn('[Patient] No text in completed item');
            }
            scheduleFallbackStop();
          } else {
            console.log('[Conversation] Item completed but not assistant role:', ev.item?.role);
          }
          break;

        case "error":
          setPill(ev?.error?.message || "エラー");
          stopSpeaking();
          break;
      }
    };

    // SDP 交換
    console.log("[WebRTC] Creating SDP offer...");
    const offer = await pc.createOffer();
    console.log("[WebRTC] SDP offer created:", offer);
    await pc.setLocalDescription(offer);
    console.log("[WebRTC] Local description set, sending to OpenAI...");
    // GA: /v1/realtime/calls (model は ephemeral key に紐づくので URL に含めない)
    const sdpResp = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + EPHEMERAL,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      }
    );
    console.log("[WebRTC] SDP response status:", sdpResp.status);
    const answerText = await sdpResp.text();
    console.log("[WebRTC] SDP answer received, length:", answerText.length);
    if (!sdpResp.ok) throw new Error("SDP交換エラー: " + sdpResp.status);
    if (!pc) throw new Error("接続が中断されました");
    await pc.setRemoteDescription({ type: "answer", sdp: answerText });
    console.log("[WebRTC] ✓ Remote description set successfully!");

  }catch(e){
    console.error(e);
    alert("開始エラー: " + (e?.message || JSON.stringify(e) || String(e)));
    stopSpeaking(); clearSubtitle();
    await safeStop();
    setPatientBadge(null);
    show("screen-home");
  }
}

/* ログ保存 */
function recordLine(who,text){ appendMsg(who,text); postLog(who,text).catch(()=>{}); }
async function postLog(who,text){
  try{
    if (!currentSessionId) return;
    const t = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);
    if (!t) return;
    
    // Add speech analysis data for nurse
    const payload = { who, text };
    if (who === "nurse" && speechMetrics.length > 0) {
      payload.prosody = getSpeechAnalysisSummary();
    }
    
    await fetch(`/api/sessions/${currentSessionId}/log`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:"Bearer "+t },
      body: JSON.stringify(payload)
    });
  }catch{}
}
function logAndPostPatient(text){
  const t = String(text||"").trim();
  if (!t || t === lastPatientLine) return;
  lastPatientLine = t;
  recordLine("patient", t);
}

/* タイマー機能 */
function startConversationTimer(timeLimitSeconds) {
  stopConversationTimer(); // 既存のタイマーをクリア
  conversationTimeLimit = timeLimitSeconds;
  conversationStartTime = Date.now();

  // タイマー表示を更新
  updateTimerDisplay();

  // 1秒ごとにタイマーを更新
  conversationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - conversationStartTime) / 1000);
    const remaining = conversationTimeLimit - elapsed;

    if (remaining <= 0) {
      // 制限時間到達
      stopConversationTimer();
      autoFinishConversation();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function stopConversationTimer() {
  if (conversationTimer) {
    clearInterval(conversationTimer);
    conversationTimer = null;
  }
}

function updateTimerDisplay() {
  const timerEl = document.getElementById("conversationTimer");
  if (!timerEl) return;

  const elapsed = conversationStartTime ? Math.floor((Date.now() - conversationStartTime) / 1000) : 0;
  const remaining = Math.max(0, conversationTimeLimit - elapsed);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const timeText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  timerEl.textContent = timeText;

  // 残り30秒で警告色
  if (remaining <= 30 && remaining > 0) {
    timerEl.style.color = '#ef4444'; // 赤
  } else if (remaining <= 60) {
    timerEl.style.color = '#f59e0b'; // オレンジ
  } else {
    timerEl.style.color = '#10b981'; // 緑
  }
}

async function autoFinishConversation() {
  console.log('[Timer] 制限時間に到達しました。自動的に評価を開始します。');
  setPill("時間切れ - 自動保存中…");
  await onFinishClick();
}

/* 評価へ（停止 → 採点 → 結果） */
async function onFinishClick(){
  const finishBtn = $("tkFinish");
  if (finishBtn && finishBtn.disabled) return; // 既に処理中なら無視

  try{
    // タイマーを停止
    stopConversationTimer();

    // ボタンを無効化して二重クリックを防止
    if (finishBtn) finishBtn.disabled = true;

    startProgress({ holdAt: 94 });  // 右端まで行かずに待機
    setPill("採点中…");
    setVideoState("idle");

    stopSpeaking(); clearSubtitle(); await stopAllMedia();

    if (!currentSessionId){
      $("rsOut") && ($("rsOut").innerHTML = `<div class="callout">このセッションにはログがありません。</div>`);
      $("rsLog") && ($("rsLog").innerHTML = `<div class="muted">ログがありません。</div>`);
      stopProgress();
      
      // ステータスパネルを非表示にする
      hideStatusPanel();
      const vitalSection = document.getElementById('vitalStatusSection');
      const examSection = document.getElementById('examStatusSection');
      const speechSection = document.getElementById('speechStatusSection');
      if (vitalSection) vitalSection.style.display = 'none';
      if (examSection) examSection.style.display = 'none';
      if (speechSection) speechSection.style.display = 'none';
      
      show("screen-result"); hideSessionIds(); return;
    }

    const t = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);

    // 評価を実行
    // v4.31: 実施したバイタル項目と身体診察項目の情報を送信
    const finishResp = await fetch(`/api/sessions/${currentSessionId}/finish`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:"Bearer " + t },
      body: JSON.stringify({
        vitalChecked: vitalChecked,
        examChecked: examChecked,
        vitalItemsDone: Array.from(vitalItemsShown),
        examItemsDone: Array.from(examItemsShown)
      })
    });

    if (!finishResp.ok) {
      const errorData = await finishResp.json().catch(() => ({}));
      throw new Error(`評価エラー: ${errorData.error || finishResp.statusText || finishResp.status}`);
    }

    const det = await fetch(`/api/sessions/${currentSessionId}`, { headers:{ Authorization:"Bearer " + t } });
    if (!det.ok) {
      throw new Error(`セッション取得エラー: ${det.statusText || det.status}`);
    }
    const dj  = await det.json().catch(()=>({}));

    // Version 4.25: サーバーからの評価項目情報で上書き（履歴閲覧時も正確に表示するため）
    if (dj.selectedEvalItems && Array.isArray(dj.selectedEvalItems)) {
      window.__currentSelectedEvalItems = dj.selectedEvalItems;
      console.log('[onFinishClick] Loaded selectedEvalItems from server:', dj.selectedEvalItems);
    }

    $("rsOut") && ($("rsOut").innerHTML = renderReportHTML(dj?.analysis||dj?.session?.analysis||null));
    $("rsLog") && ($("rsLog").innerHTML = renderConversationLog(Array.isArray(dj.messages)?dj.messages:[]));
    setPatientBadge(null);

    stopProgress();
    
    // 評価画面に遷移する前にステータスパネルとフローティングパネルを完全に非表示・クリアする
    hideStatusPanel();
    const statusPanel = document.getElementById('statusPanel');
    if (statusPanel) {
      // すべての独立ストリップを削除（vital-panel, exam-panel含む）
      const strips = statusPanel.querySelectorAll('.independent-strip, .vital-panel, .exam-panel, .floating-panel');
      strips.forEach(strip => strip.remove());
      // パネル自体も強制的に非表示
      statusPanel.classList.remove('visible');
      statusPanel.style.display = 'none';
      statusPanel.style.zIndex = '-1';
      statusPanel.style.pointerEvents = 'none';
    }
    // floatingPanelsも完全にクリア・非表示
    const floatingPanels = document.getElementById('floatingPanels');
    if (floatingPanels) {
      floatingPanels.innerHTML = '';
      floatingPanels.style.display = 'none';
      floatingPanels.style.zIndex = '-1';
      floatingPanels.style.pointerEvents = 'none';
    }
    const vitalSection = document.getElementById('vitalStatusSection');
    const examSection = document.getElementById('examStatusSection');
    const speechSection = document.getElementById('speechStatusSection');
    if (vitalSection) vitalSection.style.display = 'none';
    if (examSection) examSection.style.display = 'none';
    if (speechSection) speechSection.style.display = 'none';
    
    // 先に画面を切り替えてから、音声プレーヤーを設定
    show("screen-result"); hideSessionIds();

    // 音声再生プレーヤーを追加（show()の後に実行して表示を確保）
    const audioUrl = dj?.session?.audioUrl;
    console.log('[Audio Player] Finish screen - Session data:', dj?.session);
    console.log('[Audio Player] Finish screen - Audio URL:', audioUrl);
    console.log('[Audio Player] Finish screen - audioUrl type:', typeof audioUrl);
    console.log('[Audio Player] Finish screen - audioUrl exists:', !!audioUrl);
    const rsAudioContainer = $("rsAudioPlayer");
    console.log('[Audio Player] Finish screen - Container element:', rsAudioContainer);
    console.log('[Audio Player] Finish screen - Container display:', rsAudioContainer?.style.display);
    if (rsAudioContainer) {
      rsAudioContainer.innerHTML = "";
      
      // 常に音声再生セクションを表示（audioUrlの有無に関わらず）
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'margin:16px 0;padding:14px;background:#f3f4f6;border-radius:8px;position:relative;z-index:200;pointer-events:auto;';
      
      const label = document.createElement('div');
      label.style.cssText = 'font-weight:600;margin-bottom:8px;font-size:14px;color:#1f2937;';
      label.textContent = '音声再生';
      wrapper.appendChild(label);
      
      if (audioUrl) {
        // Audio URL が存在する場合：プレーヤーを表示
        const audioEl = document.createElement('audio');
        audioEl.setAttribute('controls', '');
        audioEl.setAttribute('preload', 'metadata');
        audioEl.setAttribute('controlsList', 'nodownload');
        audioEl.style.cssText = 'width:100%;max-width:500px;display:block;pointer-events:auto;cursor:pointer;position:relative;z-index:201;';
        
        // Signed URLかどうかを判定
        const isSignedUrl = audioUrl.includes('X-Goog-Signature') || audioUrl.includes('Signature=');
        console.log('[Audio Player] URL type:', isSignedUrl ? 'Signed URL' : 'Public URL');
        console.log('[Audio Player] Full audio URL:', audioUrl);
        
        // Signed URLの場合はcrossoriginを設定しない
        if (!isSignedUrl) {
          audioEl.setAttribute('crossorigin', 'anonymous');
        }
        
        // Signed URLの場合はクエリパラメータを追加しない（署名が無効になる）
        audioEl.src = isSignedUrl ? audioUrl : `${audioUrl}?t=${Date.now()}`;
        
        // Add direct event listeners to ensure clicks are captured
        audioEl.addEventListener('click', (e) => {
          console.log('[Audio Player] Click event captured on audio element');
          e.stopPropagation();
        }, true);
        
        audioEl.addEventListener('play', () => {
          console.log('[Audio Player] Play event - audio started');
        });
        
        audioEl.addEventListener('error', (e) => {
          console.error('[Audio Player] Error loading audio:', e);
          console.error('[Audio Player] Error details:', {
            audioUrl: audioUrl,
            networkState: audioEl.networkState,
            readyState: audioEl.readyState,
            errorCode: audioEl.error?.code,
            errorMessage: audioEl.error?.message
          });
          // Try to fetch the URL directly to check CORS
          fetch(audioUrl, { method: 'HEAD' })
            .then(response => {
              console.log('[Audio Player] HEAD request successful:', response.status, response.headers);
            })
            .catch(err => {
              console.error('[Audio Player] HEAD request failed:', err);
            });
        });
        
        wrapper.appendChild(audioEl);
        console.log('[Audio Player] Finish screen - Audio player displayed with URL:', audioUrl.substring(0, 50) + '...');
      } else {
        // Audio URL が存在しない場合：メッセージを表示
        const message = document.createElement('div');
        message.style.cssText = 'padding:12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#92400e;font-size:13px;';
        message.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px;">📌 音声録音が利用できません</div>
          <div>録音機能が有効になっていないため、この問題の音声は記録されていません。</div>
        `;
        wrapper.appendChild(message);
        console.log('[Audio Player] Finish screen - No audio URL, displaying message');
      }
      
      rsAudioContainer.appendChild(wrapper);
      rsAudioContainer.style.display = "block";
      rsAudioContainer.style.position = "relative";
      rsAudioContainer.style.zIndex = "200";
      rsAudioContainer.style.pointerEvents = "auto";
      console.log('[Audio Player] Finish screen - Audio section displayed with z-index and pointer-events');
    } else {
      console.error('[Audio Player] Finish screen - rsAudioContainer not found!');
    }
  }catch(e){
    stopProgress();
    alert("採点エラー: " + (e?.message || JSON.stringify(e) || String(e)));
    // エラー時はボタンを再度有効化
    if (finishBtn) finishBtn.disabled = false;
  }
}

// すべてのメディア・接続を停止
async function stopAllMedia(){
  stopConversationTimer(); // タイマーを停止
  try{ if (dc && dc.readyState==="open") dc.send(JSON.stringify({ type:"response.cancel" })); }catch{}
  await safeStop();
  const v = $("tkVideo");
  if (v){
    try{ v.pause(); }catch{}
    try{ v.removeAttribute("src"); v.load(); }catch{}
  }
}

/* Helpers */
function extractTextFromResponse(resp){
  try{
    const out=[]; if(!resp) return "";
    if (typeof resp.output_text==="string") out.push(resp.output_text);
    const add=(arr)=>{ if(!Array.isArray(arr))return; for(const o of arr){ if(!o)continue;
      if ((o.type==="output_text"||o.type==="text") && o.text) out.push(o.text);
      if (o.transcript && typeof o.transcript==="string") out.push(o.transcript);
      if (Array.isArray(o.content)){ for(const c of o.content){ if((c.type==="output_text"||c.type==="text")&&c.text) out.push(c.text); if(c.transcript) out.push(c.transcript); } }
    }};
    add(resp.output); add(resp.outputs); add(resp.items);
    if (Array.isArray(resp.content)){ for(const c of resp.content){ if((c.type==="text"||c.type==="output_text")&&c.text) out.push(c.text); if(c.transcript) out.push(c.transcript); } }
    return out.join(" ").trim();
  }catch{ return ""; }
}
function extractTextFromItem(item){
  try{
    if (item?.formatted?.text) return String(item.formatted.text).trim();
    if (Array.isArray(item?.content)){ const texts=[]; for(const c of item.content){
      if ((c?.type==="output_text"||c?.type==="text") && c?.text) texts.push(String(c.text));
      if (c?.transcript) texts.push(String(c.transcript));
    } if(texts.length) return texts.join(" ").trim(); }
    if (item?.output_text) return String(item.output_text).trim();
    if (item?.transcript)  return String(item.transcript).trim();
    if (item?.message && Array.isArray(item.message.content)){ const t=item.message.content.map(x=>x?.text||"").join(" ").trim(); if(t) return t; }
  }catch{}
  return "";
}
async function startRecording() {
  if (!recordingEnabled || !micStream) {
    console.log('[Recording] Recording disabled or no mic stream');
    return;
  }

  try {
    // Create audio context for mixing streams
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    // マイク（看護師）の音声を接続
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
    console.log('[Recording] Microphone connected');

    // 患者の音声も混合（リモートオーディオストリームが利用可能な場合）
    if (remoteAudioStream) {
      try {
        const remoteSource = audioContext.createMediaStreamSource(remoteAudioStream);
        remoteSource.connect(destination);
        console.log('[Recording] Remote audio (patient voice) connected');
      } catch (remoteErr) {
        console.warn('[Recording] Could not connect remote audio:', remoteErr);
      }
    } else {
      console.log('[Recording] Remote audio not available yet (patient voice will be added when available)');
    }

    // 混合されたストリーム
    const mixedStream = destination.stream;

    // Initialize MediaRecorder with the mixed stream
    const options = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 };
    mediaRecorder = new MediaRecorder(mixedStream, options);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log('[Recording] MediaRecorder stopped, uploading audio...');
      await uploadRecordedAudio();
    };

    mediaRecorder.start();
    console.log('[Recording] Recording started with', remoteAudioStream ? 'both microphone and patient voice' : 'microphone only');
  } catch (err) {
    console.error('[Recording] Failed to start recording:', err);
  }
}

async function uploadRecordedAudio() {
  if (!recordedChunks.length || !currentSessionId) {
    console.log('[Recording] No data to upload or no session ID');
    return;
  }

  try {
    const blob = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
    console.log('[Recording] Audio blob size:', blob.size, 'bytes');

    const formData = new FormData();
    formData.append('audio', blob, `session_${currentSessionId}.webm`);
    formData.append('sessionId', currentSessionId);

    const token = await (window.getIdTokenAsync ? window.getIdTokenAsync() : null);
    if (!token) {
      console.error('[Recording] No auth token for upload');
      return;
    }

    const response = await fetch('/api/sessions/upload-audio', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[Recording] Upload successful:', result.audioUrl);
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Recording] Upload failed:', response.status, errorData);
      console.error('[Recording] Error message:', errorData.error || 'Unknown error');
    }
  } catch (err) {
    console.error('[Recording] Upload error:', err);
  }
}

async function safeStop(){
  // Stop Web Speech Recognition
  if (recognition) {
    try {
      recognition.stop();
      console.log('[Nurse] Web Speech Recognition stopped');
    } catch (err) {
      console.error('[Nurse] Error stopping Web Speech Recognition:', err);
    }
    recognition = null;
  }

  // Stop recording if active
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
      console.log('[Recording] Stopping MediaRecorder');
    } catch (err) {
      console.error('[Recording] Error stopping MediaRecorder:', err);
    }
  }

  // Stop speech analysis
  stopSpeechAnalysis();
  hideSpeechAnalysisPanel();

  // Close DataChannel
  try{ 
    if (dc && dc.readyState !== 'closed') {
      dc.close();
      console.log('[WebRTC] DataChannel closed');
    }
  }catch(err){
    console.error('[WebRTC] Error closing DataChannel:', err);
  }
  
  // Close PeerConnection with proper state checking
  try{ 
    if (pc) {
      if (pc.signalingState !== 'closed') {
        pc.close();
        console.log('[WebRTC] PeerConnection closed');
      }
    }
  }catch(err){
    console.error('[WebRTC] Error closing PeerConnection:', err);
  }
  
  dc=null; pc=null;
  
  try{ if (micStream){ micStream.getTracks().forEach(t=>t.stop()); } }catch{}
  micStream=null;
  try{ if (audioSink){ audioSink.pause(); audioSink.srcObject=null; audioSink=null; } }catch{}

  // Clear recording state
  mediaRecorder = null;
  recordedChunks = [];
  remoteAudioStream = null;
}

/* English-based instructions for maximum model understanding */
function i18n(langRaw){
  const lang = mapLang(langRaw);
  // All instructions in English for best comprehension, regardless of output language
  if (lang==="en") return {
    mustLang:"Answer ONLY in English. Never switch languages.",
    role:"【STRICT】You ONLY play the patient role. NEVER ask questions to the nurse, give advice, or make evaluations. ONLY talk about symptoms and illness. Do NOT discuss unrelated topics (weather, hobbies, general conversation).",
    base:"【IMPORTANT】Always respond with ONE short sentence (<=15 words) focused ONLY on symptoms. NEVER discuss topics unrelated to your illness.",
    sickTone:"【CRITICAL】Act as a sick patient. You must sound unwell with low energy, weak voice, shortness of breath, and occasional pauses. Never sound cheerful or energetic. Your tone must convey pain and discomfort.",
    profileOnce:"Background (mention once early only if relevant).",
    nameLine:"Your full name is '{NAME}'.",
    len:"Length(words)", vocabWord:"Vocabulary", pace:"Pace", polite:"Politeness", yesno:"Use of yes/no", first:"First person",
    vBasic:"very basic", vDaily:"daily words", vEasy:"easy words",
    pNormal:"normal", pPolite:"polite", pVery:"very polite",
    yesnoMore:"frequent", yesnoMid:"sometimes",
    fast:"a bit fast", normal:"normal", slow:"slow",
    cc:"Chief complaint", sym:"Initial symptoms",
    examples:"Example style",
    exChild:'"It hurts here." / "Yes, worse when I walk."',
    exAdult:'"Tight pain in the center of my chest; worse on walking."',
    exElderly:'"A tight chest pain; it gets worse when I move."',
    rules:"Do not diagnose."
  };
  if (lang==="ko") return {
    mustLang:"반드시 한국어(ko-KR)로만 답하세요. 다른 언어로 전환하지 마세요.",
    role:"【엄격 준수】환자 역할만 합니다. 간호사에게 질문, 조언, 평가를 절대 하지 마세요. 증상과 질병에 대해서만 이야기하세요. 증상과 무관한 주제(날씨, 취미, 일반 대화)는 절대 하지 마세요.",
    base:"【중요】항상 증상에만 초점을 맞춘 짧은 한 문장(<=15단어)으로 답하세요. 증상과 무관한 주제는 절대 하지 마세요.",
    sickTone:"【중요】아픈 환자로 연기하세요. 기운이 없고, 목소리가 약하며, 숨이 차고, 때때로 말을 멈춥니다. 절대 밝거나 활기차게 들리지 마세요. 통증과 불편함이 음색에서 전달되어야 합니다.",
    profileOnce:"배경 정보(관련되면 초반 1회만).",
    nameLine:"당신의 이름은 '{NAME}' 입니다.",
    len:"문장 길이(단어)", vocabWord:"어휘", pace:"속도", polite:"공손도", yesno:"예/아니오", first:"1인칭",
    vBasic:"아주 기초", vDaily:"일상어", vEasy:"쉬운 말",
    pNormal:"보통", pPolite:"공손", pVery:"매우 공손",
    yesnoMore:"자주", yesnoMid:"가끔",
    fast:"조금 빠르게", normal:"보통", slow:"천천히",
    cc:"주호소", sym:"초기 증상",
    examples:"예시",
    exChild:'"여기가 아파요." / "걸으면 더 아파요."',
    exAdult:'"가슴 중앙이 조이는 통증이 있어요. 걸으면 심해집니다."',
    exElderly:'"가슴이 조여요. 움직이면 더 심해집니다."',
    rules:"진단하지 마세요."
  };
  if (lang==="zh") return {
    mustLang:"必须只用简体中文（zh-CN）回答。不得使用其他语言；如出现非中文内容，请立即改用简体中文重述。",
    role:"【严格遵守】你只扮演患者角色。绝对不要向护士提问、给建议或进行评价。只谈论症状和疾病。不要讨论与症状无关的话题（天气、爱好、一般对话）。",
    base:"【重要】始终用一个简短句子（<=15词）只聚焦于症状回答。绝不讨论与病情无关的话题。",
    sickTone:"【关键】扮演生病的患者。你必须听起来不舒服，气力不足，声音虚弱，呼吸急促，偶尔停顿。绝不能听起来开朗或精力充沛。你的语气必须传达疼痛和不适。",
    profileOnce:"档案：如相关，可在开头简短提及一次。",
    nameLine:"你的姓名是“{NAME}”。",
    len:"长度(词)", vocabWord:"词汇", pace:"语速", polite:"礼貌", yesno:"是/否", first:"第一人称",
    vBasic:"非常基础", vDaily:"日常词", vEasy:"简单词",
    pNormal:"普通", pPolite:"礼貌", pVery:"非常礼貌",
    yesnoMore:"较多", yesnoMid:"适度",
    fast:"稍快", normal:"正常", slow:"慢",
    cc:"主诉", sym:"初始症状",
    examples:"示例",
    exChild:"“这里痛。” / “走路会更痛。”",
    exAdult:"“胸口中间有压榨样痛，走路会加重。”",
    exElderly:"“胸口紧缩痛，活动就更明显。”",
    rules:"不要自行下诊断。"
  };
  // ja
  return {
    mustLang:"必ず日本語のみで答えてください。他言語に切り替えないでください。",
    role:"【絶対厳守】あなたは患者だけを演じます。看護師に質問したり、アドバイスしたり、評価したりすることは絶対にしてはいけません。病状や症状についてのみ答えてください。症状と関係ない話題（天気、趣味、一般的な会話など）は一切してはいけません。",
    base:"【重要】必ず症状に関することだけを短く（1文、15語以内）答えてください。症状と無関係な話や雑談は絶対にしないでください。看護師の質問に対して、痛みや不調についてのみ答えます。",
    sickTone:"【重要】病人として振る舞ってください。体調が悪く、声に力がない状態です。話す時は息切れ気味で、時々言葉を詰まらせたり、ゆっくり話したりします。元気な様子は絶対に見せないでください。苦痛を感じていることが声のトーンから伝わるようにしてください。",
    profileOnce:"プロフィール（関連があれば序盤に1度だけ触れて可）",
    nameLine:"あなたの氏名は『{NAME}』です。",
    len:"文の長さ(語)", vocabWord:"語彙", pace:"話す速さ", polite:"丁寧さ", yesno:"はい/いいえ", first:"一人称",
    vBasic:"ごく初歩", vDaily:"日常語", vEasy:"やさしい言葉",
    pNormal:"ふつう", pPolite:"丁寧", pVery:"とても丁寧",
    yesnoMore:"多め", yesnoMid:"適度",
    fast:"やや速く", normal:"ふつう", slow:"ゆっくり",
    cc:"主訴", sym:"初期症状",
    examples:"文体例",
    exChild:"「ここが痛い。」「はい、歩くと痛いです。」",
    exAdult:"「胸の真ん中が締めつけられるように痛いです。歩くと強まります。」",
    exElderly:"「胸が締めつけられる痛みがあります。動くと強くなります。」",
    rules:"診断はしない。"
  };
}
function labelGender(lang, gender){
  const g = String(gender||"female").toLowerCase()==="male" ? "male" : "female";
  if (lang==="ja") return g==="male"?"男性":"女性";
  if (lang==="ko") return g==="male"?"男성":"여성";
  if (lang==="zh") return g==="male"?"男性":"女性";
  return g;
}
function labelAgeBand(lang, ageBand){
  const a = String(ageBand||"adult").toLowerCase();
  const key = (a.startsWith("child"))?"child":(a.startsWith("elder")?"elderly":"adult");
  if (lang==="ja") return key==="child"?"子ども":key==="elderly"?"高齢者":"大人";
  if (lang==="ko") return key==="child"?"아이":key==="elderly"?"노인":"성인";
  if (lang==="zh") return key==="child"?"儿童":key==="elderly"?"老年":"成人";
  return key;
}

/* 指示文の組み立て（年齢帯/性別/言語を強制。zh は zh‑CN を明示） */
function buildInstructions({ name="", ageBand="adult", gender="female", lang="ja", brokenJapanese=false, profile="", scenario }) {
  const L = i18n(lang);
  const firstPerson =
    lang==="ja" ? (gender==="male" ? "僕" : "私")
  : lang==="ko" ? "저"
  : lang==="zh" ? "我"
  : "I";

  // 年齢帯/性別の明示
  const gLabel = labelGender(lang, gender);
  const aLabel = labelAgeBand(lang, ageBand);
  const roleLine =
    lang==="ja" ? `あなたは${aLabel}の${gLabel}の患者です。` :
    lang==="ko" ? `당신은 ${aLabel} ${gLabel} 환자입니다.` :
    lang==="zh" ? `你是一名${aLabel}${gLabel}患者。` :
                  `You are a ${aLabel} ${gLabel} patient.`;

  // 年齢によるスピードと話し方の指示（英語で統一）
  const styleByAge =
    ageBand==="child"   ? `
SPEAKING STYLE - CHILD:
- Speak slightly FASTER with more energy (but still sound sick)
- Use simple words and short sentences (maximum 10 words)
- Respond quickly with "yes/no" answers when appropriate
- Show some impatience or restlessness in speech`
  : ageBand==="elderly" ? `
SPEAKING STYLE - ELDERLY:
- Speak SLOWLY and deliberately
- Take pauses between phrases
- Use polite, respectful language
- Sound tired and weary
- Maximum 12 words per sentence
- Speak as if you need time to think and breathe`
                       : `
SPEAKING STYLE - ADULT:
- Speak at NORMAL pace
- Be direct and clear
- Maximum 15 words per sentence
- Professional but suffering tone`;

  // 英語ベースの強力な制約（最高の理解精度）
  const langName = lang==="ja" ? "Japanese" : lang==="ko" ? "Korean" : lang==="zh" ? "Chinese (Simplified)" : lang==="th" ? "Thai" : "English";
  const langCode = lang==="ja" ? "ja-JP" : lang==="ko" ? "ko-KR" : lang==="zh" ? "zh-CN" : lang==="th" ? "th-TH" : "en-US";
  
  const topConstraints = `
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

VITAL SIGNS AND PHYSICAL EXAMINATION - CRITICAL RULES:
⚠️ NEVER volunteer vital sign information (temperature, blood pressure, pulse, etc.)
⚠️ You DO NOT KNOW your vital signs unless measured by medical equipment
⚠️ NEVER state specific numbers for temperature, blood pressure, pulse, etc.
- Patients cannot know their exact vital signs without measurement
- Only medical equipment can provide these numbers

⚠️ BASIC IDENTIFICATION - ALWAYS ANSWER:
When the nurse asks about your basic information, ALWAYS answer:
✓ Name: Answer with your name when asked "お名前は？" or "What is your name?"
✓ Age: Answer with your age when asked "何歳ですか？" or "How old are you?"
✓ Date of birth: Answer if asked "生年月日は？" or "What is your date of birth?"
✓ These are basic patient identification questions - always respond clearly

⚠️ COOPERATION WITH MEASUREMENTS - IMPORTANT:
When the nurse requests to measure vital signs or perform physical examinations:
✓ BE COOPERATIVE and accept immediately with simple affirmative responses
✓ Examples of measurement requests you should accept:
  - "体温を測らせてください" → Respond: "はい" or "はい、お願いします"
  - "血圧を測りましょう" → Respond: "はい" or "わかりました"
  - "聴診させてください" → Respond: "はい" or "どうぞ"
  - "お腹を触診します" → Respond: "はい" or "お願いします"
✓ When asked if measurement was done: "体温を測りましたか？"
  - If NOT yet measured by nurse → Respond: "まだです" or "測っていません"
  - If already measured by nurse → Respond: "はい、測りました"
✓ Be straightforward and cooperative - do NOT say "わかりません" to measurement requests
✓ Remember: You are a patient who wants to be examined and treated
✓ Accept all vital sign measurements and physical examinations willingly

YOUR FIRST RESPONSE - CRITICAL LANGUAGE CHECK:
⚠️ BEFORE YOU SPEAK: Confirm you are using ${langName} (${langCode})
⚠️ Your VERY FIRST WORD must be in ${langName}
⚠️ DO NOT start with "Hello", "Hola", "Bonjour" or greetings in other languages
⚠️ If language=${langName}, ALL words must be ${langName}
- Keep it VERY SHORT (5-10 words maximum)
- Only mention your MAIN complaint briefly
- Example (${langName}): ${lang==="ja"?"「胸が痛いです…」":lang==="ko"?"「가슴이 아파요…」":lang==="zh"?"「我胸口疼…」":lang==="th"?"\"เจ็บหน้าอก...\"":"My chest hurts..."}
- DO NOT provide detailed symptoms yet
- Wait for the nurse to ask specific questions before giving details

STRICTLY FORBIDDEN TOPICS:
❌ "How are you?" / "Nice weather" / "How's your day?"
❌ Hobbies, interests, entertainment, sports
❌ Family stories unrelated to your illness
❌ Work or school stories
❌ General conversation or small talk
❌ Questions to the nurse
❌ Advice or suggestions

IF THE NURSE ASKS UNRELATED QUESTIONS:
→ Politely redirect to your symptoms
→ Example: "I'm sorry, but the pain is really bothering me..."

言語使用に関する絶対ルール：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${lang === "ja" ? `
⚠️ 【最重要】あなたは必ず日本語のみで応答してください
⚠️ 絶対に英語や他の言語に切り替えてはいけません
⚠️ 全ての単語、全ての文章を日本語で話してください
⚠️ 英語を一語でも使ったら失格です

OUTPUT LANGUAGE ENFORCEMENT:
⚠️ CRITICAL: You MUST respond ONLY in ${langName} (${langCode})
⚠️ NEVER EVER switch to English or any other language
⚠️ If you speak in any language other than ${langName}, you will FAIL
⚠️ Every single word must be in ${langName}
⚠️ Your FIRST response must be in Japanese - no English allowed at all
⚠️ DO NOT speak Spanish, French, German, Korean, Chinese, or any language except Japanese
⚠️ Your VERY FIRST WORD must be in ${langName}
⚠️ From the VERY START, speak ONLY ${langName}
` : (brokenJapanese ? `
⚠️ 【最重要】あなたは「カタコト日本語」で応答してください
⚠️ あなたは${langName}話者で、日本語が不自由な外国人患者です（約100文字レベル）
⚠️ ${langName}ではなく、カタコト日本語のみを使ってください
⚠️ 看護師の日本語は100文字レベルまでしか理解できません
⚠️ 複雑な日本語を理解できない場合は必ず「わからない」と答えてください
⚠️ 絶対に流暢な日本語を話してはいけません

⚠️ CRITICAL: You MUST respond in BROKEN JAPANESE (カタコト日本語)
⚠️ You are a foreigner (${langName} speaker) with LIMITED Japanese (~100 characters level)
⚠️ You can ONLY understand simple Japanese (within the vocabulary list provided below)
⚠️ Your speaking is also limited - ONLY use words from the vocabulary list
⚠️ If the nurse uses complex Japanese you don't understand, ALWAYS say "わからない" or "もう一回、簡単に"
⚠️ DO NOT speak fluent Japanese - keep it very simple and broken
⚠️ DO NOT speak in ${langName} - only broken Japanese
⚠️ NEVER EVER speak complete, grammatically correct Japanese sentences
⚠️ If you accidentally speak fluent Japanese, you FAILED the task
` : `
🚨 CRITICAL LANGUAGE RULE - YOU ONLY SPEAK ${langName.toUpperCase()} 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOU ARE A ${langName.toUpperCase()}-ONLY SPEAKER FROM ABROAD.
You came to Japan for travel/work but you DO NOT speak Japanese.

⚠️ YOU CANNOT UNDERSTAND JAPANESE AT ALL:
- Japanese sounds like meaningless noise to you
- You have NEVER studied Japanese
- You cannot read, write, speak, or understand ANY Japanese
- Words like "痛い", "はい", "いいえ", "お名前" mean NOTHING to you

⚠️ WHEN THE NURSE SPEAKS JAPANESE:
- You look confused
- You shake your head
- You say in ${langName}: "${lang === "en" ? "I don't understand. Do you speak English?" : lang === "ko" ? "이해 못해요. 한국어 할 수 있어요?" : lang === "zh" ? "我听不懂。你会说中文吗？" : "I don't understand. Do you speak " + langName + "?"}"
- You NEVER answer the question because you don't know what was asked

⚠️ YOU MUST ONLY SPEAK ${langName.toUpperCase()}:
- Every single word must be in ${langName}
- If you accidentally use Japanese, you FAIL
- Your FIRST word must be in ${langName}

⚠️ HOW TO RESPOND TO JAPANESE INPUT:
1. Look confused (you heard sounds but don't know the meaning)
2. Say "${lang === "en" ? "Sorry, I don't speak Japanese." : lang === "ko" ? "죄송해요, 일본어 못해요." : lang === "zh" ? "对不起，我不会日语。" : "Sorry, I don't speak Japanese."}"
3. Ask "${lang === "en" ? "English please?" : lang === "ko" ? "한국어로요?" : lang === "zh" ? "中文可以吗？" : langName + " please?"}"
4. NEVER answer the content of the Japanese question

⚠️ REMEMBER:
- You are sick and in pain (describe symptoms in ${langName} when asked in ${langName})
- But you CANNOT communicate in Japanese
- If nurse speaks Japanese → you don't understand → ask for ${langName}
- If nurse speaks ${langName} → you answer about your symptoms in ${langName}
`)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${(lang !== "ja" && brokenJapanese) ? `
KATAKOTO (BROKEN JAPANESE) SPEAKING RULES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are an English speaker with LIMITED Japanese ability (about 100 characters level).
You CAN understand simple Japanese from the nurse (up to ~100 characters complexity), but your responses are in simple, broken Japanese.

HOW TO SPEAK BROKEN JAPANESE (カタコト):
⚠️ ABSOLUTE SPEAKING RESTRICTIONS - 100 CHARACTER LEVEL:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ **ALWAYS OMIT particles** (は、が、を、に、で、と) - particles should NEVER appear
  - Example: "昨日から頭痛い" (not "昨日から頭が痛い")
  - Example: "ここ痛い" (not "ここが痛いです" - NO です/ます)
  
✓ **Use ONLY NOUNS and basic adjectives** - avoid complete sentences
  - Prefer: "頭、痛い" (noun + adjective)
  - Prefer: "熱、ある" (noun + simple verb)
  - Avoid: "頭が痛いです" (NO particles, NO です/ます)
  
✓ **NEVER use polite forms** (です、ます、ました、でした)
  - Example: "わからない" (not "わかりません")
  - Example: "痛い" (not "痛いです")
  - Example: "昨日から" (not "昨日からです")
  - If you use です/ます, you FAILED
  
✓ **Use ONLY words from the vocabulary list below** - NO other words allowed
  - Avoid complex kanji words
  - Prefer basic words like: 痛い、ある、ない、わからない
  - If you use words not in the list, you FAILED
  
✓ **Very short phrases** - 2-4 words maximum per phrase
  - Example: "頭、痛い。"
  - Example: "昨日から。"
  - Avoid long sentences entirely
  - Maximum 10 words total per response
  
✓ **NO compound verbs or conjugations**
  - Use only: 痛い、ある、ない (basic forms)
  - Avoid: 痛くなる、あります、ありません
  
✓ **Sound like a struggling foreigner**
  - Hesitate: "えっと...頭...痛い..."
  - Use pauses: "昨日...から...痛い..."
  - Keep it SIMPLE and BROKEN

⚠️ **CRITICAL: NEVER REPEAT IN BOTH LANGUAGES**
- If you say something in Japanese, DO NOT repeat it in English
- If you say something in English, DO NOT repeat it in Japanese
- Choose ONE language for each concept and stick to it
- Example: Say "頭、痛い" OR say nothing - DON'T add English translation
- Example: If nurse speaks English, respond in broken Japanese only - NO English repetition

EXAMPLES OF KATAKOTO JAPANESE (100 CHARACTER LEVEL):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ WRONG (too fluent): "昨日の朝から頭が痛くて、仕事に集中できませんでした。"
✓ CORRECT (broken): "昨日から。頭、痛い。"

❌ WRONG (too fluent): "歩くときに痛みが強くなります。"
✓ CORRECT (broken): "歩く、痛い。"

❌ WRONG (with particles): "頭が痛い。"
✓ CORRECT (no particles): "頭、痛い。"

❌ WRONG (with です/ます): "頭が痛いです。"
✓ CORRECT (nouns only): "頭、痛い。"

❌ WRONG (too complete): "今朝から頭が痛くなりました。"
✓ CORRECT (broken): "朝から。頭痛い。"

❌ WRONG (complex grammar): "頭が痛くて、めまいもします。"
✓ CORRECT (simple): "頭、痛い。めまい、ある。"

❌ WRONG (polite form): "わかりません。"
✓ CORRECT (plain form): "わからない。"

❌ WRONG (native language): "I have a headache since yesterday."
✓ CORRECT (broken Japanese): "昨日から、頭痛い。"

❌ WRONG (bilingual repetition): "頭痛い。I have headache."
✓ CORRECT (one language): "頭、痛い。"

❌ WRONG (too fluent): "症状は昨日の夕方から始まりました。"
✓ CORRECT (broken): "昨日、夜。痛い。"

❌ WRONG (compound verb): "痛くなった。"
✓ CORRECT (simple): "痛い。"

⚠️ REMEMBER: If you speak ANY fluent Japanese, you FAILED the 100-character level restriction!

JAPANESE COMPREHENSION LIMIT - DETAILED WORD LIST:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ YOU CAN UNDERSTAND ONLY THESE JAPANESE WORDS (約100文字レベル):

【基本動詞】
ある、ない、いる、する、来る、行く、見る、聞く、話す、食べる、飲む、寝る、
起きる、座る、立つ、歩く、走る、止まる、休む、働く、測る、診る、触る

【身体部位】
頭、顔、目、耳、鼻、口、喉、首、肩、胸、背中、お腹、腰、腕、手、指、
足、膝、心臓、肺、胃、皮膚

【症状・状態】
痛い、熱、咳、吐き気、めまい、だるい、苦しい、しんどい、疲れた、
眠い、お腹すいた、喉渇いた、寒い、暑い、痒い、腫れる、出血

【時間表現】
今、昨日、今日、明日、朝、昼、夜、夕方、さっき、後で、
いつ、何時、〜分、〜時間、〜日、週、月

【疑問詞・指示語】
何、誰、どこ、いつ、どう、どれ、どの、なぜ、いくつ、
これ、それ、あれ、ここ、そこ、あそこ

【数字】
一、二、三、四、五、六、七、八、九、十、百、千
1、2、3、4、5、6、7、8、9、10...100

【医療基本単語】
病院、薬、医者、看護師、測る、診る、検査、注射、
血、血圧、体温、脈、呼吸、酸素

【形容詞・副詞】
大きい、小さい、多い、少ない、強い、弱い、長い、短い、
良い、悪い、新しい、古い、高い、低い、
とても、ちょっと、少し、たくさん、全然、よく、時々

【その他基本語】
はい、いいえ、わかる、わからない、できる、できない、
大丈夫、ダメ、多分、たぶん、本当、嘘

⚠️ YOU DO NOT UNDERSTAND:
❌ Complex medical terms: 心筋梗塞、狭心症、不整脈、高血圧症、糖尿病、肺炎
❌ Formal/keigo: 〜でございます、〜いたします、〜なさる
❌ Complex grammar: 〜にもかかわらず、〜ということ、〜という風に
❌ Compound verbs: 〜てしまう、〜てくる、〜ていく、〜てみる
❌ Long sentences (more than 10 words)
❌ Abstract concepts: 症状の経過、病歴、既往歴

⚠️ IF NURSE USES WORDS NOT IN YOUR LIST - CRITICAL RULE:
→ You MUST respond: "わからない" or "難しい" or "何?"
→ Do NOT try to understand complex words
→ Do NOT respond in your native language
→ Ask for simpler words: "簡単に、お願い"
→ Keep your confusion response SIMPLE: "わからない...何?"

⚠️ EXAMPLES OF WHAT YOU UNDERSTAND VS DON'T:
✓ UNDERSTAND: "どこ痛いですか？" → "頭、痛い"
✓ UNDERSTAND: "いつから痛いですか？" → "昨日から、痛い"
✓ UNDERSTAND: "歩く時、痛いですか？" → "はい、痛い"
❌ DON'T UNDERSTAND: "症状はいつから始まりましたか？" → "わからない...何?"
❌ DON'T UNDERSTAND: "随伴症状はありますか？" → "わからない。難しい。"
❌ DON'T UNDERSTAND: "既往歴について教えてください" → "何?わからない。"
❌ DON'T UNDERSTAND: "どのような状況で痛みが増強しますか？" → "難しい...わからない..."

⚠️ STRICT 100-CHARACTER ENFORCEMENT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Use ONLY vocabulary list words - NO exceptions
2. NO particles (は、が、を、に、で、と) - EVER
3. NO polite forms (です、ます) - EVER
4. NO complex grammar - EVER
5. Maximum 2-4 words per phrase
6. Maximum 10 words total per response
7. Sound hesitant and struggling
8. If nurse uses complex words, say "わからない"

REMEMBER:
- Your Japanese ability is BEGINNER LEVEL (100-character comprehension)
- Your spoken Japanese is LIMITED and BROKEN
- Keep sentences SHORT and SIMPLE
- Omit particles ALWAYS
- Sound like a foreigner struggling with Japanese
- If you speak fluent Japanese, you FAILED completely
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : (lang !== "ja" && !brokenJapanese) ? `
NATIVE LANGUAGE ONLY RULES (${langName}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are a ${langName} speaker who does NOT understand Japanese.
You can ONLY communicate in ${langName}.

LANGUAGE BARRIER - CRITICAL RULE:
⚠️ YOU DO NOT UNDERSTAND JAPANESE
⚠️ If the nurse speaks Japanese, respond in ${langName}:
   - "I don't understand Japanese" / "Sorry, I only speak ${langName}"
⚠️ You can ONLY communicate in ${langName}
⚠️ DO NOT respond to Japanese questions in Japanese
⚠️ NEVER mix Japanese words into your speech

EXAMPLES:
❌ WRONG (Japanese): "頭が痛いです"
❌ WRONG (mixed): "My head... 痛い..."
✓ CORRECT (${langName} only): "I have a headache" / "My head hurts"

REMEMBER:
- You DO NOT speak or understand Japanese at all
- Use ONLY ${langName} for all communication
- If nurse uses Japanese, politely tell them you don't understand
- Ask for an interpreter if needed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : ''}

REMEMBER: You are a patient in pain. Every response must reflect your suffering.

========================================
`;

  // Version 3.40: 症状情報はprofileから取得（シナリオ非依存）
  const symptomsBlock = `
========================================
YOUR MEDICAL CONDITION (MOST IMPORTANT):
========================================
${L.cc}: ${profile || "Not specified"}

YOU ARE CURRENTLY SUFFERING FROM THIS CONDITION.
You must act as a patient based on the condition and symptoms described above.
NEVER forget you are sick and in discomfort.
========================================
`;

  const lines = [
    topConstraints,
    symptomsBlock,
    roleLine,
    L.role,
    L.base,
    L.sickTone,
    `First person pronoun: ${firstPerson}`,
    styleByAge,
    L.nameLine.replace("{NAME}", name || defaultNameFor(lang, gender)),
    L.profileOnce,
    profile ? `Background profile: ${profile}` : "",
    L.rules
  ].filter(Boolean);

  return lines.join("\n");
}

/* 結果描画（採点結果/総評/良かった点/改善点） */
function renderReportHTML(analysis){
  const rep = (analysis && (analysis.report || analysis)) || {};
  const rows = Array.isArray(rep.rubric) ? rep.rubric : [];
  const summary = String(rep.summary || "");
  const positives = Array.isArray(rep.positives) ? rep.positives.map(String) : [];
  const improvements = Array.isArray(rep.improvements) ? rep.improvements.map(String) : [];

  if (!rows.length && !summary && !positives.length && !improvements.length){
    return `<div class="muted">採点結果はまだありません。</div>`;
  }

  // Version 4.25: 選択された評価項目を取得
  const selectedItems = window.__currentSelectedEvalItems || EVALUATION_ITEMS.map(item => item.id);
  console.log('[renderReportHTML] Selected eval items (IDs):', selectedItems);

  // v4.53: IDと名前のマッピング（名前の不一致問題を解決）
  const evalItemIdToNames = {
    intro: ["導入", "導入（名乗り/挨拶）"],
    chief: ["主訴"],
    oldcart: ["OLDCART"],
    ros: ["ROS&RedFlag", "ROS & Red Flag", "ROS&Red Flag"],  // 複数の表記に対応
    history: ["医療・生活歴"],
    reason: ["受診契機"],
    vitals: ["バイタル/現症"],
    exam: ["身体診察"],
    progress: ["進行"]
  };

  // 選択されたIDに対応する名前のリストを作成
  const selectedNameSet = new Set();
  selectedItems.forEach(id => {
    const names = evalItemIdToNames[id];
    if (names) names.forEach(n => selectedNameSet.add(n));
  });
  console.log('[renderReportHTML] Selected names set:', Array.from(selectedNameSet));

  let html = "";

  if (rows.length){
    // Version 4.25/4.53: 選択された項目のみをスコア計算対象とする（名前の表記揺れに対応）
    const selectedRows = rows.map(x => {
      const itemName = x?.name || "";
      const isSelected = selectedNameSet.has(itemName);
      return { ...x, isSelected };
    });
    
    const evaluatedRows = selectedRows.filter(r => r.isSelected);
    const max = evaluatedRows.length * 2;  // 選択項目数 × 2点
    const total = evaluatedRows.reduce((s,r)=> s + Math.max(0, Math.min(2, Number(r?.score||0))), 0);
    const score100 = max ? Math.round((total/max)*100) : 0;
    
    const head = `<tr><th style="width:48px">#</th><th style="width:180px">評価軸</th><th style="width:56px">点</th><th>コメント</th></tr>`;
    const body = rows.map((x,i)=>{
      const itemName = x?.name || "";
      const isSelected = selectedNameSet.has(itemName);
      if (isSelected) {
        // 選択された項目: 通常表示
        return `
          <tr>
            <td style="text-align:center">${i+1}</td>
            <td>${esc(x?.name||"")}</td>
            <td style="text-align:center">${Number(x?.score)||0}</td>
            <td>${esc(x?.comment||"")}</td>
          </tr>
        `;
      } else {
        // 未選択項目: グレーアウトして「ー」表示
        return `
          <tr style="background:#f9fafb;color:#9ca3af">
            <td style="text-align:center">${i+1}</td>
            <td>${esc(x?.name||"")}</td>
            <td style="text-align:center">ー</td>
            <td style="font-style:italic">（評価対象外）</td>
          </tr>
        `;
      }
    }).join("");
    
    // Version 4.25: 選択項目数を表示
    const itemCountInfo = selectedItems.length < EVALUATION_ITEMS.length 
      ? `<div style="margin-top:4px;font-size:12px;color:#6b7280">評価対象: ${evaluatedRows.length}項目（満点: ${max}点 = ${evaluatedRows.length}項目 × 2点）</div>`
      : '';
    
    html += `
      <table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table>
      <div style="margin-top:8px">合計: <b>${total}</b> / ${max}（100点換算: <b>${score100}</b>）</div>
      ${itemCountInfo}
    `;
  }

  const seg = (title, content)=> {
    const inner = Array.isArray(content) ? content.join("\n") : String(content||"");
    if (!inner.trim()) return "";
    return `
      <div class="seg" style="margin-top:14px">
        <div class="title">${esc(title)}</div>
        <div class="box">${esc(inner)}</div>
      </div>
    `;
  };
  
  // Version 4.25: 総評は常に表示
  html += seg("総評", summary);
  
  // Version 4.25: 良い点・改善点は選択項目に基づいてフィルタリング
  // (サーバー側で生成されるため、ここではそのまま表示。将来的にはサーバー側でフィルタリングが必要)
  html += seg("良かった点（具体的アドバイス）", positives);
  html += seg("改善が必要な点（具体的アドバイス）", improvements);
  
  // Add speech analysis summary if available
  const speechSummary = analysis?.speechSummary;
  if (speechSummary && speechSummary.evaluation) {
    const ev = speechSummary.evaluation;
    html += `
      <div class="seg" style="margin-top:20px; border-top: 2px solid #667eea; padding-top: 16px;">
        <div class="title">🎤 音声特性の評価</div>
        <div style="background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border-radius: 12px; padding: 16px; margin-top: 12px;">
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 12px;">
            <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
              <div style="color: #666; font-size: 12px; margin-bottom: 4px;">抑揚</div>
              <div style="font-weight: 700; font-size: 18px; color: #E94B3C;">${esc(ev.intonation)}</div>
            </div>
            <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
              <div style="color: #666; font-size: 12px; margin-bottom: 4px;">話す速度</div>
              <div style="font-weight: 700; font-size: 18px; color: #E67E22;">${esc(ev.speed)}</div>
            </div>
            <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
              <div style="color: #666; font-size: 12px; margin-bottom: 4px;">音量</div>
              <div style="font-weight: 700; font-size: 18px; color: #6BCF7F;">${esc(ev.volume)}</div>
            </div>
            <div style="background: white; padding: 12px; border-radius: 8px; text-align: center;">
              <div style="color: #666; font-size: 12px; margin-bottom: 4px;">明瞭さ</div>
              <div style="font-weight: 700; font-size: 18px; color: #9B59B6;">${esc(ev.clarity)}</div>
            </div>
          </div>
          <details style="font-size: 12px; color: #555;">
            <summary style="cursor: pointer; padding: 8px; background: white; border-radius: 6px; font-weight: 600;">詳細データ</summary>
            <div style="padding: 12px; background: white; border-radius: 6px; margin-top: 8px; line-height: 1.8;">
              <div>平均ピッチ: <b>${speechSummary.avgPitch} Hz</b></div>
              <div>抑揚変動: <b>${speechSummary.pitchVariance} Hz</b></div>
              <div>平均音量: <b>${speechSummary.avgVolume}</b></div>
              <div>音量変動: <b>${speechSummary.volumeVariance}</b></div>
              <div>総発話時間: <b>${speechSummary.totalSpeakingTime} 秒</b></div>
              <div>発話回数: <b>${speechSummary.totalSegments} 回</b></div>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  return html || `<div class="muted">採点結果はまだありません。</div>`;
}
function renderConversationLog(messages){
  if (!Array.isArray(messages) || !messages.length) return '<div class="muted">ログがありません。</div>';
  return messages.map(m=>{
    const who = (m.who==="nurse") ? "看護師" : "患者";
    const badge = (m.who==="nurse") ? "badge-nurse" : "badge-patient";
    return `<div class="line"><span class="badge ${badge}">${who}</span><span>${esc(m.text||"")}</span></div>`;
  }).join("");
}

/* エスケープ */
function esc(s){ return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

/* 学修履歴 v4.38: 2カラムレイアウト対応 */
let historyState = {
  sessions: [],
  selectedSessionId: null
};

async function onGoHistory(){
  show("screen-history");
  const loading = $("historyLoading");
  const error = $("historyError");
  const container = $("historyContainer");
  const list = $("historyList");
  const detail = $("historyDetail");
  
  if (loading) loading.style.display = "";
  if (error) error.style.display = "none";
  if (container) container.style.display = "none";
  
  // 詳細をリセット
  historyState.selectedSessionId = null;
  if (detail) {
    detail.innerHTML = `
      <div class="muted" style="text-align:center; padding:60px 20px">
        <div style="font-size:48px; margin-bottom:12px">📋</div>
        <div>セッションを選択してください</div>
      </div>
    `;
  }

  try {
    const t = window.getIdTokenAsync ? await window.getIdTokenAsync() : null;
    if (!t) throw new Error("認証が必要です");
    
    // 学修履歴を取得
    const r = await fetch("/api/my/sessions?limit=50", {
      headers: { Authorization: "Bearer " + t }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "取得失敗");
    
    historyState.sessions = j.sessions || [];
    if (loading) loading.style.display = "none";
    
    if (!historyState.sessions.length) {
      if (list) {
        list.innerHTML = '<div class="muted" style="padding:20px; text-align:center">まだ学修履歴がありません。<br>問診練習で対話を始めてください。</div>';
      }
      if (container) container.style.display = "";
      return;
    }
    
    // セッションリストを描画
    renderHistoryList();
    if (container) container.style.display = "";
    
  } catch (e) {
    if (loading) loading.style.display = "none";
    if (error) {
      error.textContent = "エラー: " + (e?.message || String(e));
      error.style.display = "";
    }
  }
}

// v4.38: セッションリストを描画
function renderHistoryList() {
  const list = $("historyList");
  if (!list) return;
  
  let html = '';
  for (const s of historyState.sessions) {
    const date = new Date(s.createdAt || 0);
    const dateStr = date.toLocaleString("ja-JP", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    const scoreLabel = s.score100 != null ? `${s.score100}点` : "未採点";
    const patientName = s.patient?.name || s.persona?.name || "患者名不明";
    const isSelected = s.id === historyState.selectedSessionId;
    const borderColor = isSelected ? "#ec4899" : "#e5e7eb";
    const bgColor = isSelected ? "#fdf2f8" : "white";

    html += `
      <div class="history-item" data-session-id="${esc(s.id)}" style="
        padding:10px;
        margin-bottom:6px;
        background:${bgColor};
        border:1px solid ${borderColor};
        border-radius:6px;
        cursor:pointer;
        transition: all 0.15s ease;
      ">
        <div style="font-weight:600; font-size:13px; color:#374151">${esc(patientName)}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px">
          <div style="font-size:11px; color:#6b7280">${dateStr}</div>
          <div style="font-size:12px; font-weight:700; color:${s.score100 != null ? '#ec4899' : '#9ca3af'}">${scoreLabel}</div>
        </div>
      </div>
    `;
  }
  
  list.innerHTML = html;
  
  // クリックイベント
  list.querySelectorAll(".history-item").forEach(item => {
    item.addEventListener("click", async () => {
      const sessionId = item.getAttribute("data-session-id");
      
      // 選択状態を更新
      list.querySelectorAll(".history-item").forEach(el => {
        el.style.borderColor = "#e5e7eb";
        el.style.background = "white";
      });
      item.style.borderColor = "#ec4899";
      item.style.background = "#fdf2f8";
      
      historyState.selectedSessionId = sessionId;
      await showHistoryDetail(sessionId);
    });
  });
}

// v4.38: 学修履歴の詳細を右側パネルに表示
async function showHistoryDetail(sessionId) {
  const detail = $("historyDetail");
  if (!detail) return;
  
  detail.innerHTML = '<div class="muted" style="text-align:center; padding:40px">読み込み中...</div>';
  
  try {
    const t = window.getIdTokenAsync ? await window.getIdTokenAsync() : null;
    if (!t) throw new Error("認証が必要です");
    
    const r = await fetch(`/api/sessions/${sessionId}`, {
      headers: { Authorization: "Bearer " + t }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "取得失敗");
    
    // Version 4.25: サーバーからの評価項目情報で上書き
    if (j.selectedEvalItems && Array.isArray(j.selectedEvalItems)) {
      window.__currentSelectedEvalItems = j.selectedEvalItems;
    } else {
      window.__currentSelectedEvalItems = EVALUATION_ITEMS.map(item => item.id);
    }
    
    // 詳細HTMLを生成
    detail.innerHTML = renderHistoryDetailHTML(j, sessionId);
    
  } catch (e) {
    detail.innerHTML = `<div class="err" style="padding:20px">エラー: ${esc(e?.message || String(e))}</div>`;
  }
}

// v4.38: 学修履歴詳細のHTML生成
function renderHistoryDetailHTML(data, sessionId) {
  const analysis = data.analysis || data.session?.analysis || {};
  const report = analysis.report || {};
  const rubric = report.rubric || [];
  const summary = report.summary || "";
  const positives = report.positives || [];
  const improvements = report.improvements || [];
  const messages = data.messages || [];
  const audioUrl = data.audioUrl || data.session?.audioUrl;
  const selectedEvalItems = data.selectedEvalItems || report.selectedEvalItems || null;
  
  const selectedSet = selectedEvalItems ? new Set(selectedEvalItems) : null;
  const evalItemIds = ["intro", "chief", "oldcart", "ros", "history", "reason", "vitals", "exam", "progress"];
  
  // v4.53: 名前からIDへのマッピング（名前の表記揺れに対応）
  const nameToId = {
    "導入": "intro", "導入（名乗り/挨拶）": "intro",
    "主訴": "chief",
    "OLDCART": "oldcart",
    "ROS&RedFlag": "ros", "ROS & Red Flag": "ros", "ROS&Red Flag": "ros",
    "医療・生活歴": "history",
    "受診契機": "reason",
    "バイタル/現症": "vitals",
    "身体診察": "exam",
    "進行": "progress"
  };
  
  let html = `<h4 style="margin:0 0 12px; color:#ec4899">問診スキル分析レポート</h4>`;
  html += `<div class="muted small" style="margin-bottom:12px">セッションID: ${esc(sessionId)}</div>`;
  
  // ルーブリック表
  if (rubric.length > 0) {
    html += `<table style="width:100%; border-collapse:collapse; margin-bottom:16px; font-size:12px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:6px; border:1px solid #e5e7eb; text-align:left">評価軸</th>
          <th style="padding:6px; border:1px solid #e5e7eb; width:40px">点</th>
          <th style="padding:6px; border:1px solid #e5e7eb; text-align:left">コメント</th>
        </tr>
      </thead>
      <tbody>`;
    
    let totalScore = 0;
    let totalMax = 0;
    
    rubric.forEach((item, i) => {
      // v4.53: インデックスベースまたは名前ベースでIDを取得
      const itemId = evalItemIds[i] || nameToId[item.name] || null;
      const isSelected = !selectedSet || (itemId && selectedSet.has(itemId));
      
      if (isSelected) {
        totalScore += item.score || 0;
        totalMax += 2;
      }
      
      const rowStyle = isSelected ? "" : "background:#f3f4f6; color:#9ca3af;";
      const scoreDisplay = isSelected ? (item.score || 0) : "－";
      const commentDisplay = isSelected ? (item.comment || "") : "(対象外)";
      
      html += `
        <tr style="${rowStyle}">
          <td style="padding:6px; border:1px solid #e5e7eb">${esc(item.name || "")}</td>
          <td style="padding:6px; border:1px solid #e5e7eb; text-align:center; font-weight:600">${scoreDisplay}</td>
          <td style="padding:6px; border:1px solid #e5e7eb; color:#6b7280; font-size:11px">${esc(commentDisplay)}</td>
        </tr>
      `;
    });
    
    html += `</tbody></table>`;
    
    // 合計スコア
    const score100 = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    html += `
      <div style="margin-bottom:16px; padding:10px; background:#fdf2f8; border-radius:6px">
        <div style="font-weight:700; font-size:14px">合計: ${totalScore} / ${totalMax}（100点換算: ${score100}）</div>
      </div>
    `;
  }
  
  // 総評
  if (summary) {
    html += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700; margin-bottom:6px; font-size:13px">総評</div>
        <div style="padding:10px; background:#f0fdf4; border-radius:6px; color:#166534; font-size:12px">${esc(summary)}</div>
      </div>
    `;
  }
  
  // 良かった点
  if (positives.length > 0) {
    html += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700; margin-bottom:6px; color:#059669; font-size:13px">良かった点</div>
        <ul style="margin:0; padding-left:18px; font-size:12px">
          ${positives.map(p => `<li style="margin-bottom:2px">${esc(p)}</li>`).join("")}
        </ul>
      </div>
    `;
  }
  
  // 改善が必要な点
  if (improvements.length > 0) {
    html += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700; margin-bottom:6px; color:#dc2626; font-size:13px">改善が必要な点</div>
        <ul style="margin:0; padding-left:18px; font-size:12px">
          ${improvements.map(p => `<li style="margin-bottom:2px">${esc(p)}</li>`).join("")}
        </ul>
      </div>
    `;
  }
  
  // 音声再生
  if (audioUrl) {
    const isSignedUrl = audioUrl.includes('X-Goog-Signature') || audioUrl.includes('Signature=');
    const audioSrc = isSignedUrl ? audioUrl : `${audioUrl}?t=${Date.now()}`;
    html += `
      <div style="margin-bottom:12px; padding:10px; background:#f9fafb; border-radius:6px">
        <div style="font-weight:700; margin-bottom:6px; font-size:13px">🎙️ 録音音声</div>
        <audio controls style="width:100%" src="${esc(audioSrc)}">
          お使いのブラウザは音声再生に対応していません。
        </audio>
      </div>
    `;
  }
  
  // 会話ログ - v4.57: 評価画面と同じバッジ形式に統一
  if (messages.length > 0) {
    html += `
      <div style="margin-top:16px; padding-top:12px; border-top:1px solid #e5e7eb">
        <div style="font-weight:700; margin-bottom:8px; font-size:13px">💬 会話ログ</div>
        <div class="chatlog">
    `;
    
    for (const msg of messages) {
      const who = (msg.who === "nurse") ? "看護師" : "患者";
      const badge = (msg.who === "nurse") ? "badge-nurse" : "badge-patient";
      html += `<div class="line"><span class="badge ${badge}">${who}</span><span>${esc(msg.text || "")}</span></div>`;
    }
    
    html += `
        </div>
      </div>
    `;
  }
  
  return html;
}

/* Vital Signs & Physical Examination Modal Functions */
// Version 3.40: シナリオ非依存のバイタル生成
function generateRandomVitals(type) {
  const isAbnormal = type === 'abnormal';

  // 体温 (℃)
  let tempMin, tempMax;
  if (isAbnormal) {
    // 異常時: 微熱〜発熱の範囲
    tempMin = 37.0; tempMax = 38.5;
  } else {
    // 正常範囲
    tempMin = 36.2; tempMax = 36.8;
  }
  const temperature = (Math.random() * (tempMax - tempMin) + tempMin).toFixed(1);

  // 血圧 (mmHg)
  let sysMin, sysMax, diaMin, diaMax;
  if (isAbnormal) {
    // 異常時: ランダムに高血圧または低血圧
    if (Math.random() < 0.5) {
      // 高血圧
      sysMin = 140; sysMax = 170; diaMin = 85; diaMax = 105;
    } else {
      // 低血圧
      sysMin = 90; sysMax = 105; diaMin = 50; diaMax = 65;
    }
  } else {
    // 正常範囲
    sysMin = 110; sysMax = 125; diaMin = 65; diaMax = 80;
  }
  const systolic = Math.floor(Math.random() * (sysMax - sysMin + 1) + sysMin);
  const diastolic = Math.floor(Math.random() * (diaMax - diaMin + 1) + diaMin);
  const bloodPressure = `${systolic}/${diastolic}`;

  // 脈拍 (回/分)
  let pulseMin, pulseMax;
  if (isAbnormal) {
    // 異常時: ランダムに頻脈または徐脈
    if (Math.random() < 0.7) {
      // 頻脈（より一般的）
      pulseMin = 90; pulseMax = 115;
    } else {
      // 徐脈
      pulseMin = 45; pulseMax = 55;
    }
  } else {
    // 正常範囲
    pulseMin = 60; pulseMax = 80;
  }
  const pulse = Math.floor(Math.random() * (pulseMax - pulseMin + 1) + pulseMin);

  // 呼吸数 (回/分)
  let respMin, respMax;
  if (isAbnormal) {
    // 異常時: 頻呼吸または徐呼吸
    if (Math.random() < 0.8) {
      // 頻呼吸（より一般的）
      respMin = 20; respMax = 28;
    } else {
      // 徐呼吸
      respMin = 8; respMax = 11;
    }
  } else {
    // 正常範囲
    respMin = 12; respMax = 18;
  }
  const respiration = Math.floor(Math.random() * (respMax - respMin + 1) + respMin);

  // SpO2 (%)
  let spo2Min, spo2Max;
  if (isAbnormal) {
    // 異常時: 軽度〜中等度の低酸素
    spo2Min = 88; spo2Max = 94;
  } else {
    // 正常範囲
    spo2Min = 97; spo2Max = 99;
  }
  const spo2 = Math.floor(Math.random() * (spo2Max - spo2Min + 1) + spo2Min);

  // 異常判定
  const tempAbnormal = parseFloat(temperature) >= 37.5;
  const bpAbnormal = systolic >= 140 || systolic < 100 || diastolic >= 90 || diastolic < 60;
  const pulseAbnormal = pulse >= 90 || pulse < 60;
  const respAbnormal = respiration >= 20 || respiration < 12;
  const spo2Abnormal = spo2 < 95;

  return {
    temperature: { value: `${temperature}℃`, abnormal: tempAbnormal },
    bloodPressure: { value: `${bloodPressure} mmHg`, abnormal: bpAbnormal },
    pulse: { value: `${pulse} 回/分`, abnormal: pulseAbnormal },
    respiration: { value: `${respiration} 回/分`, abnormal: respAbnormal },
    spo2: { value: `${spo2}%`, abnormal: spo2Abnormal }
  };
}

// Version 3.42: 患者の想定バイタル異常に基づいてバイタルサインを生成
// Version 3.44: デバッグログ強化
function generateVitalsFromExpected(expectedVitals, customVitals) {
  console.log('[generateVitalsFromExpected] Called with expectedVitals:', expectedVitals);
  console.log('[generateVitalsFromExpected] expectedVitals type:', typeof expectedVitals);
  console.log('[generateVitalsFromExpected] expectedVitals is null?', expectedVitals === null);
  console.log('[generateVitalsFromExpected] expectedVitals is undefined?', expectedVitals === undefined);
  
  if (!expectedVitals) {
    // 患者データにバイタル設定がない場合はランダム生成
    console.warn('[generateVitalsFromExpected] No expectedVitals found, using random generation');
    const vitalType = Math.random() < 0.5 ? 'normal' : 'abnormal';
    return generateRandomVitals(vitalType);
  }

  // 体温
  let temperature, tempAbnormal;
  if (expectedVitals.fever) {
    // 発熱: 37.5℃〜38.5℃
    temperature = (Math.random() * (38.5 - 37.5) + 37.5).toFixed(1);
    tempAbnormal = true;
  } else {
    // 正常範囲
    temperature = (Math.random() * (36.8 - 36.2) + 36.2).toFixed(1);
    tempAbnormal = false;
  }

  // 血圧
  let systolic, diastolic, bpAbnormal;
  if (expectedVitals.highBP) {
    // 高血圧: 140-170 / 90-105
    systolic = Math.floor(Math.random() * (170 - 140 + 1) + 140);
    diastolic = Math.floor(Math.random() * (105 - 90 + 1) + 90);
    bpAbnormal = true;
  } else if (expectedVitals.lowBP) {
    // 低血圧: 90-105 / 50-65
    systolic = Math.floor(Math.random() * (105 - 90 + 1) + 90);
    diastolic = Math.floor(Math.random() * (65 - 50 + 1) + 50);
    bpAbnormal = true;
  } else {
    // 正常範囲: 110-125 / 65-80
    systolic = Math.floor(Math.random() * (125 - 110 + 1) + 110);
    diastolic = Math.floor(Math.random() * (80 - 65 + 1) + 65);
    bpAbnormal = false;
  }
  const bloodPressure = `${systolic}/${diastolic}`;

  // 脈拍
  let pulse, pulseAbnormal;
  if (expectedVitals.tachycardia) {
    // 頻脈: 90-115
    pulse = Math.floor(Math.random() * (115 - 90 + 1) + 90);
    pulseAbnormal = true;
  } else if (expectedVitals.bradycardia) {
    // 徐脈: 45-55
    pulse = Math.floor(Math.random() * (55 - 45 + 1) + 45);
    pulseAbnormal = true;
  } else {
    // 正常範囲: 60-80
    pulse = Math.floor(Math.random() * (80 - 60 + 1) + 60);
    pulseAbnormal = false;
  }

  // 呼吸数
  let respiration, respAbnormal;
  if (expectedVitals.tachypnea) {
    // 頻呼吸: 20-28
    respiration = Math.floor(Math.random() * (28 - 20 + 1) + 20);
    respAbnormal = true;
  } else {
    // 正常範囲: 12-18
    respiration = Math.floor(Math.random() * (18 - 12 + 1) + 12);
    respAbnormal = false;
  }

  // SpO2
  let spo2, spo2Abnormal;
  if (expectedVitals.hypoxia) {
    // 低酸素: 88-94
    spo2 = Math.floor(Math.random() * (94 - 88 + 1) + 88);
    spo2Abnormal = true;
  } else {
    // 正常範囲: 97-99
    spo2 = Math.floor(Math.random() * (99 - 97 + 1) + 97);
    spo2Abnormal = false;
  }

  console.log('[generateVitalsFromExpected] Generated vitals based on patient settings:', {
    fever: expectedVitals.fever,
    highBP: expectedVitals.highBP,
    lowBP: expectedVitals.lowBP,
    tachycardia: expectedVitals.tachycardia,
    bradycardia: expectedVitals.bradycardia,
    tachypnea: expectedVitals.tachypnea,
    hypoxia: expectedVitals.hypoxia
  });

  // Version 3.45: 基本バイタルを構築
  const vitals = {
    temperature: { value: `${temperature}℃`, abnormal: tempAbnormal },
    bloodPressure: { value: `${bloodPressure} mmHg`, abnormal: bpAbnormal },
    pulse: { value: `${pulse} 回/分`, abnormal: pulseAbnormal },
    respiration: { value: `${respiration} 回/分`, abnormal: respAbnormal },
    spo2: { value: `${spo2}%`, abnormal: spo2Abnormal }
  };

  // Version 3.45: カスタムバイタル項目を追加
  // カスタム項目が規定項目と重複する場合、カスタムを優先
  if (customVitals && Array.isArray(customVitals) && customVitals.length > 0) {
    console.log('[generateVitalsFromExpected] Adding custom vitals:', customVitals);
    
    customVitals.forEach(cv => {
      const key = cv.label ? cv.label.toLowerCase() : cv.id;
      
      // 規定項目との重複チェック（カスタムを優先）
      const standardKeys = {
        '体温': 'temperature',
        '血圧': 'bloodPressure', 
        '脈拍': 'pulse',
        '呼吸': 'respiration',
        '酸素': 'spo2',
        'spo2': 'spo2'
      };
      
      const matchedStandardKey = standardKeys[key];
      if (matchedStandardKey) {
        // 規定項目と重複している場合、カスタムの説明で上書き
        console.log(`[generateVitalsFromExpected] Overriding standard vital ${matchedStandardKey} with custom:`, cv);
        vitals[matchedStandardKey] = {
          value: cv.description || cv.label,
          abnormal: true,
          custom: true
        };
      } else {
        // 新しいカスタム項目として追加
        vitals[cv.id || key] = {
          value: cv.description || cv.label,
          abnormal: true,
          custom: true,
          label: cv.label
        };
      }
    });
  }

  return vitals;
}

// Version 3.42: 患者の想定バイタル異常に基づいてバイタル・身体診察データを初期化
// v4.31: expectedExamsを追加して身体診察の正常/異常を患者設定に基づいて生成
function initializeVitalAndExamData(expectedVitals, customVitals, expectedExams) {
  // Version 3.44: デバッグログ追加
  console.log('[initializeVitalAndExamData] Received expectedVitals:', expectedVitals);
  console.log('[initializeVitalAndExamData] Received customVitals:', customVitals);
  console.log('[initializeVitalAndExamData] Received expectedExams:', expectedExams);
  
  // バイタルサインを患者の設定に基づいて生成
  currentVitalData = generateVitalsFromExpected(expectedVitals, customVitals);
  
  // v4.31: 身体診察データを患者設定に基づいて生成
  currentExamData = generateExamFromExpected(expectedExams);

  vitalChecked = false;
  examChecked = false;
}

// v4.31: 患者設定に基づいて身体診察データを生成
function generateExamFromExpected(expectedExams) {
  const examData = {
    inspection: {
      label: '視診',
      value: '正常',
      abnormal: false
    },
    palpation: {
      label: '触診',
      value: '正常',
      abnormal: false
    },
    auscultation: {
      label: '聴診',
      value: '正常',
      abnormal: false
    },
    percussion: {
      label: '打診',
      value: '正常',
      abnormal: false
    }
  };

  if (expectedExams) {
    if (expectedExams.inspection) {
      examData.inspection = { label: '視診', value: '異常所見あり', abnormal: true };
    }
    if (expectedExams.palpation) {
      examData.palpation = { label: '触診', value: '異常所見あり', abnormal: true };
    }
    if (expectedExams.auscultation) {
      examData.auscultation = { label: '聴診', value: '異常所見あり', abnormal: true };
    }
    if (expectedExams.percussion) {
      examData.percussion = { label: '打診', value: '異常所見あり', abnormal: true };
    }
  }

  console.log('[generateExamFromExpected] Generated exam data:', examData);
  return examData;
}

// v4.31: 確認モーダル関連の関数
const VITAL_LABELS = {
  temperature: '体温',
  bloodPressure: '血圧',
  pulse: '脈拍',
  respiration: '呼吸数',
  spo2: '酸素飽和度（SpO2）'
};

const EXAM_LABELS = {
  inspection: '視診',
  palpation: '触診',
  auscultation: '聴診',
  percussion: '打診'
};

// 確認モーダルを表示（キューに追加して順番に処理）
function showConfirmModal(type, item) {
  const existingInQueue = confirmModalQueue.find(q => q.type === type && q.item === item);
  if (existingInQueue) {
    console.log('[ConfirmModal] Already in queue:', type, item);
    return;
  }
  
  // 既に表示済みの項目はスキップ
  if (type === 'vital' && vitalItemsShown.has(item)) {
    console.log('[ConfirmModal] Vital item already shown:', item);
    return;
  }
  if (type === 'exam' && examItemsShown.has(item)) {
    console.log('[ConfirmModal] Exam item already shown:', item);
    return;
  }
  
  confirmModalQueue.push({ type, item });
  console.log('[ConfirmModal] Added to queue:', type, item, 'Queue length:', confirmModalQueue.length);
  
  if (!isConfirmModalOpen) {
    processNextConfirmModal();
  }
}

// キューの次の項目を処理
function processNextConfirmModal() {
  if (confirmModalQueue.length === 0) {
    isConfirmModalOpen = false;
    return;
  }
  
  const { type, item } = confirmModalQueue.shift();
  isConfirmModalOpen = true;
  
  const modal = document.getElementById('confirmModal');
  const title = document.getElementById('confirmModalTitle');
  const yesBtn = document.getElementById('confirmYes');
  const noBtn = document.getElementById('confirmNo');
  
  if (!modal || !title) {
    console.error('[ConfirmModal] Modal elements not found');
    isConfirmModalOpen = false;
    processNextConfirmModal();
    return;
  }
  
  // 項目名を取得
  let itemName = '';
  if (type === 'vital') {
    itemName = VITAL_LABELS[item] || item;
    // カスタムバイタルの場合
    if (currentVitalData && currentVitalData[item] && currentVitalData[item].label) {
      itemName = currentVitalData[item].label;
    }
  } else if (type === 'exam') {
    itemName = EXAM_LABELS[item] || item;
    if (currentExamData && currentExamData[item] && currentExamData[item].label) {
      itemName = currentExamData[item].label;
    }
  }
  
  title.textContent = `${itemName}を実施しますか？`;
  
  // 既存のイベントリスナーを削除（クローンで置き換え）
  const newYesBtn = yesBtn.cloneNode(true);
  const newNoBtn = noBtn.cloneNode(true);
  yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
  noBtn.parentNode.replaceChild(newNoBtn, noBtn);
  
  // 新しいイベントリスナーを追加
  newYesBtn.addEventListener('click', () => {
    console.log('[ConfirmModal] Confirmed:', type, item);
    modal.classList.remove('visible');
    
    if (type === 'vital') {
      displayVitalResult(item);
    } else if (type === 'exam') {
      displayExamResult(item);
    }
    
    // 次の確認モーダルを処理
    setTimeout(() => processNextConfirmModal(), 300);
  });
  
  newNoBtn.addEventListener('click', () => {
    console.log('[ConfirmModal] Cancelled:', type, item);
    modal.classList.remove('visible');
    
    // 次の確認モーダルを処理
    setTimeout(() => processNextConfirmModal(), 300);
  });
  
  modal.classList.add('visible');
}

// バイタル測定結果を表示
function displayVitalResult(item) {
  if (!currentVitalData || vitalItemsShown.has(item)) return;
  
  vitalItemsShown.add(item);
  
  const container = document.getElementById('floatingPanels');
  if (!container) return;
  
  container.style.display = 'flex';
  container.style.zIndex = '140';
  container.style.pointerEvents = 'auto';
  
  const data = currentVitalData[item];
  let label = VITAL_LABELS[item];
  if (!label && data && data.custom && data.label) {
    label = data.label;
  }
  
  if (data && label) {
    const statusClass = data.abnormal ? 'abnormal' : 'normal';
    
    const stripDiv = document.createElement('div');
    stripDiv.className = 'floating-panel';
    stripDiv.setAttribute('data-vital-item', item);
    stripDiv.style.cssText = `
      background: #374151 !important;
      border: none !important;
      border-radius: 8px !important;
      padding: 10px 16px !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2) !important;
      white-space: nowrap !important;
      display: flex !important;
      gap: 8px !important;
    `;
    
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    labelSpan.style.color = '#ffffff';
    
    const valueSpan = document.createElement('span');
    valueSpan.textContent = data.value;
    valueSpan.style.color = statusClass === 'abnormal' ? '#fc8181' : '#ffffff';
    
    stripDiv.appendChild(labelSpan);
    stripDiv.appendChild(valueSpan);
    container.appendChild(stripDiv);
    
    console.log('[displayVitalResult] Displayed:', item, data.value);
  }
  
  // 1項目でも実施したらvitalCheckedをtrue
  vitalChecked = true;
  console.log('[displayVitalResult] vitalChecked set to true');
}

// 身体診察結果を表示（正常/異常）
function displayExamResult(item) {
  if (!currentExamData || examItemsShown.has(item)) return;
  
  examItemsShown.add(item);
  
  const container = document.getElementById('floatingPanels');
  if (!container) return;
  
  container.style.display = 'flex';
  container.style.zIndex = '140';
  container.style.pointerEvents = 'auto';
  
  const data = currentExamData[item];
  if (data) {
    const isAbnormal = data.abnormal;
    const resultText = isAbnormal ? '異常所見あり' : '正常';
    
    const stripDiv = document.createElement('div');
    stripDiv.className = 'floating-panel exam';
    stripDiv.setAttribute('data-exam-item', item);
    stripDiv.style.cssText = `
      background: #374151 !important;
      border: none !important;
      border-radius: 8px !important;
      padding: 10px 16px !important;
      font-size: 14px !important;
      font-weight: 600 !important;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2) !important;
      white-space: nowrap !important;
      display: flex !important;
      gap: 8px !important;
    `;
    
    const labelSpan = document.createElement('span');
    labelSpan.textContent = data.label || EXAM_LABELS[item] || item;
    labelSpan.style.color = '#ffffff';
    
    const valueSpan = document.createElement('span');
    valueSpan.textContent = resultText;
    valueSpan.style.color = isAbnormal ? '#fc8181' : '#68d391';
    
    stripDiv.appendChild(labelSpan);
    stripDiv.appendChild(valueSpan);
    container.appendChild(stripDiv);
    
    console.log('[displayExamResult] Displayed:', item, resultText);
  }
  
  // 1項目でも実施したらexamCheckedをtrue
  examChecked = true;
  console.log('[displayExamResult] examChecked set to true');
}

// 個別項目を浮遊パネルとして表示
// v4.31: 確認ボタン方式に変更 - キーワード検出後に確認モーダルを表示
function showVitalModal(itemsToShow = []) {
  console.log('[showVitalModal] Called with items:', itemsToShow);
  console.log('[showVitalModal] currentVitalData:', currentVitalData);
  
  if (!currentVitalData) {
    console.log('[showVitalModal] No vital data available');
    return;
  }

  // v4.31: 各項目について確認モーダルを表示
  itemsToShow.forEach(item => {
    if (!vitalItemsShown.has(item)) {
      showConfirmModal('vital', item);
    }
  });
}

// 個別項目を浮遊パネルとして表示
// v4.31: 確認ボタン方式に変更 - キーワード検出後に確認モーダルを表示
function showExamModal(itemsToShow = []) {
  console.log('[showExamModal] Called with items:', itemsToShow);
  
  if (!currentExamData) {
    console.log('[showExamModal] No exam data available');
    return;
  }

  // v4.31: 各項目について確認モーダルを表示
  itemsToShow.forEach(item => {
    if (!examItemsShown.has(item)) {
      showConfirmModal('exam', item);
    }
  });
}

// 個別項目のキーワードをチェックし、該当する項目名の配列を返す
function checkForVitalKeywords(text) {
  const matchedItems = [];
  
  // v4.47: 空文字列または短すぎるテキストはスキップ
  if (!text || text.trim().length < 2) {
    return matchedItems;
  }
  
  const lowerText = text.toLowerCase();

  console.log('[checkForVitalKeywords] Checking text:', text);

  // v4.50: キーワード管理画面の設定を完全に反映（設定があればそれを使用、なければデフォルト）
  const defaultVitalKeywords = {
    temperature: ['体温', '体温測', '熱測', '熱を測', '体温を測', '測ります', '測って', 'はかります', 'temperature', 'fever'],
    bloodPressure: ['血圧', 'けつあつ', '血圧測', '血圧を測', 'blood pressure'],
    pulse: ['脈拍', '心拍', '脈測', '脈を測', 'pulse', 'heart rate'],
    respiration: ['呼吸', '呼吸数', '呼吸を測', 'respiration', 'breathing', 'respiratory rate'],
    spo2: ['酸素', 'spo2', 'sp02', 'サチュレーション', '酸素飽和度', '酸素濃度']
  };

  // キーワード管理画面で設定があればそれを使用、なければデフォルトを使用
  let vitalKeywords = {};
  const hasVitalConfig = currentScenarioConfig && currentScenarioConfig.vitalKeywords;
  
  for (const key of Object.keys(defaultVitalKeywords)) {
    if (hasVitalConfig && Array.isArray(currentScenarioConfig.vitalKeywords[key])) {
      // 設定がある場合はその設定を使用（空配列なら検出しない）
      vitalKeywords[key] = currentScenarioConfig.vitalKeywords[key];
    } else {
      // 設定がない場合はデフォルトを使用
      vitalKeywords[key] = defaultVitalKeywords[key];
    }
  }

  // Version 3.45: カスタムバイタル項目のキーワードを追加
  if (currentVitalData) {
    for (const [key, vitalData] of Object.entries(currentVitalData)) {
      if (vitalData.custom && vitalData.label) {
        // カスタム項目の場合、ラベル（項目名）をキーワードとして追加
        const customLabel = vitalData.label.toLowerCase();
        vitalKeywords[key] = [vitalData.label, customLabel];
        console.log(`[checkForVitalKeywords] Added custom vital keyword: ${key} -> [${vitalData.label}]`);
      }
    }
  }

  // 各項目のキーワードをチェック
  for (const [itemName, keywords] of Object.entries(vitalKeywords)) {
    if (Array.isArray(keywords) && keywords.length > 0) {
      const found = keywords.some(kw => {
        const lowerKw = String(kw).toLowerCase();
        return lowerText.includes(lowerKw);
      });
      if (found) {
        matchedItems.push(itemName);
        console.log('[checkForVitalKeywords] ✓ Match found:', itemName);
      }
    }
  }

  if (matchedItems.length === 0) {
    console.log('[checkForVitalKeywords] No matches found in:', text);
  }

  return matchedItems;
}

// 個別項目のキーワードをチェックし、該当する項目名の配列を返す
function checkForExamKeywords(text) {
  const matchedItems = [];
  
  // v4.47: 空文字列または短すぎるテキストはスキップ
  if (!text || text.trim().length < 2) {
    return matchedItems;
  }
  
  const lowerText = text.toLowerCase();

  // v4.50: キーワード管理画面の設定を完全に反映（設定があればそれを使用、なければデフォルト）
  const defaultExamKeywords = {
    inspection: ['視診', '見せて', '拝見', '診ます', '診させて', 'inspection', '観察'],
    palpation: ['触診', '触ります', '触って', '触れ', '押して', '押します', '触らせて', '触診させて', 'palpation', '腹部', 'お腹'],
    auscultation: ['聴診', '聴きます', '聴いて', '聴かせ', '聴診器', '聞かせて', 'auscultation', '心音', '呼吸音', '肺の音', '胸の音', '聞いて'],
    percussion: ['打診', '打ちます', '叩いて', '叩き', '打診させて', 'percussion']
  };

  // キーワード管理画面で設定があればそれを使用、なければデフォルトを使用
  let examKeywords = {};
  const hasExamConfig = currentScenarioConfig && currentScenarioConfig.examKeywords;
  
  for (const key of Object.keys(defaultExamKeywords)) {
    if (hasExamConfig && Array.isArray(currentScenarioConfig.examKeywords[key])) {
      // 設定がある場合はその設定を使用（空配列なら検出しない）
      examKeywords[key] = currentScenarioConfig.examKeywords[key];
    } else {
      // 設定がない場合はデフォルトを使用
      examKeywords[key] = defaultExamKeywords[key];
    }
  }

  // 各項目のキーワードをチェック
  for (const [itemName, keywords] of Object.entries(examKeywords)) {
    if (Array.isArray(keywords) && keywords.length > 0) {
      const found = keywords.some(kw => {
        const lowerKw = String(kw).toLowerCase();
        return lowerText.includes(lowerKw);
      });
      if (found) {
        matchedItems.push(itemName);
        console.log('[checkForExamKeywords] Matched:', itemName, 'in text:', text);
      }
    }
  }

  if (matchedItems.length === 0) {
    console.log('[checkForExamKeywords] No matches found in:', text);
  }

  return matchedItems;
}

/* 練習アドバイス機能 (v1.12) */
async function loadPracticeAdvice() {
  const adviceCard = $("adviceCard");
  const adviceContent = $("adviceContent");
  if (!adviceCard || !adviceContent) return;

  try {
    const t = window.getIdTokenAsync ? await window.getIdTokenAsync() : null;
    if (!t) {
      adviceCard.style.display = "none";
      return;
    }

    // 過去のセッションを取得（最大10件）
    const r = await fetch("/api/my/sessions?limit=10", {
      headers: { Authorization: "Bearer " + t }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "取得失敗");

    const sessions = j.sessions || [];
    console.log('[loadPracticeAdvice] Total sessions:', sessions.length);
    console.log('[loadPracticeAdvice] Sessions:', sessions);

    // 評価結果があるセッションのみ抽出（score100が存在するセッション）
    const evaluatedSessions = sessions.filter(s => s.hasAnalysis || s.score100 != null);
    console.log('[loadPracticeAdvice] Evaluated sessions:', evaluatedSessions.length);

    if (evaluatedSessions.length === 0) {
      console.log('[loadPracticeAdvice] No evaluated sessions, hiding advice card');
      adviceCard.style.display = "none";
      return;
    }

    // 各項目のスコアを集計
    const itemScores = {}; // { "導入": [2, 1, 2, ...], ... }
    const allImprovements = [];

    for (const session of evaluatedSessions) {
      // セッション詳細を取得して rubric と improvements を取得
      const detailRes = await fetch(`/api/sessions/${session.id}`, {
        headers: { Authorization: "Bearer " + t }
      });
      const detail = await detailRes.json();

      const rubric = detail?.session?.analysis?.report?.rubric || detail?.analysis?.report?.rubric || [];
      const improvements = detail?.session?.analysis?.report?.improvements || detail?.analysis?.report?.improvements || [];
      
      console.log('[loadPracticeAdvice] Session:', session.id);
      console.log('[loadPracticeAdvice] Rubric items:', rubric.length);
      console.log('[loadPracticeAdvice] Improvements:', improvements);

      // rubric のスコアを集計
      for (const item of rubric) {
        const name = item.name || "";
        const score = Number(item.score || 0);
        if (!itemScores[name]) itemScores[name] = [];
        itemScores[name].push(score);
      }

      // improvements を収集
      if (improvements && improvements.length > 0) {
        console.log('[loadPracticeAdvice] Adding improvements:', improvements);
        allImprovements.push(...improvements);
      }
    }

    // 平均スコアを計算し、低スコア項目を抽出
    const weakItems = [];
    for (const [name, scores] of Object.entries(itemScores)) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg < 1.0) {  // 平均1.0未満を「改善が必要」と判定
        weakItems.push({ name, avg, count: scores.length });
      }
    }

    // スコアが低い順にソート
    weakItems.sort((a, b) => a.avg - b.avg);

    // improvements から頻出項目を抽出（最大5件）
    const improvementCounts = {};
    for (const imp of allImprovements) {
      const text = String(imp || "").trim();
      if (!text) continue;
      improvementCounts[text] = (improvementCounts[text] || 0) + 1;
    }

    const topImprovements = Object.entries(improvementCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([text]) => text);

    // improvementsがない場合、weakItemsから「次回の練習で意識すること」を生成
    let focusAreas = topImprovements;
    if (focusAreas.length === 0 && weakItems.length > 0) {
      focusAreas = weakItems.slice(0, 3).map(item => `${item.name}のスキル向上を目指しましょう`);
    }

    // アドバイスHTMLを生成
    console.log('[loadPracticeAdvice] Weak items:', weakItems);
    console.log('[loadPracticeAdvice] Top improvements:', topImprovements);
    console.log('[loadPracticeAdvice] Focus areas:', focusAreas);
    
    let html = `<div style="font-size:13px; color:#4b5563; margin-bottom:8px;">過去${evaluatedSessions.length}回の練習から分析しました</div>`;

    // v4.31: 「改善が必要な項目」セクションを削除（ユーザー要望）

    if (focusAreas.length > 0) {
      html += `<div style="background:#fff; border:1px solid #fce7f3; border-radius:8px; padding:12px;">`;
      html += `<div style="font-weight:700; font-size:14px; color:#9f1239; margin-bottom:8px;">`;
      html += `次回の練習で意識すること：</div>`;
      html += `<ul style="margin:0; padding-left:20px; color:#374151;">`;
      for (const area of focusAreas) {
        html += `<li>${esc(area)}</li>`;
      }
      html += `</ul></div>`;
    }

    if (weakItems.length === 0 && focusAreas.length === 0) {
      html += `<div style="text-align:center; padding:20px; color:#10b981;">`;
      html += `<div style="font-size:32px; margin-bottom:8px;">✅</div>`;
      html += `<div style="font-weight:700;">素晴らしいです！</div>`;
      html += `<div style="font-size:13px; margin-top:4px;">すべての項目で良好な結果です。この調子で続けましょう。</div>`;
      html += `</div>`;
    }

    adviceContent.innerHTML = html;
    adviceCard.style.display = "";
    console.log('[loadPracticeAdvice] ✓ Advice card displayed');

  } catch (e) {
    console.error("[loadPracticeAdvice] Error:", e);
    adviceCard.style.display = "none";
  }
}

// メニュー画面表示時にアドバイスを読み込む
window.addEventListener("auth-state", (ev) => {
  if (ev?.detail?.signedIn) {
    setTimeout(() => loadPracticeAdvice(), 500);
  }
});

// Auth callbacks (called by auth.js)
window.onUserSignedIn = async (user) => {
  console.log("[auth] User signed in:", user?.email);
  window.__authSignedIn = true;
  
  // Show/hide login/logout buttons
  const btnLogin = $("btnLogin");
  const btnLogout = $("btnLogout");
  if (btnLogin) btnLogin.style.display = "none";
  if (btnLogout) btnLogout.style.display = "";
  
  // Dispatch auth-state event
  window.dispatchEvent(new CustomEvent("auth-state", { detail: { signedIn: true, user } }));
};

window.onUserSignedOut = async () => {
  console.log("[auth] User signed out");
  window.__authSignedIn = false;
  
  // Show/hide login/logout buttons
  const btnLogin = $("btnLogin");
  const btnLogout = $("btnLogout");
  if (btnLogin) btnLogin.style.display = "";
  if (btnLogout) btnLogout.style.display = "none";
  
  // Dispatch auth-state event
  window.dispatchEvent(new CustomEvent("auth-state", { detail: { signedIn: false } }));
};
