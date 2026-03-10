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

  // ===== 四種隕石圖片（請放在 /img/ 目錄）=====
  const meteorImgs = {
    normal: new Image(),
    gold:   new Image(),
    ice:    new Image(),
    boss:   new Image(),
  };

  meteorImgs.normal.src = "img/meteor_normal.png";
  meteorImgs.gold.src   = "img/meteor_gold.png";
  meteorImgs.ice.src    = "img/meteor_ice.png";
  meteorImgs.boss.src   = "img/meteor_boss.png";

  const imgReady = { normal:false, gold:false, ice:false, boss:false };

  for (const [k,img] of Object.entries(meteorImgs)) {
    img.onload  = () => { imgReady[k] = true; };
    img.onerror = () => {
      console.warn("❌ 隕石圖片載入失敗：", img.src);
      imgReady[k] = false;
    };
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
  const LEVELS = [{ lpm:10, duration:60 }, { lpm:15, duration:60 }, { lpm:20, duration:60 }];
  const spawnInterval = () => Math.max(320, Math.round(60000 / (LEVELS[level-1] || LEVELS.at(-1)).lpm));
  const levelFallFactor = () => 1 + 0.1 * (level - 1);

  let W,H;
  function resize(){
    const r=canvas.getBoundingClientRect();
    W=canvas.width=Math.floor(r.width*2);
    H=canvas.height=Math.floor(r.height*2);
  }
  resize(); addEventListener('resize', resize);

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

  // ====== NEW: 小任務 / 關卡事件 ======
  let activeMission = null;
  let missionRewardClaimed = false;
  let missionStats = null;
  let activeEvent = null;
  let eventTriggerTimes = [];
  let lastEventTriggerTime = null;

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

  function buildMissionPool(){
    return [
      { id:'goldHunter', icon:'✨', title:'黃金獵人', desc:'本關打中 3 顆黃金隕石', target:3, rewardScore:8, statKey:'goldHits' },
      { id:'iceBreaker', icon:'❄️', title:'冰凍專家', desc:'本關打中 2 顆冰凍隕石', target:2, rewardScore:6, statKey:'iceHits' },
      { id:'comboMaster', icon:'🔥', title:'連擊高手', desc:'本關達成 10 連擊', target:10, rewardScore:10, statKey:'longestCombo' },
      { id:'quickShot', icon:'⚡', title:'快速反應', desc:'本關完成 6 次快速擊落', target:6, rewardScore:8, statKey:'fastHits' },
      { id:'bossBreaker', icon:'👾', title:'Boss 剋星', desc:'本關命中 Boss 4 次', target:4, rewardScore:12, statKey:'bossHits' }
    ];
  }

  function createMission(){
    const pool = buildMissionPool();
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return { ...picked, progress: 0, completed: false };
  }

  function resetMissionAndEvents(){
    activeMission = createMission();
    missionRewardClaimed = false;
    missionStats = {
      goldHits: 0,
      iceHits: 0,
      fastHits: 0,
      bossHits: 0,
      longestCombo: 0
    };
    activeEvent = null;
    lastEventTriggerTime = null;
    const roundDuration = (LEVELS[level-1]?.duration) || 60;
    eventTriggerTimes = [roundDuration - 15, roundDuration - 30, roundDuration - 45]
      .filter(t => t > BOSS_PHASE_SECONDS && t > 0)
      .sort((a, b) => b - a);
  }

  function getEventPool(){
    return [
      { id:'meteorShower', icon:'☄️', label:'流星雨', desc:'生成量上升', durationMs:6500, spawnMul:0.55 },
      { id:'goldRush', icon:'✨', label:'黃金時刻', desc:'黃金隕石大增', durationMs:8000, goldBonus:0.26, bossPenalty:0.02 },
      { id:'iceWind', icon:'🧊', label:'冰風暴', desc:'全場慢速，冰凍隕石增加', durationMs:7000, globalSlow:0.78, iceBonus:0.18 }
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
    activeEvent = { ...picked, startsAt: now, endsAt: now + picked.durationMs };
    showCenterNotice(`${picked.icon} ${picked.label}`, 1500, 'event');
    toast && toast(`${picked.icon} ${picked.label}：${picked.desc}`);
  }

  function updateMissionProgress(){
    if (!activeMission || !missionStats) return;
    const progress = Math.max(0, Number(missionStats[activeMission.statKey] || 0));
    activeMission.progress = Math.min(activeMission.target, progress);
    if (!activeMission.completed && progress >= activeMission.target) {
      activeMission.completed = true;
      if (!missionRewardClaimed) {
        missionRewardClaimed = true;
        score += activeMission.rewardScore;
        setScore();
        addScorePopup(W * 0.5, Math.max(120, H * 0.22), `🎯 任務完成 +${activeMission.rewardScore}`, 'mission', 1200);
        showCenterNotice(`🎯 任務完成：${activeMission.title}`, 1500, 'mission');
      }
    }
  }


  function meteorVisualSize(m){
    const baseSize = 300;
    return baseSize * (m?.sizeMul || 1);
  }

  function getActiveStatusBadges(now = performance.now()) {
    const badges = [];
    if (now < slowUntil) {
      badges.push({
        icon: '❄️',
        label: `冰凍中 ${Math.max(1, Math.ceil((slowUntil - now) / 1000))} 秒`,
        type: 'ice'
      });
    }
    if (now < comboBoostUntil) {
      badges.push({
        icon: '⚡',
        label: `分數加倍中 ${Math.max(1, Math.ceil((comboBoostUntil - now) / 1000))} 秒`,
        type: 'boost'
      });
    }
    if (isBossPhase()) {
      badges.push({
        icon: '👾',
        label: 'Boss 波次中',
        type: 'boss'
      });
    }
    const eventState = getEventState(now);
    if (eventState) {
      const remain = Math.max(1, Math.ceil((eventState.endsAt - now) / 1000));
      badges.push({
        icon: eventState.icon || '🌀',
        label: `${eventState.label} ${remain} 秒`,
        type: 'event'
      });
    }
    return badges;
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
    const GOLD_CHANCE = 0.10; // 黃金隕石機率（10%）
  const ICE_CHANCE  = 0.10; // 冰凍隕石機率（10%）
  const BOSS_CHANCE = 0.04; // 平常 Boss 隕石機率（4%）
  const BOSS_PHASE_CHANCE = 0.28; // Boss 波次時機率（28%）
  const BOSS_PHASE_SECONDS = 12;  // 最後 12 秒進入 Boss 波次
  const DANGER_SECONDS = 10;      // 最後 10 秒警報模式
  const COMBO_BOOST_MS = 10000;   // 連擊滿條後 10 秒雙倍分數

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
  let heartbeatTimer = null;

  async function sendHeartbeat(status='online'){
    if (!me.sid) return;
    try {
      await API.studentHeartbeat({ sid: me.sid, score, status, classroom: classroomMode });
    } catch (e) {
      console.warn('heartbeat fail', e);
    }
  }

  function startHeartbeat(){
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendHeartbeat(running ? 'playing' : 'online');
    }, 2000);
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

  function isBossPhase(){
    return running && timeLeft <= BOSS_PHASE_SECONDS;
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

  function resetRoundState(){
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
    timeLeft = (LEVELS[level-1]?.duration) || 60;
    resetMissionAndEvents();
    setTime();
    draw();
  }

  function resetWholeGame({keepLogin=true} = {}){
    gameEnded = false;
    running = false;
    clearInterval(timerId);
    level = 1;
    lives = MAX_LIVES;
    score = 0;
    resetRoundState();
    setScore();
    setLives();
    closeResult();
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
    if (!me.sid) return;
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
    }
  }

  function startClassroomPolling(){
    stopClassroomPolling();
    classroomPollTimer = setInterval(syncClassroomState, 1000);
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

  const kbd=$('kbd'); if(!kbd) return;
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

      // 記錄鍵盤按鍵在 canvas 座標中的位置（給隕石瞄準用）
      requestAnimationFrame(() => {
        const rect = b.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / canvasRect.width;
        const scaleY = canvas.height / canvasRect.height;

        keyPositions[ch] = {
          x: (rect.left + rect.width / 2 - canvasRect.left) * scaleX,
          y: (rect.top - canvasRect.top) * scaleY
        };
      });

      row.appendChild(b);
    });
    kbd.appendChild(row);
  });
}

  function applyKbdPref(){ const k=$('kbd'); if(!k) return; const compact=localStorage.getItem('kbd-compact')==='1'; k.classList.toggle('compact',compact); }

function spawn(){
  const label = ZHUYIN[Math.floor(Math.random() * ZHUYIN.length)];

  // 四種隕石機率（最後 12 秒進入 Boss 波次）
  let type = 'normal';
  const eventState = getEventState();
  const r = Math.random();
  const bossChanceBase = isBossPhase() ? BOSS_PHASE_CHANCE : BOSS_CHANCE;
  const goldChanceBase = isBossPhase() ? Math.max(0.03, GOLD_CHANCE * 0.45) : GOLD_CHANCE;
  const iceChanceBase  = isBossPhase() ? Math.max(0.03, ICE_CHANCE * 0.45)  : ICE_CHANCE;
  const bossChance = Math.max(0.01, bossChanceBase - (eventState?.bossPenalty || 0));
  const goldChance = Math.min(0.5, goldChanceBase + (eventState?.goldBonus || 0));
  const iceChance  = Math.min(0.45, iceChanceBase + (eventState?.iceBonus || 0));

  if (r < bossChance) type = 'boss';
  else if (r < bossChance + iceChance) type = 'ice';
  else if (r < bossChance + iceChance + goldChance) type = 'gold';

  // ✅ NEW: 隕石瞄準「對應注音鍵」
  const targetKey = label;
  if (!keyPositions[targetKey]) return;
  const target = keyPositions[targetKey];

  // ✅ NEW: 掉落方向規則（避免距離太短來不及按）
  // - 左邊的「聲母」(SHENGMU) → 從右側出現，飛向左側鍵盤區
  // - 右邊的「韻母/介音/聲調」→ 從左側出現，飛向右側鍵盤區
  const fromLeft = !SHENGMU.has(label); // 非聲母 → 視為右側群組 → 從左邊出現

  const startX = fromLeft ? -60 : W + 60;
  const startY = -80;

  const targetX = target.x;
  const targetY = target.y - 120;

  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.hypot(dx, dy) || 1;

  const baseSpeed = 2.2;
  const typeSpeed = (type === 'boss') ? 1.9 : (type === 'ice' ? 2.35 : baseSpeed);

  const vx = (dx / len) * typeSpeed;
  const vy = (dy / len) * typeSpeed;

  const hp = (type === 'boss') ? 3 : 1;
  const sizeMul = (type === 'boss') ? 1.35 : (type === 'gold' ? 1.08 : (type === 'ice' ? 1.08 : 1.0));

  // ✅ NEW: Boss 出現警告
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
}
  function drawBackground(){
    ctx.clearRect(0,0,W,H);
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
    if (t >= 1) { explosions.splice(i, 1); continue; }
    const r = 20 + t * 110;

    ctx.save();
    ctx.globalAlpha = 1 - t;

    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.stroke();

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,215,0,0.8)';
    ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.6, 0, Math.PI * 2); ctx.stroke();

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

  // 連擊能量條 / 雙倍分數狀態
  ctx.save();
  const barX = 26;
  const barY = Math.max(150, H - 250);
  const barW = Math.min(360, Math.max(240, W * 0.22));
  const barH = 22;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = comboBoostActive ? 'rgba(255,215,80,0.96)' : 'rgba(80,220,255,0.96)';
  ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, comboEnergy / 100)), barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 2;
  ctx.strokeRect(barX, barY, barW, barH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(comboBoostActive ? '⚡ 雙倍分數中' : '⚡ 連擊能量', barX, barY - 8);

  if (comboBoostActive) {
    const remain = Math.max(0, Math.ceil((comboBoostUntil - now) / 1000));
    ctx.fillStyle = 'rgba(255,245,180,0.98)';
    ctx.font = 'bold 20px system-ui';
    ctx.fillText(`x2 剩餘 ${remain} 秒`, barX + barW + 18, barY + barH - 1);
  }
  ctx.restore();

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
        if ((performance.now() - m.born) <= 1500) missionStats.fastHits++;
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
    if(running){
      dangerMode = timeLeft <= DANGER_SECONDS;
      setDangerUI();
      const eventState = getEventState();
      const spawnRateMul = eventState?.spawnMul || 1;
      spawnTimer += 16;
      if (spawnTimer > (spawnInterval() * spawnRateMul)) { spawn(); spawnTimer = 0; }
      const f = 1 + 0.08 * (level - 1); // ✅ 等級加速，但不要太兇（0.08 比 0.1 更溫和）
const slow = (performance.now() < slowUntil) ? SLOW_FACTOR : 1;
const eventSlow = eventState?.globalSlow || 1;
const dangerBoost = dangerMode ? 1.15 : 1;
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
    earthHits.push({ t0: performance.now(), life: 220 });
    canvas.style.transform = `translate(${Math.random() < 0.5 ? -4 : 4}px, ${Math.random() < 0.5 ? -2 : 2}px)`;
    setTimeout(() => { canvas.style.transform = ''; }, 90);
  }
}
      draw();
    }
    if (!running && dangerMode) {
      dangerMode = false;
      setDangerUI();
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
      dangerMode = timeLeft <= DANGER_SECONDS;
      setDangerUI();
      if (dangerMode && !dangerAlertShown) {
        dangerAlertShown = true;
        toast && toast('🚨 最後 10 秒警報！');
      }
      if (eventTriggerTimes.length && timeLeft <= eventTriggerTimes[0] && lastEventTriggerTime !== eventTriggerTimes[0]) {
        lastEventTriggerTime = eventTriggerTimes.shift();
        triggerRoundEvent();
      }
      if (timeLeft === BOSS_PHASE_SECONDS) {
        showCenterNotice('👾 Boss 波次', 1500, 'boss');
      }
      if(timeLeft<=0 && !gameEnded){
      gameEnded = true;
      endGame();
    } },1000); }

  function showResult({correct, wrong, acc, speed, passed, livesLeft = lives, gameOver = false}){
    if ($('resCorrect')) $('resCorrect').textContent = correct;
    if ($('resWrong'))   $('resWrong').textContent   = wrong;
    if ($('resAcc'))     $('resAcc').textContent     = Math.round(acc*100) + '%';
    if ($('resSpeed'))   $('resSpeed').textContent   = Math.round(speed);

    const promoEl = $('resPromo');
    if (promoEl) {
      const missionLine = activeMission
        ? (activeMission.completed
            ? `｜🎯 ${activeMission.title} 已完成`
            : `｜🎯 ${activeMission.title} ${activeMission.progress}/${activeMission.target}`)
        : '';
      if (gameOver) {
        promoEl.textContent = '💀 愛心用完' + missionLine;
      } else if (passed) {
        promoEl.textContent = `✅ 達標（愛心 ${livesLeft}/${MAX_LIVES}）` + missionLine;
      } else {
        promoEl.textContent = `❌ 未達標（剩 ${livesLeft} 顆）` + missionLine;
      }
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
        freshBtn.textContent = '挑戰下一關';
        freshBtn.onclick = () => {
          closeResult();
          gameEnded = false;
          resetRoundState();
          startGame();
        };
      } else {
        freshBtn.textContent = '再挑戰本關';
        freshBtn.onclick = () => {
          closeResult();
          gameEnded = false;
          resetRoundState();
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

    if (classroomMode) {
      showResult({ correct, wrong, acc, speed, passed, livesLeft: lives, gameOver: false });
      try {
        if (me.sid) await submitBest(me.sid, score);
        await setBest();
      } catch (e) {
        console.warn('endGame submit/setBest fail', e);
      }
      resetRoundState();
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
      if (level < LEVELS.length) level++;
      lives = Math.min(MAX_LIVES, lives + 1);
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

    resetRoundState();
  }

  function restart(){
    resetWholeGame();
    if (classroomMode) classroomRoundStarted = true;
    startGame();
    updatePauseButton();
  }

  // 排行榜（教師按鈕在遊戲頁也可用）
  async function openLeader() {
    const closeBtn = $('btnCloseLeader');
    if (closeBtn) closeBtn.textContent = '結束';

    const tb = $('leaderBody'); if(!tb) return;
    const meta = $('leaderMeta');
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
    const panel = $('leader'); if(panel){ panel.classList.add('show'); panel.removeAttribute('hidden'); }
  }
  function closeLeader(){ 
    const p=$('leader'); 
    if(p){ p.classList.remove('show'); 
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
    if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
    if(e.key==='Escape'){ pauseGame(); return; }
    if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
  });

  // 初始化
  buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setLives(); setBest(); draw(); hideClassroomOverlay(); setModeChip('模式：自由練習', false); updatePauseButton(); requestAnimationFrame(step);
  window.addEventListener('beforeunload', () => { stopClassroomPolling(); stopHeartbeat(); });
});
