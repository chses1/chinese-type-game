// main.js — DOM Ready + 防呆 + 刪除模式

const API_BASE = "/api";

async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

const API = {
  upsertStudent(payload) { return jsonFetch(`${API_BASE}/upsert-student`, { method:"POST", body:JSON.stringify(payload) }); },
  updateBest(payload)    { return jsonFetch(`${API_BASE}/update-best`,     { method:"POST", body:JSON.stringify(payload) }); },
  leaderboard(limit=10, classPrefix=""){
    const qs = new URLSearchParams({ limit }); if (classPrefix) qs.set("classPrefix", classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?` + qs.toString());
  },
  getStudent(sid)  { return jsonFetch(`${API_BASE}/student/${sid}`); },
  getClasses()     { return jsonFetch(`${API_BASE}/classes`); },
  classroomState() { return jsonFetch(`${API_BASE}/classroom/state?t=${Date.now()}`); },
  studentHeartbeat(payload){ return jsonFetch(`${API_BASE}/student/heartbeat`, { method:"POST", body:JSON.stringify(payload) }); },

};

// ====== 等待 DOM 準備好再初始化（避免抓不到節點）======
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),900); };

  // 若頁面沒有遊戲畫面（如 teacher.html），直接略過以下初始化
  const canvas = $('gameCanvas');
  if (!canvas) return;

  
    const ctx = canvas.getContext('2d');
  let canDraw = false;

  function roundRectPath(x, y, w, h, r = 12) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function setImageSrcFromCandidates(img, paths) {
    const candidates = Array.isArray(paths) ? paths.filter(Boolean) : [paths].filter(Boolean);
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) return;
      img.src = candidates[index++];
    };
    img.onerror = () => {
      if (index < candidates.length) {
        tryNext();
      } else {
        console.warn('❌ 圖片載入失敗：', candidates.join(' / '));
      }
    };
    tryNext();
  }

  const earthBgImg = new Image();
  let earthBgReady = false;
  earthBgImg.onload = () => { earthBgReady = true; if (canDraw) draw(); };
  setImageSrcFromCandidates(earthBgImg, ['earth_bg.png', './earth_bg.png', 'img/earth_bg.png', './img/earth_bg.png']);

  // ===== 四種隕石圖片（請放在 /img/ 目錄）=====
  const meteorImgs = {
    normal: new Image(),
    gold:   new Image(),
    ice:    new Image(),
    boss:   new Image(),
  };

  const imgReady = { normal:false, gold:false, ice:false, boss:false };

  const meteorImageCandidates = {
    normal: ['meteor_normal.png', './meteor_normal.png', 'img/meteor_normal.png', './img/meteor_normal.png'],
    gold:   ['meteor_gold.png', './meteor_gold.png', 'img/meteor_gold.png', './img/meteor_gold.png'],
    ice:    ['meteor_ice.png', './meteor_ice.png', 'img/meteor_ice.png', './img/meteor_ice.png'],
    boss:   ['meteor_boss.png', './meteor_boss.png', 'img/meteor_boss.png', './img/meteor_boss.png'],
  };

  for (const [k,img] of Object.entries(meteorImgs)) {
    img.onload  = () => { imgReady[k] = true; };
    setImageSrcFromCandidates(img, meteorImageCandidates[k]);
  }

  const ZHUYIN=['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ','ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ','ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ','ˇ','ˋ','ˊ','˙'
];
  const SHENGMU=new Set(['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ']);
  const MEDIAL =new Set(['ㄧ','ㄨ','ㄩ']);const TONE   =new Set(['ˇ','ˋ','ˊ','˙']);
// ✅ 聲調鍵獨立一類（方便上色與後續統計）
const keyClass = ch => SHENGMU.has(ch) ? 'shengmu' : (MEDIAL.has(ch)?'medial':(TONE.has(ch)?'tone':'yunmu'));


  // === 等級 & 速度 ===
  let level = 1;
  const MAX_LIVES = 3;
  let lives = MAX_LIVES;
  const ACC_THRESHOLD = 0.8;
  const LEVELS = [
    { lpm:9,  duration:60, speedMul:1.00, bossChance:0.02, goldChance:0.12, iceChance:0.12, finalBossChance:0.16, finalExtraBoss:1, eventCount:1 },
    { lpm:10, duration:60, speedMul:1.03, bossChance:0.02, goldChance:0.12, iceChance:0.12, finalBossChance:0.17, finalExtraBoss:1, eventCount:1 },
    { lpm:11, duration:60, speedMul:1.06, bossChance:0.03, goldChance:0.11, iceChance:0.12, finalBossChance:0.18, finalExtraBoss:1, eventCount:2 },
    { lpm:12, duration:60, speedMul:1.09, bossChance:0.03, goldChance:0.11, iceChance:0.11, finalBossChance:0.19, finalExtraBoss:1, eventCount:2 },
    { lpm:13, duration:60, speedMul:1.12, bossChance:0.04, goldChance:0.10, iceChance:0.11, finalBossChance:0.20, finalExtraBoss:1, eventCount:2 },
    { lpm:14, duration:60, speedMul:1.15, bossChance:0.04, goldChance:0.10, iceChance:0.10, finalBossChance:0.21, finalExtraBoss:1, eventCount:2 },
    { lpm:15, duration:60, speedMul:1.18, bossChance:0.05, goldChance:0.10, iceChance:0.10, finalBossChance:0.22, finalExtraBoss:2, eventCount:2 },
    { lpm:16, duration:60, speedMul:1.21, bossChance:0.05, goldChance:0.09, iceChance:0.10, finalBossChance:0.23, finalExtraBoss:2, eventCount:2 },
    { lpm:17, duration:60, speedMul:1.24, bossChance:0.06, goldChance:0.09, iceChance:0.09, finalBossChance:0.24, finalExtraBoss:2, eventCount:2 },
    { lpm:18, duration:60, speedMul:1.27, bossChance:0.06, goldChance:0.08, iceChance:0.09, finalBossChance:0.25, finalExtraBoss:2, eventCount:2 }
  ];
  const LEVEL_NAMES = [
    '新兵試煉','近地軌道防線','流星攔截戰','冰封空域','黃金突襲','雙星危機','極速防衛網','重力亂流區','終極警戒線','地球最終決戰'
  ];
  const getLevelCfg = () => LEVELS[level - 1] || LEVELS.at(-1);
  const spawnInterval = () => Math.max(320, Math.round(60000 / getLevelCfg().lpm));
  const levelFallFactor = () => getLevelCfg().speedMul;

  let W,H;
  function applyViewportLayout(){
    const headerEl = document.querySelector('header');
    const kbdEl = $('kbd');
    const wrapEl = $('gameWrap');
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const headerH = Math.ceil(headerEl?.getBoundingClientRect().height || 64);
    const kbdH = Math.ceil(kbdEl?.getBoundingClientRect().height || 280);
    document.documentElement.style.setProperty('--header-h', `${headerH}px`);
    document.documentElement.style.setProperty('--kbd-h', `${kbdH}px`);
    if (wrapEl) {
      // 鍵盤是 fixed 疊在畫面上方，所以遊戲畫布要延伸到鍵盤底下，不能把鍵盤高度扣掉。
      const usable = Math.max(320, vh - headerH);
      wrapEl.style.height = `${usable}px`;
      wrapEl.style.minHeight = `${usable}px`;
      wrapEl.style.marginTop = `${headerH}px`;
    }
  }

  function resize(){
    applyViewportLayout();
    const r=canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    W=canvas.width=Math.max(1, Math.floor(r.width*dpr));
    H=canvas.height=Math.max(1, Math.floor(r.height*dpr));
    if (canDraw) draw();
  }
  resize();
  addEventListener('resize', ()=>{ resize(); setTimeout(resize, 60); });

  // 狀態
  let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
  let correct=0, wrong=0;
  let gameEnded = false; // 防止 endGame 重複觸發
  // ====== NEW: Combo / 爆炸特效 / 黃金隕石 ======
  let combo = 0;
  let maxCombo = 0;
  let comboEnergy = 0;
  let comboBoostUntil = 0;
  let dangerMode = false;
  let dangerAlertShown = false;
  const explosions = []; // {x,y,t0,life}
  const lasers = []; // {x1,y1,x2,y2,t0,life,kind}
  const earthHits = []; // { t0, life } 地球被擊中閃光
  const iceFlashes = []; // { x, y, t0, life } 冰凍隕石命中淡藍閃光
  const iceScreenGlows = []; // { t0, life } 冰凍隕石命中時整個畫面邊框泛藍光
  const effectNotices = []; // { text, t0, life, type } 畫面中央狀態提示
  const scorePopups = []; // { x, y, text, t0, life, type } 隕石附近局部分數提示
  let finalVictory = null; // { active, startAt, duration, stats, onDone, skipHintAt, cleanup }


  // ====== NEW: 小任務 / 關卡事件 ======
  let activeMissions = [];
  let missionStats = null;
  let missionSnapshot = [];
  let roundMissionHistory = [];
  let activeEvent = null;
  let eventTriggerTimes = [];
  let lastEventTriggerTime = null;
  let eventExtraSpawnTimer = 0;
  let bossPhaseSpawnTimer = 0;
  let bossPhaseExtraSpawned = 0;

  function showCenterNotice(text, life = 1600, type = 'info') {
    const now = performance.now();
    for (let i = effectNotices.length - 1; i >= 0; i--) {
      if (effectNotices[i].text === text) effectNotices.splice(i, 1);
    }
    effectNotices.push({ text, t0: now, life, type });
  }

  function addScorePopup(x, y, text, type = 'normal', life = 900) {
    scorePopups.push({ x, y, text, type, t0: performance.now(), life });
  }


  function startFinalVictorySequence(stats = {}) {
    return new Promise((resolve) => {
      const now = performance.now();

      meteors.forEach(m => {
        explosions.push({ x: m.x, y: m.y, t0: now + Math.random() * 260, life: 420 });
      });
      meteors = [];

      finalVictory = {
        active: true,
        startAt: now,
        duration: 5600,
        stats: {
          score: Number(stats.score || 0),
          accPct: Number(stats.accPct || 0),
          title: String(stats.title || '🌟 地球傳奇守護者'),
          speed: Number(stats.speed || 0)
        },
        onDone: () => {
          resolve();
        }
      };

      const skip = () => finishFinalVictorySequence(true);
      const onKey = (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
          e.preventDefault();
          skip();
        }
      };
      const onPointer = () => skip();

      finalVictory.cleanup = () => {
        canvas.removeEventListener('pointerdown', onPointer);
        document.removeEventListener('keydown', onKey, true);
      };

      canvas.addEventListener('pointerdown', onPointer);
      document.addEventListener('keydown', onKey, true);
    });
  }

  function finishFinalVictorySequence(skipped = false) {
    if (!finalVictory?.active) return;
    const done = finalVictory.onDone;
    const cleanup = finalVictory.cleanup;
    finalVictory = null;
    if (typeof cleanup === 'function') cleanup();
    if (typeof done === 'function') done({ skipped });
  }

  function drawFinalVictoryOverlay(now = performance.now()) {
    if (!finalVictory?.active) return;

    const t = now - finalVictory.startAt;
    const p = Math.max(0, Math.min(1, t / finalVictory.duration));
    if (t >= finalVictory.duration) {
      finishFinalVictorySequence(false);
      return;
    }

    const fadeIn = Math.min(1, t / 700);
    const pulse = 0.5 + Math.sin(now / 260) * 0.5;

    ctx.save();
    ctx.fillStyle = `rgba(4, 10, 22, ${0.40 + fadeIn * 0.42})`;
    ctx.fillRect(0, 0, W, H);

    const cx = W * 0.5;
    const cy = H * 0.58;
    const baseR = Math.min(W, H) * 0.15;

    // 地球護盾波紋
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const local = (t - i * 520) / 1800;
      if (local < 0 || local > 1) continue;
      const r = baseR + local * Math.min(W, H) * 0.34;
      const a = (1 - local) * 0.28;
      ctx.lineWidth = 10 - local * 4;
      ctx.strokeStyle = `rgba(120, 220, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 中央光暈
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.36);
    glow.addColorStop(0, `rgba(190, 240, 255, ${0.20 + pulse * 0.12})`);
    glow.addColorStop(0.35, `rgba(90, 190, 255, ${0.16 + pulse * 0.06})`);
    glow.addColorStop(1, 'rgba(90, 190, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(W, H) * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 上方字幕
    const titleScale = t < 2200 ? (0.92 + Math.min(0.14, t / 2200 * 0.14)) : 1.06;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const titleY = H * 0.27;
    ctx.shadowColor = 'rgba(255, 215, 90, 0.45)';
    ctx.shadowBlur = 22;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.38)';
    ctx.font = `bold ${Math.round(Math.max(34, Math.min(68, W * 0.036)) * titleScale)}px system-ui`;
    ctx.strokeText('🌍 地球保衛成功！', cx, titleY);
    ctx.fillStyle = 'rgba(255, 230, 120, 1)';
    ctx.fillText('🌍 地球保衛成功！', cx, titleY);

    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.max(20, Math.min(32, W * 0.018))}px system-ui`;
    ctx.fillStyle = 'rgba(225, 242, 255, 0.96)';
    ctx.fillText('第 10 關最終任務完成，敵軍已撤退', cx, titleY + 54);

    if (t >= 2100) {
      const cardW = Math.min(720, W * 0.78);
      const cardH = Math.min(210, H * 0.28);
      const cardX = cx - cardW / 2;
      const cardY = H * 0.40;
      const cardFade = Math.min(1, (t - 2100) / 550);

      ctx.globalAlpha = cardFade;
      ctx.fillStyle = 'rgba(9, 24, 52, 0.82)';
      ctx.strokeStyle = 'rgba(255, 225, 120, 0.55)';
      ctx.lineWidth = 2;
      roundRectPath(cardX, cardY, cardW, cardH, 24);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 245, 190, 1)';
      ctx.font = `bold ${Math.max(24, Math.min(38, W * 0.022))}px system-ui`;
      ctx.fillText(finalVictory.stats.title || '🌟 地球傳奇守護者', cx, cardY + 42);

      ctx.fillStyle = 'rgba(230, 242, 255, 0.96)';
      ctx.font = `bold ${Math.max(18, Math.min(28, W * 0.016))}px system-ui`;
      ctx.fillText(`最終得分 ${finalVictory.stats.score}　｜　命中率 ${finalVictory.stats.accPct}%　｜　速度 ${Math.round(finalVictory.stats.speed)} 字/分`, cx, cardY + 92);

      ctx.font = `${Math.max(16, Math.min(24, W * 0.014))}px system-ui`;
      ctx.fillStyle = 'rgba(190, 220, 255, 0.92)';
      ctx.fillText('你成功守住了地球最後防線', cx, cardY + 132);

      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillText('點擊畫面或按 Enter 可跳過', cx, cardY + 170);
    }
    ctx.restore();
  }

  function buildMissionPool(){
    return [
      { id:'goldHunter', icon:'✨', title:'黃金獵人', desc:'累積打中 3 顆黃金隕石', target:3, rewardScore:8, statKey:'goldHits' },
      { id:'iceBreaker', icon:'❄️', title:'冰凍專家', desc:'累積打中 2 顆冰凍隕石', target:2, rewardScore:6, statKey:'iceHits' },
      { id:'comboMaster', icon:'🔥', title:'連擊高手', desc:'累積達成 10 連擊', target:10, rewardScore:10, statKey:'longestCombo' },
      { id:'quickShot', icon:'⚡', title:'快速反應', desc:'累積完成 5 次快速擊落', target:5, rewardScore:8, statKey:'fastHits' },
      { id:'bossBreaker', icon:'👾', title:'Boss 剋星', desc:'累積命中 Boss 4 次', target:4, rewardScore:12, statKey:'bossHits' }
    ];
  }

  function cloneMission(mission){
    return mission ? { ...mission } : null;
  }

  function createMission(excludedIds = []){
    const pool = buildMissionPool().filter(m => !excludedIds.includes(m.id));
    const source = pool.length ? pool : buildMissionPool();
    const picked = source[Math.floor(Math.random() * source.length)];
    return { ...picked, progress: 0, completed: false, rewardClaimed: false };
  }

  function findMissionById(id){
    return buildMissionPool().find(m => m.id === id) || null;
  }

  function createMissionFromId(id){
    if (id === 'random') return createMission();
    const picked = findMissionById(id);
    return picked ? { ...picked, progress: 0, completed: false, rewardClaimed: false } : createMission();
  }

  function findEventById(id){
    if (id === 'bossWave') {
      return {
        id:'bossWave', icon:'👾', label:'Boss 波次', desc:'10 秒內提高 Boss 壓力，額外出現 2 顆 Boss',
        durationMs: EVENT_DURATION_MS, bossPenalty:0, guaranteedType:'boss', extraSpawnTotal:2, maxConcurrent:6, extraSpeedMul:1.06
      };
    }
    return getEventPool().find(e => e.id === id) || null;
  }

  function prepareMissionsForRound({ keepExisting = true } = {}){
    const carry = keepExisting
      ? activeMissions
          .filter(m => !m.completed)
          .map(m => ({ ...m, completed: false, rewardClaimed: false }))
      : [];

    const freshMission = createMission(carry.map(m => m.id));
    activeMissions = [...carry, freshMission];
    roundMissionHistory = activeMissions.map(cloneMission);
    missionSnapshot = roundMissionHistory.map(cloneMission);
  }

  function resetMissionAndEvents({ keepExisting = true } = {}){
    prepareMissionsForRound({ keepExisting });
    missionStats = {
      goldHits: 0,
      iceHits: 0,
      fastHits: 0,
      bossHits: 0,
      longestCombo: 0
    };

    activeEvent = null;
    lastEventTriggerTime = null;

    const roundDuration = getLevelCfg().duration || 60;
    const eventCount = Math.max(0, Math.min(EVENT_MAX_PER_ROUND, Number(getLevelCfg().eventCount || EVENT_MAX_PER_ROUND)));

    // 前兩關只出 1 次事件，其餘關卡最多 2 次，並避開最後最終警報區
    const candidates = [
      roundDuration - 18,
      roundDuration - 38
    ]
      .filter(t => t > (FINAL_ALERT_SECONDS + 2) && t > 0)
      .slice(0, eventCount);

    eventTriggerTimes = candidates.sort((a, b) => b - a);
  }

  function snapshotCurrentMissions(){
    const source = roundMissionHistory.length ? roundMissionHistory : activeMissions;
    missionSnapshot = source.map(cloneMission);
  }

  function getEventPool(){
    return [
      {
        id:'meteorShower', icon:'☄️', label:'流星雨', desc:'10 秒內額外落下 3～4 顆高速流星',
        durationMs: EVENT_DURATION_MS, spawnMul:0.94,
        guaranteedType:'normal', extraSpawnTotal:4, maxConcurrent:8, extraSpeedMul:1.22
      },
      {
        id:'goldRush', icon:'✨', label:'黃金時刻', desc:'黃金隕石機率提升至 25%',
        durationMs: EVENT_DURATION_MS, goldChanceOverride:0.25, bossPenalty:0.01,
        guaranteedType:'gold', extraSpawnTotal:1, maxConcurrent:6
      },
      {
        id:'iceWind', icon:'🧊', label:'冰風暴', desc:'全場減速 10 秒並持續顯示寒流邊框',
        durationMs: EVENT_DURATION_MS, globalSlow:0.84, iceBonus:0.08,
        guaranteedType:'ice', extraSpawnTotal:1, maxConcurrent:6, persistentGlow:true
      }
    ];
  }

  function pickRoundEvent(){
    const pool = getEventPool();
    if (!pool.length) return null;
    if (!activeEvent) return { ...pool[Math.floor(Math.random() * pool.length)] };
    const filtered = pool.filter(e => e.id !== activeEvent.id);
    const source = filtered.length ? filtered : pool;
    return { ...source[Math.floor(Math.random() * source.length)] };
  }

  function getEventState(now = performance.now()){
    if (!activeEvent) return null;
    if (now >= activeEvent.endsAt) {
      activeEvent = null;
      return null;
    }
    return activeEvent;
  }

  function triggerRoundEvent(){
    const picked = pickRoundEvent();
    if (!picked) return;

    const now = performance.now();
    const randomizedExtraSpawnTotal = picked.id === 'meteorShower'
      ? (Math.random() < 0.5 ? 3 : 4)
      : Number(picked.extraSpawnTotal || 0);
    const extraSpawnTotal = Math.max(0, randomizedExtraSpawnTotal);
    const eventSpacingMs = extraSpawnTotal > 0
      ? Math.max(1800, picked.durationMs / Math.max(1, extraSpawnTotal))
      : Infinity;

    activeEvent = {
      ...picked,
      startsAt: now,
      endsAt: now + picked.durationMs,
      extraSpawnTotal,
      extraSpawned: 0,
      eventSpacingMs
    };
    eventExtraSpawnTimer = 0;

    // 事件顯示統一交給上方常駐狀態列，避免同時跳出多個重複提示
  }

  function applyForcedEventById(eventId, source = 'teacher'){
    const picked = findEventById(eventId);
    if (!picked) return false;

    const now = performance.now();
    const randomizedExtraSpawnTotal = picked.id === 'meteorShower'
      ? (Math.random() < 0.5 ? 3 : 4)
      : Number(picked.extraSpawnTotal || 0);
    const extraSpawnTotal = Math.max(0, randomizedExtraSpawnTotal);
    const eventSpacingMs = extraSpawnTotal > 0
      ? Math.max(1800, picked.durationMs / Math.max(1, extraSpawnTotal))
      : Infinity;

    activeEvent = {
      ...picked,
      startsAt: now,
      endsAt: now + picked.durationMs,
      extraSpawnTotal,
      extraSpawned: 0,
      eventSpacingMs
    };
    eventExtraSpawnTimer = 0;
    showCenterNotice(`${picked.icon || '🌀'} ${picked.label}`, 1400, 'event');
    return true;
  }

  function applyForcedMissionById(missionId, source = 'teacher'){
    const mission = createMissionFromId(missionId);
    activeMissions = [mission];
    roundMissionHistory = activeMissions.map(cloneMission);
    missionSnapshot = roundMissionHistory.map(cloneMission);
    showCenterNotice(`${mission.icon || '🎯'} 任務：${mission.title}`, 1400, 'mission');
    return true;
  }

  function getMissionDisplayList(now = performance.now()){
    return activeMissions.filter(m => !m.completed || !m.completedAt || (now - m.completedAt) < 1000);
  }

  function updateMissionProgress(){
    if (!activeMissions.length || !missionStats) return;

    activeMissions.forEach((mission) => {
      const progress = Math.max(0, Number(missionStats[mission.statKey] || 0));
      mission.progress = Math.min(mission.target, progress);
      if (!mission.completed && progress >= mission.target) {
        mission.completed = true;
        mission.completedAt = performance.now();
        if (!mission.rewardClaimed) {
          mission.rewardClaimed = true;
          score += mission.rewardScore;
          setScore();
        }
      }
    });

    roundMissionHistory = activeMissions.map(cloneMission);
    snapshotCurrentMissions();
  }

  function getKeyboardTopY(){
    const kbdEl = $('kbd');
    const canvasRect = canvas.getBoundingClientRect();
    const kbdRect = kbdEl?.getBoundingClientRect();

    if (kbdRect && canvasRect && kbdRect.top < canvasRect.bottom) {
      const scaleY = canvas.height / Math.max(1, canvasRect.height);
      const topInCanvas = (kbdRect.top - canvasRect.top) * scaleY;
      return Math.max(120, Math.min(H - 90, topInCanvas));
    }

    const values = Object.values(keyPositions)
      .filter(p => p && Number.isFinite(p.y))
      .map(p => Math.max(0, Math.min(H, p.y)));
    if (!values.length) return H - 180;
    return Math.max(120, Math.min(H - 90, Math.min(...values)));
  }

  function getBottomHudLayout(itemCount = 1) {
    const safeMargin = 26;
    const gap = 14;
    const totalItems = Math.max(1, itemCount);
    const keyboardTop = getKeyboardTopY();
    const capsuleH = 58;
    const y = Math.max(88, Math.min(H - capsuleH - 18, keyboardTop - capsuleH - 14));
    const maxW = W - safeMargin * 2;
    const capsuleW = Math.max(180, Math.min(280, (maxW - gap * (totalItems - 1)) / totalItems));
    const totalW = capsuleW * totalItems + gap * Math.max(0, totalItems - 1);
    const startX = Math.max(safeMargin, (W - totalW) / 2);
    return {
      x: startX,
      y,
      w: capsuleW,
      h: capsuleH,
      gap,
      radius: 999
    };
  }

  function drawMissionCard() {
    const now = performance.now();
    const visibleMissions = getMissionDisplayList(now);
    if (!visibleMissions.length) return;

    const layout = getBottomHudLayout(visibleMissions.length + 1);

    visibleMissions.forEach((mission, index) => {
      const x = layout.x + (index + 1) * (layout.w + layout.gap);
      const y = layout.y;
      const progress = Math.max(0, Math.min(1, mission.progress / mission.target));
      const justCompleted = mission.completed && mission.completedAt && (now - mission.completedAt) < 1000;
      const fade = justCompleted ? Math.max(0, 1 - ((now - mission.completedAt) / 1000)) : 1;

      ctx.save();
      ctx.globalAlpha = fade;

      ctx.fillStyle = justCompleted ? 'rgba(18, 56, 34, 0.90)' : 'rgba(8, 18, 38, 0.88)';
      ctx.strokeStyle = justCompleted
        ? 'rgba(130,255,160,0.98)'
        : 'rgba(110,190,255,0.88)';
      ctx.lineWidth = 3;
      roundRectPath(x, y, layout.w, layout.h, layout.radius);
      ctx.fill();
      ctx.stroke();

      const innerX = x + 16;
      const innerY = y + 12;
      const rightPad = 14;
      const barW = Math.max(54, layout.w - 120);
      const barX = x + layout.w - barW - rightPad;
      const barY = y + layout.h / 2 - 6;
      const barH = 12;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = justCompleted ? '#d8ffe3' : '#ffffff';
      ctx.font = 'bold 18px system-ui';
      ctx.fillText(`${mission.icon} ${mission.title}`, innerX, innerY + 7);

      ctx.fillStyle = justCompleted ? 'rgba(216,255,227,0.92)' : 'rgba(210,230,255,0.92)';
      ctx.font = '15px system-ui';
      ctx.fillText(`${mission.progress}/${mission.target}  +${mission.rewardScore}分`, innerX, innerY + 28);

      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRectPath(barX, barY, barW, barH, 999);
      ctx.fill();

      ctx.fillStyle = justCompleted
        ? 'rgba(120,255,150,0.98)'
        : 'rgba(255,213,74,0.98)';
      roundRectPath(barX, barY, Math.max(8, barW * progress), barH, 999);
      ctx.fill();

      ctx.restore();
    });
  }


  function meteorVisualSize(m){
    const baseSize = 300;
    return baseSize * (m?.sizeMul || 1);
  }

  function getActiveStatusBadges(now = performance.now()) {
    const eventState = getEventState(now);

    // 只顯示一條主狀態，避免同時出現 3～4 個訊息
    // 優先順序：關卡事件 > 冰凍中 > 分數加倍中 > Boss 波次中
    if (eventState) {
      const remain = Math.max(1, Math.ceil((eventState.endsAt - now) / 1000));
      return [{
        icon: eventState.icon || '🌀',
        label: `${eventState.label} ${remain} 秒`,
        type: 'event'
      }];
    }

    if (now < slowUntil) {
      return [{
        icon: '❄️',
        label: `冰凍中 ${Math.max(1, Math.ceil((slowUntil - now) / 1000))} 秒`,
        type: 'ice'
      }];
    }

    if (now < comboBoostUntil) {
      return [{
        icon: '⚡',
        label: `分數加倍中 ${Math.max(1, Math.ceil((comboBoostUntil - now) / 1000))} 秒`,
        type: 'boost'
      }];
    }

    if (dangerMode) {
      return [{
        icon: '🚨',
        label: `最終警報 ${Math.max(1, timeLeft)} 秒`,
        type: 'boss'
      }];
    }

    return [];
  }

  // 取得按鍵在 canvas 的發射位置（抓不到就用畫面底部中間備援）
  function getKeyOrigin(ch){
    const kp = keyPositions[ch];
    if (kp && Number.isFinite(kp.x) && Number.isFinite(kp.y)) return { x: kp.x, y: kp.y };
    return { x: W * 0.5, y: H - 40 };
  }

  // 生成一條雷射（純視覺，不影響判定）
  function spawnLaser(fromX, fromY, toX, toY, kind='normal'){
    lasers.push({
      x1: fromX, y1: fromY,
      x2: toX,   y2: toY,
      kind,
      t0: performance.now(),
      life: 90 // ms：越小越「瞬間」
    });
  }
    const FINAL_ALERT_SECONDS = 10;  // 最後 10 秒進入最終警報
  const FINAL_ALERT_SPEED_BOOST = 1.08; // 最終警報時全場微加速
  const COMBO_BOOST_MS = 10000;   // 連擊滿條後 10 秒雙倍分數

  // 關卡事件設定
  const EVENT_MAX_PER_ROUND = 2;     // 每關最多 2 個事件
  const EVENT_DURATION_MS   = 10000; // 每次事件維持 10 秒

  // 冰凍效果：打到冰凍隕石 → 所有隕石慢動作幾秒
  let slowUntil = 0;          // performance.now() 的時間戳
  const SLOW_MS = 5000;       // 慢動作持續時間（延長為 5 秒）
  const SLOW_FACTOR = 0.45;   // 速度倍率（0.45 = 變慢）
  let me={sid:null,name:''};
  let teacherToken="";

  // ===== 教室競賽模式 =====
  let classroomMode = false;
  let classroomRoundFinished = false;
  let classroomPollTimer = null;
  let classroomLastRoundId = 0;
  let classroomCountdownEnd = 0;
  let classroomCurrentClass = '';
  let classroomRoundStarted = false;
  let classroomLastEventNonce = 0;
  let classroomLastMissionNonce = 0;
  let classroomForcedEventId = '';
  let classroomForcedMissionId = '';
  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  let classroomSyncInFlight = false;

  async function sendHeartbeat(status='online'){
    if (!me.sid || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await API.studentHeartbeat({ sid: me.sid, score, status, classroom: classroomMode });
    } catch (e) {
      console.warn('heartbeat fail', e);
    } finally {
      heartbeatInFlight = false;
    }
  }

  function startHeartbeat(){
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendHeartbeat(running ? 'playing' : 'online');
    }, 4000);
    sendHeartbeat(running ? 'playing' : 'online');
  }

  function stopHeartbeat(){
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  const setUserChip=()=>$('userChip') && ($('userChip').textContent=me.sid?`${me.sid}`:'未登入');
  const setScore=()=>$('score') && ($('score').textContent=score);
  const setTime =()=>$('time') && ($('time').textContent=timeLeft);
  const setLives=()=>{ const el=$('lives'); if(el) el.textContent = '❤️'.repeat(Math.max(0,lives)) + '🤍'.repeat(Math.max(0,MAX_LIVES-lives)); };

  function updateStageChip(){
    const el = $('chipHint');
    if (!el) return;
    const name = LEVEL_NAMES[Math.max(0, Math.min(LEVEL_NAMES.length - 1, level - 1))] || `第 ${level} 關`;
    el.textContent = `關卡：第 ${level} 關｜${name}`;
  }

  function isBossPhase(){
    return running && timeLeft <= FINAL_ALERT_SECONDS;
  }

  function setDangerUI(){
    const timeEl = $('time');
    if (!timeEl) return;
    const chip = timeEl.closest('.chip');
    if (!chip) return;

    if (dangerMode) {
      chip.style.background = 'rgba(160,20,20,.88)';
      chip.style.borderColor = 'rgba(255,120,120,.95)';
      chip.style.boxShadow = '0 0 0 2px rgba(255,80,80,.16), 0 0 18px rgba(255,80,80,.38)';
      chip.style.transform = 'scale(1.06)';
    } else {
      chip.style.background = '';
      chip.style.borderColor = '';
      chip.style.boxShadow = '';
      chip.style.transform = '';
    }
  }

  function resetRoundState({ keepExisting = true } = {}){
    correct = 0;
    wrong = 0;
    combo = 0;
    maxCombo = 0;
    comboEnergy = 0;
    comboBoostUntil = 0;
    dangerMode = false;
    dangerAlertShown = false;
    meteors.length = 0;
    lasers.length = 0;
    explosions.length = 0;
    iceFlashes.length = 0;
    iceScreenGlows.length = 0;
    effectNotices.length = 0;
    scorePopups.length = 0;
    earthHits.length = 0;
    timeLeft = getLevelCfg().duration || 60;
    resetMissionAndEvents({ keepExisting });
    if (classroomMode && classroomForcedMissionId) {
      applyForcedMissionById(classroomForcedMissionId, 'teacher');
    }
    if (classroomMode && classroomForcedEventId) {
      applyForcedEventById(classroomForcedEventId, 'teacher');
    }
    setTime();
    updateStageChip();
    draw();
  }

  function resetWholeGame({keepLogin=true} = {}){
    gameEnded = false;
    running = false;
    clearInterval(timerId);
    level = 1;
    lives = MAX_LIVES;
    score = 0;
    resetRoundState({ keepExisting:false });
    setScore();
    setLives();
    updateStageChip();
    closeResult();
    if (finalVictory?.active) finishFinalVictorySequence(true);
    if (!keepLogin) me = { sid:null, name:'' };
    updatePauseButton();
  }

  function updatePauseButton(){
    const btn = document.querySelector('#kbd .key.control');
    if (!btn) return;
    if (classroomMode) {
      btn.textContent = running ? '⏸ 暫停' : '⏳ 等待';
    } else {
      btn.textContent = running ? '⏸ 暫停' : '▶️ 開始';
    }
  }

  function setModeChip(text='模式：自由練習', show=false){
    const chip = $('modeChip');
    if (!chip) return;
    chip.textContent = text;
    chip.style.display = show ? 'block' : 'none';
  }

  function showClassroomOverlay(title='班級競賽模式', msg='等待老師開始…', sub='老師按下開始後，全班會同步倒數。'){
    const o = $('classroomOverlay');
    if (!o) return;
    if ($('classroomTitle')) $('classroomTitle').textContent = title;
    if ($('classroomMsg')) $('classroomMsg').textContent = msg;
    if ($('classroomSub')) $('classroomSub').textContent = sub;
    o.hidden = false;
    o.style.display = 'flex';
  }

  function hideClassroomOverlay(){
    const o = $('classroomOverlay');
    if (!o) return;
    o.hidden = true;
    o.style.display = 'none';
  }

  function stopClassroomPolling(){
    if (classroomPollTimer) {
      clearInterval(classroomPollTimer);
      classroomPollTimer = null;
    }
  }

  async function syncClassroomState(){
    if (!me.sid || classroomSyncInFlight) return;
    classroomSyncInFlight = true;
    try {
      const resp = await API.classroomState();
      const s = resp.data || {};
      const myClass = String(me.sid).slice(0, 3);
      const isMine = !!(s.enabled && s.classPrefix === myClass);

      if (!isMine) {
        const wasClassroomMode = classroomMode;
        classroomMode = false;
        classroomCurrentClass = '';
        classroomCountdownEnd = 0;
        classroomLastRoundId = 0;
        classroomRoundFinished = false;
        classroomRoundStarted = false;
        classroomLastEventNonce = 0;
        classroomLastMissionNonce = 0;
        classroomForcedEventId = '';
        classroomForcedMissionId = '';
        hideClassroomOverlay();
        setModeChip('模式：自由練習', false);
        updatePauseButton();
        // 只有「從班級競賽切回自由練習」時才自動恢復，
        // 平常自由練習中的手動暫停不可被輪詢自動重新開始。
        if (me.sid && wasClassroomMode && !gameEnded) {
          enterFreePracticeMode();
        }
        return;
      }

      classroomMode = true;
      classroomCurrentClass = s.classPrefix || myClass;
      setModeChip(`模式：${classroomCurrentClass} 班級競賽`, true);

      const eventNonce = Number(s.forcedEventNonce || 0);
      const missionNonce = Number(s.forcedMissionNonce || 0);
      if (eventNonce !== classroomLastEventNonce) {
        classroomLastEventNonce = eventNonce;
        classroomForcedEventId = String(s.forcedEventId || '');
        if (running && classroomForcedEventId) applyForcedEventById(classroomForcedEventId, 'teacher');
      } else if (typeof s.forcedEventId !== 'undefined') {
        classroomForcedEventId = String(s.forcedEventId || '');
      }
      if (missionNonce !== classroomLastMissionNonce) {
        classroomLastMissionNonce = missionNonce;
        classroomForcedMissionId = String(s.forcedMissionId || '');
        if (running && classroomForcedMissionId) applyForcedMissionById(classroomForcedMissionId, 'teacher');
      } else if (typeof s.forcedMissionId !== 'undefined') {
        classroomForcedMissionId = String(s.forcedMissionId || '');
      }

      const serverNow = Number(s.now || Date.now());
      const roundId = Number(s.roundId || 0);
      const status = String(s.status || 'idle');

      if (roundId !== classroomLastRoundId) {
        classroomLastRoundId = roundId;
        classroomRoundFinished = false;
        classroomRoundStarted = false;
      }

      if (status === 'idle') {
        pauseGame();
        showClassroomOverlay('班級競賽模式', '等待老師開始…', '老師按下開始後，全班會同步倒數。');
      } else if (status === 'countdown') {
        classroomCountdownEnd = Number(s.startAt || 0);
        const sec = Math.max(0, Math.ceil((classroomCountdownEnd - serverNow) / 1000));
        pauseGame();
        showClassroomOverlay('班級競賽模式', `倒數 ${sec} 秒`, '請準備好，倒數結束後會自動開始。');
      } else if (status === 'running') {
        hideClassroomOverlay();
        if (!running && !classroomRoundFinished) {
          if (classroomRoundStarted) {
            resumeCurrentGame();
          } else {
            restart();
            classroomRoundStarted = true;
          }
        }
      } else if (status === 'paused') {
        pauseGame();
        showClassroomOverlay('班級競賽模式', '老師已暫停', '請等待老師繼續或重新開始。');
      }

      updatePauseButton();
    } catch (e) {
      console.warn('classroom sync fail', e);
    } finally {
      classroomSyncInFlight = false;
    }
  }

  function startClassroomPolling(){
    stopClassroomPolling();
    classroomPollTimer = setInterval(syncClassroomState, 2000);
    syncClassroomState();
  }

  function enterFreePracticeMode(){
    hideClassroomOverlay();
    setModeChip('模式：自由練習', false);
    if (!running && !gameEnded) startGame();
  }

  async function setBest(){
    const b = $('best');
    if (!b || !me.sid) return;
    try { const r = await API.getStudent(me.sid); if (r.ok) b.textContent = r.data.best; } catch{}
  }
  async function submitBest(sid, score){
    try { await API.updateBest({ sid, score }); } catch(e){ console.warn('submitBest fail', e); }
  }
// 🔑 記錄每個注音鍵在 canvas 中對應的位置
const keyPositions = {};

  function updateKeyPositions(){
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, canvasRect.width);
    const scaleY = canvas.height / Math.max(1, canvasRect.height);
    document.querySelectorAll('#kbd .key').forEach((btn) => {
      const ch = btn.dataset.key;
      if (!ch) return;
      const rect = btn.getBoundingClientRect();
      keyPositions[ch] = {
        x: (rect.left + rect.width / 2 - canvasRect.left) * scaleX,
        y: (rect.top - canvasRect.top) * scaleY
      };
    });
  }

  function buildKeyboard(){
  // ✅ 右側控制鍵：放在 ㄦ 鍵的下方
  // - ㄦ 在第 1 列最後一格
  // - 第 2 列最後一格放「暫停」
  // - 第 3 列最後一格放「結束」
  const rows=[
    ['ㄅ','ㄉ','ˇ','ˋ','ㄓ','ˊ','˙','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ','__PAUSE__'],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ','__END__'],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ','__RESTART__']
  ];

  const kbd=$('kbd'); 
  if(!kbd) return;

  Object.keys(keyPositions).forEach(k => delete keyPositions[k]);

  kbd.innerHTML='';
  rows.forEach(r=>{
    const row=document.createElement('div'); row.className='row';
    r.forEach(ch=>{
      // 空格：只佔位置，不可點擊
      if (ch == null) {
        const spacer = document.createElement('div');
        spacer.className = 'key spacer';
        spacer.textContent = '';
        row.appendChild(spacer);
        return;
      }

      const b=document.createElement('button');

      // 控制鍵
      if (ch === '__PAUSE__') {
        b.className = 'key control';
        b.textContent = '▶️ 開始';
        b.onclick = () => toggleRun();
      } else if (ch === '__END__') {
        b.className = 'key control';
        b.textContent = '⏹ 結束';
        b.onclick = () => {
          if (classroomMode) {
            toast && toast('班級競賽中不能自行結束');
            return;
          }
          if (confirm('確定要結束本局遊戲嗎？')) {
            endAndShowLeader();
          }
        };
      } else if (ch === '__RESTART__') {
        b.className = 'key control';
        b.textContent = '🔄 重來';
        b.onclick = () => {
          if (classroomMode) {
            toast && toast('班級競賽中請等待老師重新開始');
            return;
          }
          if (confirm('確定要重新開始嗎？目前分數會歸零。')) {
            restart();
          }
        };
      } else {
        // 一般注音鍵
        b.className='key '+(ZHUYIN.includes(ch)?keyClass(ch):'');
        b.textContent=ch;
        b.onclick=()=>pressKey(ch);
      }

      b.dataset.key = ch;
      row.appendChild(b);
    });
    kbd.appendChild(row);
  });

  requestAnimationFrame(() => {
    applyViewportLayout();
    resize();
    updateKeyPositions();
    setTimeout(() => {
      applyViewportLayout();
      resize();
      updateKeyPositions();
    }, 60);
  });
}

  function applyKbdPref(){ const k=$('kbd'); if(!k) return; const compact=localStorage.getItem('kbd-compact')==='1'; k.classList.toggle('compact',compact); }


function chooseMeteorType(){
  let type = 'normal';
  const eventState = getEventState();
  const cfg = getLevelCfg();
  const r = Math.random();
  const bossChanceBase = isBossPhase() ? cfg.finalBossChance : cfg.bossChance;
  const goldChanceBase = cfg.goldChance;
  const iceChanceBase  = cfg.iceChance;
  const bossChance = Math.max(0.01, bossChanceBase - (eventState?.bossPenalty || 0));
  const goldChance = Math.min(0.35, eventState?.goldChanceOverride ?? (goldChanceBase + (eventState?.goldBonus || 0)));
  const iceChance  = Math.min(0.30, iceChanceBase + (eventState?.iceBonus || 0));

  if (r < bossChance) type = 'boss';
  else if (r < bossChance + iceChance) type = 'ice';
  else if (r < bossChance + iceChance + goldChance) type = 'gold';
  return type;
}

function spawnMeteor(forceType = null, forceLabel = null, options = {}){
  const label = forceLabel || ZHUYIN[Math.floor(Math.random() * ZHUYIN.length)];
  const type = forceType || chooseMeteorType();

  const targetKey = label;
  if (!keyPositions[targetKey]) return false;
  const target = keyPositions[targetKey];

  const fromLeft = !SHENGMU.has(label);
  const startX = fromLeft ? -60 : W + 60;
  const startY = -80;

  const targetX = target.x;
  const targetY = target.y - 120;

  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.hypot(dx, dy) || 1;

  const speedMap = { normal:2.2, gold:2.45, ice:2.0, boss:1.95 };
  const typeSpeed = (speedMap[type] || speedMap.normal) * (Number(options.speedMul) || 1);

  const vx = (dx / len) * typeSpeed;
  const vy = (dy / len) * typeSpeed;

  const hp = (type === 'boss') ? 3 : 1;
  const sizeMul = (type === 'boss') ? 1.35 : (type === 'gold' ? 1.08 : (type === 'ice' ? 1.08 : 1.0));

  if (type === 'boss' && typeof toast === 'function') toast('⚠️ Boss 隕石！');

  meteors.push({
    x: startX,
    y: startY,
    vx, vy,
    label,
    type,
    hp,
    sizeMul,
    born: performance.now()
  });
  return true;
}

function processEventExtraSpawns(deltaMs = 16){
  const eventState = getEventState();
  if (!eventState?.guaranteedType || !running) {
    eventExtraSpawnTimer = 0;
    return;
  }

  if ((eventState.extraSpawned || 0) >= (eventState.extraSpawnTotal || 0)) return;

  eventExtraSpawnTimer += deltaMs;
  const interval = Math.max(1400, Number(eventState.eventSpacingMs || Infinity));
  if (eventExtraSpawnTimer < interval) return;

  const currentMeteorCount = meteors.length;
  const maxConcurrent = Math.max(5, Number(eventState.maxConcurrent || 6));
  if (currentMeteorCount >= maxConcurrent) {
    eventExtraSpawnTimer = Math.min(interval, eventExtraSpawnTimer - deltaMs * 0.35);
    return;
  }

  eventExtraSpawnTimer = 0;
  if (spawnMeteor(eventState.guaranteedType, null, { speedMul: eventState.extraSpeedMul || 1 })) {
    eventState.extraSpawned = (eventState.extraSpawned || 0) + 1;
  }
}

function processBossPhaseExtraSpawns(deltaMs = 16){
  if (!running || !isBossPhase()) {
    bossPhaseSpawnTimer = 0;
    bossPhaseExtraSpawned = 0;
    return;
  }

  const bossTargetTotal = Math.max(0, Number(getLevelCfg().finalExtraBoss || 0));
  if (bossPhaseExtraSpawned >= bossTargetTotal) return;

  bossPhaseSpawnTimer += deltaMs;
  const bossInterval = Math.max(spawnInterval() * 2.4, (FINAL_ALERT_SECONDS * 1000) / Math.max(1, bossTargetTotal));
  if (bossPhaseSpawnTimer < bossInterval) return;
  if (meteors.length >= 6) {
    bossPhaseSpawnTimer = Math.min(bossInterval, bossPhaseSpawnTimer - deltaMs * 0.35);
    return;
  }

  bossPhaseSpawnTimer = 0;
  if (spawnMeteor('boss')) {
    bossPhaseExtraSpawned += 1;
  }
}

function spawn(){
  spawnMeteor();
}
  function drawBackground(){
    ctx.clearRect(0,0,W,H);
    if (earthBgReady) {
      ctx.drawImage(earthBgImg, 0, 0, W, H);
    }
    ctx.fillStyle='rgba(255,255,255,.8)';
    for(let i=0;i<40;i++){ const x=(i*97%W), y=(i*181%H); ctx.globalAlpha=(i%5)/5+.2; ctx.fillRect(x,y,3,3); }
    ctx.globalAlpha=1;
  }
  function draw(){
  drawBackground();

  const now = performance.now();
  const isSlow = now < slowUntil;
  const comboBoostActive = now < comboBoostUntil;

  if (dangerMode) {
    const pulse = 0.08 + Math.abs(Math.sin(now / 140)) * 0.10;
    ctx.save();
    ctx.fillStyle = `rgba(255, 60, 60, ${pulse.toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  meteors.forEach(m=>{

    ctx.save();
    ctx.translate(m.x, m.y);

    const baseSize = 300;
    const size = baseSize * (m.sizeMul || 1);
    m.size = size;

    // 外圈提示：僅保留 Boss 隕石護盾圈
    if (m.type === 'boss') {
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 14;
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.beginPath(); ctx.arc(0,0,size*0.5,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 畫圖：依照 type 選圖
    const key = (m.type in meteorImgs) ? m.type : 'normal';
    const ok = imgReady[key];

    // ✅ 修正：圖檔本身已經有固定方向火焰
    // Safari / iPad 對 drawImage 負寬度翻轉支援不穩，改用 scale(-1, 1) 明確翻轉
    const flipX = (m.vx || 0) > 0; // 往右飛 → 需要水平翻轉，讓火焰留在後方
    if (ok) {
      if (flipX) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(meteorImgs[key], -size/2, -size/2, size, size);
        ctx.restore();
      } else {
        ctx.drawImage(meteorImgs[key], -size/2, -size/2, size, size);
      }
    } else {
      // fallback（圖片沒載到時）
      ctx.fillStyle = (m.type==='gold') ? '#f59e0b'
                 : (m.type==='ice' ? '#5eead4'
                 : (m.type==='boss' ? '#ef4444' : '#3b82f6'));
      ctx.beginPath(); ctx.arc(0,0,size*0.45,0,Math.PI*2); ctx.fill();
    }

    // Boss 血量條
    if (m.type === 'boss') {
      const hp = Math.max(0, Number(m.hp||0));
      const maxHp = 3;
      const w = size*0.6;
      const h = 14;
      const x = -w/2;
      const y = -size*0.55;

      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x, y, w, h);

      const ratio = Math.min(1, hp / maxHp);
      ctx.fillStyle = 'rgba(255,90,90,0.95)';
      ctx.fillRect(x, y, w*ratio, h);
      ctx.restore();
    }

    // 注音字
    // ✅ 修正：翻轉圖片時，文字的「水平微調」也要一起鏡像，才能保持在隕石正中心
    // 你原本的 xOffset = -size*0.08 是為了配合「未翻轉」圖檔的視覺中心
    // 當 flipX=true（往右飛、圖片水平翻轉）時，xOffset 需要改成 +size*0.08
    ctx.font='bold 100px system-ui';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.lineWidth=5;
    ctx.strokeStyle='rgba(0,0,0,.6)';
    const xOffset = ((flipX ? 1 : -1) * size * 0.08);
    const yOffset = (size * 0.15);
    ctx.strokeText(m.label, xOffset, yOffset);
    ctx.fillStyle='#fff';
    ctx.fillText(m.label, xOffset, yOffset);

    ctx.restore();
  });


  // ✅ NEW: 雷射瞬間線（畫在隕石上方、爆炸下方）
  for (let i = lasers.length - 1; i >= 0; i--) {
    const l = lasers[i];
    const t = (now - l.t0) / l.life;
    if (t >= 1) { lasers.splice(i, 1); continue; }

    // 讓雷射前 1/3 最亮，後面快速淡出
    const a = t < 0.33 ? 1 : Math.max(0, 1 - (t - 0.33) / 0.67);

    // 不同隕石給一點點不同色（避免太花，可自行統一成白色）
    const color =
      (l.kind === 'ice')  ? `rgba(120,220,255,${0.85 * a})` :
      (l.kind === 'gold') ? `rgba(255,215,0,${0.85 * a})` :
      (l.kind === 'boss') ? `rgba(255,120,120,${0.85 * a})` :
                            `rgba(255,255,255,${0.85 * a})`;

    ctx.save();

    // 外發光（粗線）
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();

    // 內核（細線）
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * a})`;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();

    // 發射口閃光
    if (t < 0.25) {
      ctx.globalAlpha = (0.25 - t) / 0.25;
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(255,255,255,0.9)`;
      ctx.beginPath();
      ctx.arc(l.x1, l.y1, 18, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // 爆炸特效（擴散圈）
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    const t = (now - e.t0) / e.life;

    // 尚未到開始時間，先不要畫，避免半徑變成負數造成 Canvas 報錯
    if (t < 0) continue;

    if (t >= 1) {
      explosions.splice(i, 1);
      continue;
    }

    const r = Math.max(0.1, 20 + t * 110);

    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);

    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,215,0,0.8)';
    ctx.beginPath();
    ctx.arc(e.x, e.y, Math.max(0.1, r * 0.6), 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  // 冰凍隕石命中淡藍閃光
  for (let i = iceFlashes.length - 1; i >= 0; i--) {
    const f = iceFlashes[i];
    const t = (now - f.t0) / f.life;
    if (t >= 1) {
      iceFlashes.splice(i, 1);
      continue;
    }

    const alpha = (1 - t) * 0.62;
    const r1 = 60 + t * 170;
    const r2 = 28 + t * 96;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r1);
    g.addColorStop(0, `rgba(235,250,255,${Math.min(1, alpha + 0.32)})`);
    g.addColorStop(0.28, `rgba(190,240,255,${Math.min(0.95, alpha + 0.14)})`);
    g.addColorStop(0.62, `rgba(110,215,255,${alpha})`);
    g.addColorStop(1, 'rgba(120,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r1, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 12;
    ctx.strokeStyle = `rgba(215,250,255,${Math.min(0.95, alpha + 0.12)})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(120,220,255,${alpha})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r1 * 0.72, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  // 冰凍隕石命中時，整個畫面邊框短暫泛藍光
  for (let i = iceScreenGlows.length - 1; i >= 0; i--) {
    const g = iceScreenGlows[i];
    const t = (now - g.t0) / g.life;
    if (t >= 1) {
      iceScreenGlows.splice(i, 1);
      continue;
    }

    const a = (1 - t) * 0.58;
    const edge = 28 + t * 10;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const topGrad = ctx.createLinearGradient(0, 0, 0, edge * 3.5);
    topGrad.addColorStop(0, `rgba(170,235,255,${Math.min(0.95, a + 0.12)})`);
    topGrad.addColorStop(1, 'rgba(170,235,255,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, edge * 3.5);

    const bottomGrad = ctx.createLinearGradient(0, H, 0, H - edge * 3.5);
    bottomGrad.addColorStop(0, `rgba(170,235,255,${Math.min(0.95, a + 0.12)})`);
    bottomGrad.addColorStop(1, 'rgba(170,235,255,0)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, H - edge * 3.5, W, edge * 3.5);

    const leftGrad = ctx.createLinearGradient(0, 0, edge * 3.5, 0);
    leftGrad.addColorStop(0, `rgba(150,225,255,${a})`);
    leftGrad.addColorStop(1, 'rgba(150,225,255,0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, edge * 3.5, H);

    const rightGrad = ctx.createLinearGradient(W, 0, W - edge * 3.5, 0);
    rightGrad.addColorStop(0, `rgba(150,225,255,${a})`);
    rightGrad.addColorStop(1, 'rgba(150,225,255,0)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(W - edge * 3.5, 0, edge * 3.5, H);

    ctx.strokeStyle = `rgba(210,248,255,${Math.min(0.95, a + 0.16)})`;
    ctx.lineWidth = 6 + (1 - t) * 6;
    ctx.strokeRect(8, 8, W - 16, H - 16);
    ctx.restore();
  }

  const persistentIceWind = activeEvent?.id === 'iceWind' && now < activeEvent.endsAt;
  if (persistentIceWind) {
    const a = 0.16 + Math.abs(Math.sin(now / 260)) * 0.08;
    const edge = 26;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const topGrad = ctx.createLinearGradient(0, 0, 0, edge * 4);
    topGrad.addColorStop(0, `rgba(170,235,255,${a + 0.12})`);
    topGrad.addColorStop(1, 'rgba(170,235,255,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, edge * 4);

    const bottomGrad = ctx.createLinearGradient(0, H, 0, H - edge * 4);
    bottomGrad.addColorStop(0, `rgba(170,235,255,${a + 0.12})`);
    bottomGrad.addColorStop(1, 'rgba(170,235,255,0)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, H - edge * 4, W, edge * 4);

    const leftGrad = ctx.createLinearGradient(0, 0, edge * 4, 0);
    leftGrad.addColorStop(0, `rgba(150,225,255,${a})`);
    leftGrad.addColorStop(1, 'rgba(150,225,255,0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, edge * 4, H);

    const rightGrad = ctx.createLinearGradient(W, 0, W - edge * 4, 0);
    rightGrad.addColorStop(0, `rgba(150,225,255,${a})`);
    rightGrad.addColorStop(1, 'rgba(150,225,255,0)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(W - edge * 4, 0, edge * 4, H);

    ctx.strokeStyle = `rgba(210,248,255,${a + 0.18})`;
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.restore();
  }

  // 地球被擊中閃爍特效
  for (let i = earthHits.length - 1; i >= 0; i--) {
    const hit = earthHits[i];
    const t = (now - hit.t0) / hit.life;
    if (t >= 1) {
      earthHits.splice(i, 1);
      continue;
    }

    const alpha = (1 - t) * 0.45;

    ctx.save();
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = `rgba(255,120,120,${alpha * 0.65})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // 底部 HUD：連擊能量條 + 任務卡（同尺寸橫向膠囊）
  const visibleMissions = getMissionDisplayList(now);
  const hudLayout = getBottomHudLayout(visibleMissions.length + 1);

  ctx.save();
  const barX = hudLayout.x;
  const barY = hudLayout.y;
  const barW = hudLayout.w;
  const barH = hudLayout.h;

  ctx.fillStyle = 'rgba(8, 18, 38, 0.90)';
  ctx.strokeStyle = comboBoostActive ? 'rgba(255,220,110,0.98)' : 'rgba(110,190,255,0.88)';
  ctx.lineWidth = 3;
  roundRectPath(barX, barY, barW, barH, hudLayout.radius);
  ctx.fill();
  ctx.stroke();

  const fillPad = 4;
  const fillW = (barW - fillPad * 2) * Math.max(0, Math.min(1, comboEnergy / 100));
  ctx.fillStyle = comboBoostActive ? 'rgba(255,215,80,0.96)' : 'rgba(80,220,255,0.96)';
  roundRectPath(barX + fillPad, barY + fillPad, Math.max(0, fillW), barH - fillPad * 2, hudLayout.radius);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 18px system-ui';
  ctx.fillText(comboBoostActive ? '⚡ 雙倍分數中' : '⚡ 連擊能量', barX + 16, barY + 23);

  ctx.font = '15px system-ui';
  if (comboBoostActive) {
    const remain = Math.max(0, Math.ceil((comboBoostUntil - now) / 1000));
    ctx.fillStyle = 'rgba(255,245,180,0.98)';
    ctx.fillText(`x2 剩餘 ${remain} 秒`, barX + 16, barY + 42);
  } else {
    ctx.fillStyle = 'rgba(210,230,255,0.95)';
    ctx.fillText(`${Math.round(comboEnergy)}/100`, barX + 16, barY + 42);
  }
  ctx.restore();

  drawMissionCard();

  // 隕石附近局部分數提示：避免和中央狀態列重疊
  for (let i = scorePopups.length - 1; i >= 0; i--) {
    const p = scorePopups[i];
    const t = (now - p.t0) / p.life;
    if (t >= 1) {
      scorePopups.splice(i, 1);
      continue;
    }

    const ease = 1 - Math.pow(1 - t, 2);
    const y = p.y - 18 - ease * 56;
    const x = p.x;
    const alpha = t < 0.12 ? (t / 0.12) : Math.max(0, 1 - t);
    let fg = '255,255,255';
    let glow = '255,255,255';
    if (p.type === 'gold') { fg = '255,235,140'; glow = '255,215,80'; }
    else if (p.type === 'ice') { fg = '205,245,255'; glow = '120,220,255'; }
    else if (p.type === 'boss') { fg = '255,210,210'; glow = '255,110,110'; }
    else if (p.type === 'boost') { fg = '255,245,180'; glow = '255,215,80'; }
    else if (p.type === 'wrong') { fg = '255,180,180'; glow = '255,90,90'; }
    else if (p.type === 'mission') { fg = '210,255,180'; glow = '140,255,120'; }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(26, Math.min(40, W * 0.024))}px system-ui`;
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.shadowColor = `rgba(${glow},0.38)`;
    ctx.shadowBlur = 18;
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = `rgba(${fg},1)`;
    ctx.fillText(p.text, x, y);
    ctx.restore();
  }

  // 畫面中央上方常駐狀態列：冰凍中 / 分數加倍中 / Boss 波次中
  const statusBadges = getActiveStatusBadges(now);
  if (statusBadges.length) {
    const fontSize = Math.max(22, Math.min(30, W * 0.018));
    const paddingX = 18;
    const gap = 14;
    const badgeH = Math.max(42, fontSize + 16);
    ctx.save();
    ctx.font = `bold ${fontSize}px system-ui`;
    ctx.textBaseline = 'middle';

    const widths = statusBadges.map(b => Math.ceil(ctx.measureText(`${b.icon} ${b.label}`).width) + paddingX * 2);
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, statusBadges.length - 1);
    let startX = (W - totalW) / 2;
    const y = Math.max(92, H * 0.16);

    statusBadges.forEach((b, idx) => {
      const w = widths[idx];
      let fill = 'rgba(20,30,50,0.78)';
      let stroke = 'rgba(255,255,255,0.35)';
      let glow = '255,255,255';
      if (b.type === 'ice') { fill = 'rgba(22,75,98,0.82)'; stroke = 'rgba(135,220,255,0.92)'; glow = '120,220,255'; }
      else if (b.type === 'boost') { fill = 'rgba(105,78,12,0.84)'; stroke = 'rgba(255,220,100,0.96)'; glow = '255,215,80'; }
      else if (b.type === 'boss') { fill = 'rgba(110,28,35,0.84)'; stroke = 'rgba(255,125,125,0.96)'; glow = '255,110,110'; }
      else if (b.type === 'event') { fill = 'rgba(56,40,110,0.84)'; stroke = 'rgba(180,150,255,0.96)'; glow = '180,150,255'; }

      ctx.save();
      ctx.shadowColor = `rgba(${glow},0.24)`;
      ctx.shadowBlur = 16;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 3;
      const radius = 14;
      ctx.beginPath();
      ctx.moveTo(startX + radius, y);
      ctx.lineTo(startX + w - radius, y);
      ctx.quadraticCurveTo(startX + w, y, startX + w, y + radius);
      ctx.lineTo(startX + w, y + badgeH - radius);
      ctx.quadraticCurveTo(startX + w, y + badgeH, startX + w - radius, y + badgeH);
      ctx.lineTo(startX + radius, y + badgeH);
      ctx.quadraticCurveTo(startX, y + badgeH, startX, y + badgeH - radius);
      ctx.lineTo(startX, y + radius);
      ctx.quadraticCurveTo(startX, y, startX + radius, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(`${b.icon} ${b.label}`, startX + paddingX, y + badgeH / 2 + 1);
      ctx.restore();
      startX += w + gap;
    });

    ctx.restore();
  }

  // 畫面中央重大事件短提示：只顯示狀態啟動瞬間
  for (let i = effectNotices.length - 1; i >= 0; i--) {
    const n = effectNotices[i];
    const t = (now - n.t0) / n.life;
    if (t >= 1) {
      effectNotices.splice(i, 1);
      continue;
    }

    const fade = t < 0.15 ? (t / 0.15) : (t > 0.82 ? Math.max(0, 1 - (t - 0.82) / 0.18) : 1);
    const y = H * 0.30 + (1 - fade) * 10;
    const fontSize = Math.max(34, Math.min(52, W * 0.032));
    let fg = '255,255,255';
    let glow = '255,255,255';
    if (n.type === 'ice') { fg = '200,245,255'; glow = '120,220,255'; }
    else if (n.type === 'boss') { fg = '255,220,220'; glow = '255,110,110'; }
    else if (n.type === 'boost') { fg = '255,245,180'; glow = '255,215,80'; }

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${fontSize}px system-ui`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.shadowColor = `rgba(${glow},0.45)`;
    ctx.shadowBlur = 22;
    ctx.strokeText(n.text, W / 2, y);
    ctx.fillStyle = `rgba(${fg},1)`;
    ctx.fillText(n.text, W / 2, y);
    ctx.restore();
  }

  drawFinalVictoryOverlay(now);
}

  function calcPoints(rtMs){
    if (rtMs <= 1500) return 3;
    if (rtMs <= 2500) return 2;
    return 1;
  }

  function pressKey(ch){
    if(!running) return;
    let idx=-1, bestY=-1;
    for(let i=0;i<meteors.length;i++){
      const m=meteors[i];
      if(m.label===ch && m.y>bestY){ bestY=m.y; idx=i; }
    }
    if(idx>=0){
      const m = meteors[idx];
      // ✅ NEW: 雷射瞬間線（純視覺，不延遲判定）
      const o = getKeyOrigin(ch);
      spawnLaser(o.x, o.y, m.x, m.y, m.type || 'normal');


      // ✅ NEW: Boss 有血量（打到先扣血，血量歸 0 才消失）
      let removed = true;
      if (m.type === 'boss') {
        m.hp = Math.max(0, Number(m.hp || 0) - 1);
        if (m.hp > 0) {
          removed = false;
          // 讓下一次計算反應時間更公平
          m.born = performance.now();
        }
      }

      if (removed) meteors.splice(idx, 1);

      // ✅ 連擊（Combo）
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      comboEnergy = Math.min(100, comboEnergy + (m.type === 'boss' ? 22 : m.type === 'gold' ? 18 : 12));
      if (missionStats) {
        if (m.type === 'gold') missionStats.goldHits++;
        if (m.type === 'ice') missionStats.iceHits++;
        if (m.type === 'boss') missionStats.bossHits++;
        if ((performance.now() - m.born) <= 2200) missionStats.fastHits++;
        missionStats.longestCombo = Math.max(missionStats.longestCombo || 0, combo);
      }
      updateMissionProgress();

      // ✅ 爆炸特效（在隕石位置）
      explosions.push({ x: m.x, y: m.y, t0: performance.now(), life: 260 });

      // ✅ NEW: 黃金隕石粒子爆炸（多幾圈）
      if (m.type === 'gold') {
        for (let i = 0; i < 8; i++) {
          explosions.push({
            x: m.x + Math.random() * 40 - 20,
            y: m.y + Math.random() * 40 - 20,
            t0: performance.now(),
            life: 420
          });
        }
      }

      // ✅ NEW: Boss 命中螢幕震動
      if (m.type === 'boss') {
        const dx = (Math.random() < 0.5 ? -1 : 1) * 4;
        const dy = (Math.random() < 0.5 ? -1 : 1) * 2;
        canvas.style.transform = `translate(${dx}px, ${dy}px)`;
        setTimeout(() => { canvas.style.transform = ''; }, 60);
      }

      // ✅ 修正：打中冰凍隕石時，啟動全場慢動作
      if (m.type === 'ice') {
        const nowTs = performance.now();
        slowUntil = nowTs + SLOW_MS;
        iceFlashes.push({ x: m.x, y: m.y, t0: nowTs, life: 520 });
        iceScreenGlows.push({ t0: nowTs, life: 480 });
        showCenterNotice('❄️ 冰凍慢動作', 1400, 'ice');
      }

      const rt = performance.now() - m.born;
      const pts = calcPoints(rt);

      // 黃金隕石固定高分
      const basePts = (m.type === 'gold') ? 5 : pts;

      if (comboEnergy >= 100) {
        comboEnergy = 0;
        comboBoostUntil = Math.max(comboBoostUntil, performance.now()) + COMBO_BOOST_MS;
        showCenterNotice('⚡ 分數加倍', 1400, 'boost');
      }

      // 連擊能量滿條後，10 秒內分數 x2
      const mult = (performance.now() < comboBoostUntil) ? 2 : 1;

      score += basePts * mult;
      correct++;
      setScore();

      if (m.type === 'gold') {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.45, `✨ 黃金 +${basePts * mult}`, 'gold', 980);
      } else if (m.type === 'boss' && !removed) {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.52, `💥 Boss -1｜剩 ${m.hp} 血`, 'boss', 1050);
      } else if (mult === 2) {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.45, `⚡ +${basePts * mult}`, 'boost', 920);
      } else if (m.type === 'ice') {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.45, `❄️ +${basePts * mult}`, 'ice', 920);
      } else if (m.type === 'boss') {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.45, `👾 +${basePts * mult}`, 'boss', 980);
      } else {
        addScorePopup(m.x, m.y - meteorVisualSize(m) * 0.45, `+${basePts * mult}`, 'normal', 860);
      }
    }else{
      // 打錯：連擊歸零
      combo = 0;
      comboEnergy = Math.max(0, comboEnergy - 22);
      updateMissionProgress();

      score = Math.max(0, score-1); wrong++;
      setScore();
      addScorePopup(W * 0.5, H * 0.72, '❌ -1', 'wrong', 760);
    }
  }

  function step(){
    const now = performance.now();

    if (running) {
      dangerMode = timeLeft <= FINAL_ALERT_SECONDS;
      setDangerUI();
      const eventState = getEventState();
      const spawnRateMul = eventState?.spawnMul || 1;

      spawnTimer += 16;
      if (spawnTimer > (spawnInterval() * spawnRateMul)) {
        spawn();
        spawnTimer = 0;
      }

      processEventExtraSpawns(16);
      processBossPhaseExtraSpawns(16);

      const f = levelFallFactor();
      const slow = (now < slowUntil) ? SLOW_FACTOR : 1;
      const eventSlow = eventState?.globalSlow || 1;
      const dangerBoost = dangerMode ? FINAL_ALERT_SPEED_BOOST : 1;

      meteors.forEach(m => {
        m.x += m.vx * 2 * f * slow * eventSlow * dangerBoost;
        m.y += m.vy * 2 * f * slow * eventSlow * dangerBoost;
      });

      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];

        // ✅ 修正：左右兩側出現時，不要「一出生就被當作離開畫面」刪掉
        // 只有當隕石真的往左飛且超出左界，或往右飛且超出右界，才算漏掉
        const outBottom = m.y > H + 60;
        const outLeft   = (m.vx || 0) < 0 && m.x < -120;
        const outRight  = (m.vx || 0) > 0 && m.x > W + 120;

        if (outBottom || outLeft || outRight) {
          meteors.splice(i, 1);
          score = Math.max(0, score - 1);
          wrong++;
          combo = 0; // ✅ 沒打到也算斷連擊
          comboEnergy = Math.max(0, comboEnergy - 18);
          updateMissionProgress();

          // 🌍 隕石撞到地球：畫面閃爍 + 輕微震動
          earthHits.push({ t0: now, life: 220 });
          canvas.style.transform = `translate(${Math.random() < 0.5 ? -4 : 4}px, ${Math.random() < 0.5 ? -2 : 2}px)`;
          setTimeout(() => { canvas.style.transform = ''; }, 90);
        }
      }

      draw();
    } else {
      // ✅ 關鍵修正：即使遊戲已停止，只要最終破關動畫還在播放，也必須持續重畫
      if (finalVictory?.active) {
        draw();
      }

      if (dangerMode) {
        dangerMode = false;
        setDangerUI();
      }
    }

    requestAnimationFrame(step);
  }

  function startGame(){
    gameEnded = false; // 每局開始重置
    if(!me.sid){
      toast && toast('請先登入');
      return;
    }
    running = true;
    updatePauseButton();
    ticker();
    sendHeartbeat('playing');
  }
  function pauseGame(){
    running = false;

    // ✅ 防作弊：暫停時清空所有隕石，重新開始後重新派題
    meteors = [];

    // 連擊歸零
    combo = 0;
    maxCombo = 0;
    comboEnergy = 0;
    comboBoostUntil = 0;
    dangerMode = false;
    setDangerUI();

    // 清除暫存特效，避免學生利用停留畫面判讀
    lasers.length = 0;
    explosions.length = 0;
    iceFlashes.length = 0;
    iceScreenGlows.length = 0;
    effectNotices.length = 0;

    draw();
    updatePauseButton();
    sendHeartbeat('paused');
  }

  function resumeCurrentGame(){
    if (!me.sid || gameEnded) return;
    running = true;
    updatePauseButton();
    ticker();
    sendHeartbeat('playing');
  }
  function toggleRun(){
    if (classroomMode) {
      toast && toast('班級競賽由老師控制');
      return;
    }
    running ? pauseGame() : startGame();
    updatePauseButton();
  }
// ✅ 結束：顯示排行榜後「自動重新開始」
// 做法：先停下遊戲 → 送出最佳分數 → 打開排行榜 → 當排行榜關閉時重開
async function endAndShowLeader(){
  if (!me.sid) { toast && toast('請先登入'); return; }
  running = false;
  clearInterval(timerId);

  // 結束時也送出 best（避免學生按結束就沒記到）
  try { await submitBest(me.sid, score); } catch {}
  await setBest();

  // 不顯示「打字結果」彈窗，直接看排行榜
  closeResult();
  await openLeader();
}

  let timerId=null;
  function ticker(){ clearInterval(timerId); timerId=setInterval(()=>{ if(!running) return; timeLeft--; setTime();
      dangerMode = timeLeft <= FINAL_ALERT_SECONDS;
      setDangerUI();
      if (dangerMode && !dangerAlertShown) {
        dangerAlertShown = true;
        toast && toast('🚨 最終警報！');
        showCenterNotice('🚨 最終警報', 1600, 'boss');
      }
      if (eventTriggerTimes.length && timeLeft <= eventTriggerTimes[0] && lastEventTriggerTime !== eventTriggerTimes[0]) {
        lastEventTriggerTime = eventTriggerTimes.shift();
        triggerRoundEvent();
      }
      if(timeLeft<=0 && !gameEnded){
      gameEnded = true;
      endGame();
    } },1000); }


  function getBattleGrade(acc){
    if (acc >= 1) return 'SS';
    if (acc >= 0.95) return 'S';
    if (acc >= 0.90) return 'A+';
    if (acc >= 0.80) return 'A';
    if (acc >= 0.70) return 'B';
    if (acc >= 0.60) return 'C';
    return 'D';
  }

  function getDefenseTitle(acc){
    if (acc >= 1) return { title:'⭐ 宇宙傳奇', desc:'完美攔截，全宇宙都會記住你。', next:'你已達到最高稱號！' };
    if (acc >= 0.90) return { title:'🌍 地球英雄', desc:'你的命中率已能穩定守住地球。', next:'再提高到 100% 可成為「宇宙傳奇」' };
    if (acc >= 0.80) return { title:'🛡️ 行星守衛', desc:'你已具備通關實力，是可靠的防衛隊員。', next:'再提高到 90% 可成為「地球英雄」' };
    if (acc >= 0.70) return { title:'☄️ 隕石獵人', desc:'反應不錯，再穩定一點就能守住防線。', next:'再提高到 80% 可成為「行星守衛」' };
    if (acc >= 0.60) return { title:'🛰️ 偵察員', desc:'你已經開始掌握戰場節奏。', next:'再提高到 70% 可成為「隕石獵人」' };
    return { title:'🚧 新兵', desc:'先求穩定命中，再追求更快速度。', next:'先提高到 60% 可升為「偵察員」' };
  }

  function buildResultOutcomeText({ passed, gameOver, livesLeft, acc }){
    if (gameOver) return '💀 地球防線崩潰，請重新整備後再出發';
    if (passed) return livesLeft >= MAX_LIVES ? '✅ 防衛成功！地球毫髮無傷，接關次數已滿' : `✅ 防衛成功！補回一次接關，目前 ${livesLeft}/${MAX_LIVES}`;
    const needPct = Math.max(0, Math.ceil((ACC_THRESHOLD - acc) * 100));
    return `⚠️ 防線仍有缺口，再提升約 ${needPct}% 命中率就能過關`;
  }

  function showResult({correct, wrong, acc, speed, passed, livesLeft = lives, gameOver = false}){
    const accPct = Math.round(acc * 100);
    const shieldPct = Math.max(8, Math.min(100, accPct));
    const grade = getBattleGrade(acc);
    const titleData = getDefenseTitle(acc);
    const missionsForResult = missionSnapshot.length ? missionSnapshot : (roundMissionHistory.length ? roundMissionHistory : activeMissions);

    if ($('resCorrect')) $('resCorrect').textContent = correct;
    if ($('resWrong'))   $('resWrong').textContent   = wrong;
    if ($('resAcc'))     $('resAcc').textContent     = accPct + '%';
    if ($('resSpeed'))   $('resSpeed').textContent   = Math.round(speed);
    if ($('resGrade'))   $('resGrade').textContent   = grade;
    if ($('resTitle'))   $('resTitle').textContent   = titleData.title;
    if ($('resTitleDesc')) $('resTitleDesc').textContent = titleData.desc;
    if ($('resProgressText')) $('resProgressText').textContent = titleData.next;
    if ($('resultOutcome')) $('resultOutcome').textContent = buildResultOutcomeText({ passed, gameOver, livesLeft, acc });
    if ($('resShield')) $('resShield').textContent = shieldPct + '%';
    if ($('resShieldFill')) $('resShieldFill').style.width = shieldPct + '%';

    const promoEl = $('resPromo');
    if (promoEl) {
      if (gameOver) {
        promoEl.textContent = '💀 地球遭到重創，本次作戰已結束。';
      } else if (passed) {
        promoEl.textContent = `✅ 本關達標，成功守住地球防線！（升級門檻 ${Math.round(ACC_THRESHOLD * 100)}%）`;
      } else {
        promoEl.textContent = `❌ 本關未達標，目前還差 ${Math.max(0, Math.ceil((ACC_THRESHOLD - acc) * 100))}% 命中率。`;
      }
    }

    const missionBox = $('resMissionSummary');
    if (missionBox) {
      missionBox.innerHTML = missionsForResult.length
        ? missionsForResult.map(m => {
            const stateClass = m.completed ? 'done' : 'todo';
            const stateText = m.completed ? `完成 +${m.rewardScore}分` : `${m.progress}/${m.target}`;
            return `<div class="resultMissionChip ${stateClass}">${m.icon} <b>${m.title}</b>｜${stateText}</div>`;
          }).join('')
        : '<div class="resultMissionChip todo">本回合沒有任務紀錄</div>';
    }

    const card = $('resultCard');
    if (card) {
      card.classList.remove('resultThemePass', 'resultThemeFail', 'resultThemeLegend');
      if (acc >= 0.95) card.classList.add('resultThemeLegend');
      else if (passed) card.classList.add('resultThemePass');
      else card.classList.add('resultThemeFail');
    }

    const btn = $('resultPrimaryBtn');
    if (btn) {
      const freshBtn = btn.cloneNode(true);
      btn.replaceWith(freshBtn);

      if (classroomMode) {
        freshBtn.textContent = '等待老師下一回合';
        freshBtn.disabled = true;
      } else if (gameOver) {
        freshBtn.textContent = '查看排行榜';
        freshBtn.disabled = true;
      } else if (passed) {
        freshBtn.textContent = '🚀 挑戰下一關';
        freshBtn.onclick = () => {
          closeResult();
          gameEnded = false;
          resetRoundState({ keepExisting:true });
          startGame();
        };
      } else {
        freshBtn.textContent = '🛠 再挑戰本關';
        freshBtn.onclick = () => {
          closeResult();
          gameEnded = false;
          resetRoundState({ keepExisting:true });
          startGame();
        };
      }
    }
    if ($('resultBox')) $('resultBox').style.display = 'flex';
  }
  function closeResult(){ if ($('resultBox')) $('resultBox').style.display='none'; }

  async function endGame(){
    running = false;
    clearInterval(timerId);
    gameEnded = true;
    updatePauseButton();

    const dur = (LEVELS[level-1]?.duration) || 60;
    const elapsed = dur - Math.max(0, timeLeft);
    const minutes = Math.max(1, elapsed) / 60;
    const acc = (correct + wrong) ? (correct / (correct + wrong)) : 0;
    const speed = correct / minutes;
    const passed = acc >= ACC_THRESHOLD;

    snapshotCurrentMissions();

    if (classroomMode) {
      showResult({ correct, wrong, acc, speed, passed, livesLeft: lives, gameOver: false });
      try {
        if (me.sid) await submitBest(me.sid, score);
        await setBest();
      } catch (e) {
        console.warn('endGame submit/setBest fail', e);
      }
      try {
        classroomRoundFinished = true;
        sendHeartbeat('finished');
        if (typeof showClassroomOverlay === 'function') {
          showClassroomOverlay('本回合結束', '請等待老師下一次開始', '你可以先看成績，不能自行重開。');
        }
      } catch (e) {
        console.warn('classroom overlay fail', e);
      }
      return;
    }

    if (passed) {
      const clearedFinalLevel = level >= LEVELS.length;
      if (!clearedFinalLevel) {
        level++;
      }
      lives = Math.min(MAX_LIVES, lives + 1);

      if (clearedFinalLevel) {
        setLives();
        try {
          await startFinalVictorySequence({
            score,
            accPct: Math.round(acc * 100),
            title: getDefenseTitle(acc).title,
            speed
          });
        } catch (e) {
          console.warn('final victory sequence fail', e);
        }

        try {
          if (me.sid) await submitBest(me.sid, score);
          await setBest();
        } catch (e) {
          console.warn('final clear submit/setBest fail', e);
        }

        await openLeader();
        return;
      }

      toast && toast(lives >= MAX_LIVES ? '🛡️ 過關成功，愛心已滿' : '💖 過關補回一顆愛心');
      showResult({ correct, wrong, acc, speed, passed, livesLeft: lives, gameOver: false });
    } else {
      lives = Math.max(0, lives - 1);
      if (lives > 0) {
        toast && toast(`💔 未達標，再挑戰本關（剩 ${lives} 顆）`);
        showResult({ correct, wrong, acc, speed, passed, livesLeft: lives, gameOver: false });
      } else {
        closeResult();
      }
    }

    setLives();

    try {
      if (me.sid) await submitBest(me.sid, score);
      await setBest();
    } catch (e) {
      console.warn('endGame submit/setBest fail', e);
    }

    if (lives <= 0) {
      await openLeader();
      return;
    }

  }

  function restart(){
    resetWholeGame();
    if (classroomMode) classroomRoundStarted = true;
    startGame();
    updatePauseButton();
  }

  function jumpToLevel(targetLevel){
    const maxLevel = LEVELS.length;
    const nextLevel = Math.max(1, Math.min(maxLevel, Number(targetLevel) || 1));

    level = nextLevel;
    gameEnded = false;
    running = false;
    clearInterval(timerId);

    // 保留登入狀態與目前累積分數，只重置當前關卡戰況
    resetRoundState({ keepExisting:false });

    setScore();
    setLives();
    updateStageChip();
    closeResult();

    if (finalVictory?.active) finishFinalVictorySequence(true);

    toast && toast(`🛰️ 已跳到第 ${level} 關：${LEVEL_NAMES[level - 1] || ''}`);
    updatePauseButton();
    draw();
  }

  // 排行榜（教師按鈕在遊戲頁也可用）
  async function openLeader() {
    const closeBtn = $('btnCloseLeader');
    if (closeBtn) closeBtn.textContent = '結束';

    const tb = $('leaderBody');
    const meta = $('leaderMeta');
    const panel = $('leader');
    if (!tb || !panel) return;

    panel.removeAttribute('hidden');
    panel.classList.add('show');
    panel.style.display = 'flex';

    try {
      const data = await API.leaderboard(500);
      const list = Array.isArray(data.data) ? data.data : [];
      const myIndex = list.findIndex(r => String(r.sid) === String(me.sid || ''));

      tb.innerHTML = list.map((r,i)=>{
        const rank = i + 1;
        const isMe = String(r.sid) === String(me.sid || '');
        return `<tr class="${isMe ? 'me' : ''}"><td>${rank}</td><td>${r.sid}${isMe ? '（你）' : ''}</td><td>${r.best}</td></tr>`;
      }).join('') || `<tr><td colspan="3">目前沒有排行榜資料</td></tr>`;

      if (meta) {
        if (myIndex >= 0) meta.textContent = `已反白你的名次，並自動捲到第 ${myIndex+1} 名附近`;
        else meta.textContent = `目前共 ${list.length} 人`;
      }

      requestAnimationFrame(() => {
        const wrap = document.querySelector('#leader .leaderTableWrap');
        const meRow = tb.querySelector('tr.me');
        if (wrap && meRow) {
          const top = meRow.offsetTop - wrap.clientHeight / 2 + meRow.clientHeight / 2;
          wrap.scrollTop = Math.max(0, top);
        } else if (wrap) {
          wrap.scrollTop = 0;
        }
      });
    } catch (e) {
      if (meta) meta.textContent = '排行榜載入失敗';
      tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
    }
  }
  function closeLeader(){ 
    const p=$('leader'); 
    if(p){
      p.classList.remove('show');
      p.style.display = 'none';
      p.setAttribute('hidden','');
    }
  }

  function logoutToInitialScreen(){
    closeLeader();
    closeResult();
    stopClassroomPolling();
    stopHeartbeat();
    classroomMode = false;
    classroomCurrentClass = '';
    classroomCountdownEnd = 0;
    classroomLastRoundId = 0;
    classroomRoundFinished = false;
    classroomRoundStarted = false;
    hideClassroomOverlay();
    setModeChip('模式：自由練習', false);
    resetWholeGame({ keepLogin:false });
    setUserChip();
    if ($('sid')) $('sid').value = '';
    if ($('login')) $('login').style.display = 'flex';
  }

  async function loadClasses(){ try{ const resp=await API.getClasses(); const box=$('classList'); if(!box) return; box.innerHTML=""; resp.data.forEach(c=>{ const btn=document.createElement('button'); btn.className='tag'; btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`; btn.onclick=()=>{ const cp=$('classPrefix'); if(cp){ cp.value=c.class; loadClassRank(); } }; box.appendChild(btn); }); }catch(e){ toast && toast('載入班級清單失敗'); } }
  async function loadAllRank(){ const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function loadClassRank(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請輸入正確的班級前三碼'); return; } const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit,p); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function clearClass(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼'); return; } if(!confirm(`確認清除 ${p} 班全部紀錄（含學號）？`)) return; try{ await API.adminClearClass(p,teacherToken); toast && toast(`已清除 ${p} 班`); await loadClassRank(); }catch(e){ alert('清除失敗：'+e.message); } }
  async function clearAll(){ if(!confirm('確認清除全部學生紀錄（含學號）？')) return; try{ await API.adminClearAll(teacherToken); toast && toast('已清除全部學生紀錄'); await loadAllRank(); }catch(e){ alert('清除失敗：'+e.message); } }

  // 綁定 UI（存在才綁）
  // 舊版按鈕綁定已移除，避免和目前介面殘留結構混用
  $('btnCloseLeader')  && ($('btnCloseLeader').onclick=logoutToInitialScreen);
  $('btnRestartGame')  && ($('btnRestartGame').onclick=()=>{ closeLeader(); restart(); });

  $('go') && ($('go').onclick = async () => {
    let sid = $('sid').value.trim().replace(/\D/g,'');
    if (!/^\d{5}$/.test(sid)) { alert('請輸入5位數學號'); return; }
    me.sid = sid; me.name = '';
    try { await API.upsertStudent({ sid }); } catch (e) { alert('登入失敗：' + e.message); return; }
    setUserChip(); await setBest();
    if ($('login')) $('login').style.display='none';
    resetWholeGame();

    startHeartbeat();
    startClassroomPolling();
    await syncClassroomState();
    if (!classroomMode) {
      enterFreePracticeMode();
    }

  });

  $('teacherOpen') && ($('teacherOpen').onclick = () => { /* 預設超連結就會導去 /teacher */ });

  // 實體鍵盤
  addEventListener('keydown',e=>{
    // Shift + 數字：快速跳關（Shift+0 = 第10關）
    if (e.shiftKey) {
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        jumpToLevel(Number(e.key));
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        jumpToLevel(10);
        return;
      }
    }

    if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
    if(e.key==='Escape'){ pauseGame(); return; }
    if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
  });

  // 初始化
  buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setLives(); updateStageChip(); setBest(); canDraw = true; applyViewportLayout(); resize(); updateKeyPositions(); draw(); hideClassroomOverlay(); setModeChip('模式：自由練習', false); updatePauseButton(); requestAnimationFrame(step);
  window.addEventListener('beforeunload', () => { stopClassroomPolling(); stopHeartbeat(); });
});
