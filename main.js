// main.js — DOM Ready + 防呆 + 刪除模式

const API_BASE = "/api";

async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
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

  // ✅ 「刪除整筆」模式（含學號）
  adminClearClass(prefix, token){
    return jsonFetch(`${API_BASE}/admin/clear-class`, {
      method:"POST",
      headers:{ "x-teacher-token": token },
      body: JSON.stringify({ classPrefix: prefix, mode: "delete" })
    });
  },
  adminClearAll(token){
    return jsonFetch(`${API_BASE}/admin/clear-all`, {
      method:"POST",
      headers:{ "x-teacher-token": token },
      body: JSON.stringify({ mode: "delete" })
    });
  }
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
  // ====== NEW: Combo / 爆炸特效 / 黃金隕石 ======
  let combo = 0;
  let maxCombo = 0;
  const explosions = []; // {x,y,t0,life}
  const lasers = []; // {x1,y1,x2,y2,t0,life,kind}

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
  const BOSS_CHANCE = 0.04; // Boss 隕石機率（4%）

  // 冰凍效果：打到冰凍隕石 → 所有隕石慢動作幾秒
  let slowUntil = 0;          // performance.now() 的時間戳
  const SLOW_MS = 3200;       // 慢動作持續時間
  const SLOW_FACTOR = 0.45;   // 速度倍率（0.45 = 變慢）
  let me={sid:null,name:''};
  let teacherToken="";

  const setUserChip=()=>$('userChip') && ($('userChip').textContent=me.sid?`${me.sid}`:'未登入');
  const setScore=()=>$('score') && ($('score').textContent=score);
  const setTime =()=>$('time') && ($('time').textContent=timeLeft);

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
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ',null]
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
        b.textContent = '⏸ 暫停';
        b.onclick = () => toggleRun();
      } else if (ch === '__END__') {
        b.className = 'key control';
        b.textContent = '⏹ 結束';
        b.onclick = () => endAndShowLeader();
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

  // 四種隕石機率（其餘就是 normal）
  let type = 'normal';
  const r = Math.random();
  if (r < BOSS_CHANCE) type = 'boss';
  else if (r < BOSS_CHANCE + ICE_CHANCE) type = 'ice';
  else if (r < BOSS_CHANCE + ICE_CHANCE + GOLD_CHANCE) type = 'gold';

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

  meteors.forEach(m=>{

    ctx.save();
    ctx.translate(m.x, m.y);

    const baseSize = 300;
    const size = baseSize * (m.sizeMul || 1);

    // 外圈提示（幫學生辨識）
    if (m.type === 'gold') {
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255,215,0,0.85)';
      ctx.beginPath(); ctx.arc(0,0,size*0.48,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (m.type === 'ice') {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(120,220,255,0.85)';
      ctx.beginPath(); ctx.arc(0,0,size*0.48,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (m.type === 'boss') {
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

    // ✅ 視覺中心點（Visual Center）校正：
    // 圖檔左側有火焰拖尾，幾何中心不等於石頭本體中心。
    // 以前用 xOffset/yOffset 去「移動文字」，現在改成「移動圖片」，讓 (0,0) 就是石頭中心。
    // 這樣翻轉時文字不會跑掉，永遠保持置中。
    const IMG_SHIFT_X = -0.08 * size; // 往左移一點，讓石頭本體回到中心
    const IMG_SHIFT_Y = -0.15 * size; // 往上移一點，讓石頭本體回到中心

    if (ok) {
      // 只翻轉圖片，不翻轉文字：用 save/restore 把翻轉限制在 drawImage 這一小段
      ctx.save();
      if (flipX) ctx.scale(-1, 1);
      ctx.drawImage(meteorImgs[key], -size/2 + IMG_SHIFT_X, -size/2 + IMG_SHIFT_Y, size, size);
      ctx.restore();
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
    ctx.font='bold 100px system-ui';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.lineWidth=5;
    ctx.strokeStyle='rgba(0,0,0,.6)';

    // ✅ 視覺中心點校正後，文字直接畫在 (0,0) 就是隕石本體中心
    ctx.strokeText(m.label, 0, 0);
    ctx.fillStyle='#fff';
    ctx.fillText(m.label, 0, 0);

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

  // 冰凍提示
  if (isSlow) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(18, 18, 220, 52);
    ctx.fillStyle = '#bff6ff';
    ctx.font = 'bold 28px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('❄️ 冰凍慢動作！', 30, 44);
    ctx.restore();
  }

  // ✅ NEW: Combo 火焰提示（連擊 ≥ 5 才顯示）
  if (combo >= 5) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.font = 'bold 64px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,165,0,0.95)';
    ctx.fillText(`🔥 COMBO ${combo} (x2)`, W * 0.5, 18);
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

      const rt = performance.now() - m.born;
      const pts = calcPoints(rt);

      // 黃金隕石固定高分
      const basePts = (m.type === 'gold') ? 5 : pts;

      // Combo >= 5 進入 x2
      const mult = (combo >= 5) ? 2 : 1;

      score += basePts * mult;
      correct++;
      setScore();

      if (m.type === 'gold') {
        toast && toast(`✨ 黃金 +${basePts * mult}${mult===2 ? '（COMBO x2）' : ''}`);
      } else if (m.type === 'boss' && !removed) {
        toast && toast(`💥 Boss 命中！剩 ${m.hp} 血`);
      } else if (mult === 2) {
        toast && toast(`🔥 COMBO x2 +${basePts * mult}`);
      } else {
        toast && toast(`✅ +${basePts}（${Math.round(rt)}ms）`);
      }
    }else{
      // 打錯：連擊歸零
      combo = 0;

      score = Math.max(0, score-1); wrong++;
      setScore(); toast && toast('❌ -1');
    }
  }

  function step(){
    if(running){
      spawnTimer += 16;
      if (spawnTimer > spawnInterval()) { spawn(); spawnTimer = 0; }
      const f = 1 + 0.08 * (level - 1); // ✅ 等級加速，但不要太兇（0.08 比 0.1 更溫和）
const slow = (performance.now() < slowUntil) ? SLOW_FACTOR : 1;
meteors.forEach(m => {
  m.x += m.vx * 2 * f * slow;
  m.y += m.vy * 2 * f * slow;
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
  }
}
      draw();
    }
    requestAnimationFrame(step);
  }

  function startGame(){ if(!me.sid){ toast && toast('請先登入'); return; } running=true; ticker(); }
  function pauseGame(){ running=false; }
  function toggleRun(){ running?pauseGame():startGame(); }
// ✅ 結束：顯示排行榜後「自動重新開始」
// 做法：先停下遊戲 → 送出最佳分數 → 打開排行榜 → 當排行榜關閉時重開
let leaderAutoRestart = false;

async function endAndShowLeader(){
  if (!me.sid) { toast && toast('請先登入'); return; }
  running = false;
  clearInterval(timerId);
  leaderAutoRestart = true;

  // 結束時也送出 best（避免學生按結束就沒記到）
  try { await submitBest(me.sid, score); } catch {}
  await setBest();

  // 不顯示「打字結果」彈窗，直接看排行榜
  closeResult();
  await openLeader();
}

  let timerId=null;
  function ticker(){ clearInterval(timerId); timerId=setInterval(()=>{ if(!running) return; timeLeft--; setTime(); if(timeLeft<=0) endGame(); },1000); }

  function showResult({correct, wrong, acc, speed, passed}){
    if ($('resCorrect')) $('resCorrect').textContent = correct;
    if ($('resWrong'))   $('resWrong').textContent   = wrong;
    if ($('resAcc'))     $('resAcc').textContent     = Math.round(acc*100) + '%';
    if ($('resSpeed'))   $('resSpeed').textContent   = Math.round(speed);
    if ($('resPromo'))   $('resPromo').textContent   = passed ? '✅ 達標' : '❌ 未達標';

    const btn = $('resultPrimaryBtn');
    if (btn) {
      const freshBtn = btn.cloneNode(true);
      btn.replaceWith(freshBtn);
      if (passed) {
        freshBtn.textContent = '挑戰下一關';
        freshBtn.onclick = () => { closeResult(); startGame(); };
      } else {
        freshBtn.textContent = '重新開始';
        freshBtn.onclick = () => { closeResult(); restart(); };
      }
    }
    if ($('resultBox')) $('resultBox').style.display = 'flex';
  }
  function closeResult(){ if ($('resultBox')) $('resultBox').style.display='none'; }

  async function endGame(){
    running = false; clearInterval(timerId);

    const dur = (LEVELS[level-1]?.duration) || 60;
    const elapsed = dur - Math.max(0, timeLeft);
    const minutes = Math.max(1, elapsed) / 60;
    const acc = (correct + wrong) ? (correct / (correct + wrong)) : 0;
    const speed = correct / minutes;
    const passed = acc >= ACC_THRESHOLD;

    showResult({ correct, wrong, acc, speed, passed });

    if (me.sid) await submitBest(me.sid, score);
    await setBest();

    if (passed && level < LEVELS.length) level++;
    correct = 0; wrong = 0; combo = 0; meteors.length = 0; lasers.length = 0;
    timeLeft = (LEVELS[level-1]?.duration) || 60; setTime(); draw();
  }

  function restart(){
    level=1; score=0; correct=0; wrong=0; combo=0; maxCombo=0; explosions.length=0; lasers.length=0;
    timeLeft=(LEVELS[level-1]?.duration)||60; setScore(); setTime();
    meteors=[]; draw(); closeResult(); startGame();
  }

  // 排行榜（教師按鈕在遊戲頁也可用）
  async function openLeader() {
    const closeBtn = $('btnCloseLeader');
if (closeBtn) closeBtn.textContent = leaderAutoRestart ? '關閉並重新開始' : '關閉';

    const tb = $('leaderBody'); if(!tb) return;
    try {
      const data = await API.leaderboard(50);
      tb.innerHTML = data.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
    }
    const panel = $('leader'); if(panel){ panel.classList.add('show'); panel.removeAttribute('hidden'); }
  }
  function closeLeader(){ 
    const p=$('leader'); 
    if(p){ p.classList.remove('show'); 
      p.setAttribute('hidden',''); 
    } 
  if (leaderAutoRestart) {
  leaderAutoRestart = false;
  restart();
}
}

  async function loadClasses(){ try{ const resp=await API.getClasses(); const box=$('classList'); if(!box) return; box.innerHTML=""; resp.data.forEach(c=>{ const btn=document.createElement('button'); btn.className='tag'; btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`; btn.onclick=()=>{ const cp=$('classPrefix'); if(cp){ cp.value=c.class; loadClassRank(); } }; box.appendChild(btn); }); }catch(e){ toast && toast('載入班級清單失敗'); } }
  async function loadAllRank(){ const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function loadClassRank(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請輸入正確的班級前三碼'); return; } const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit,p); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function clearClass(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼'); return; } if(!confirm(`確認清除 ${p} 班全部紀錄（含學號）？`)) return; try{ await API.adminClearClass(p,teacherToken); toast && toast(`已清除 ${p} 班`); await loadClassRank(); }catch(e){ alert('清除失敗：'+e.message); } }
  async function clearAll(){ if(!confirm('確認清除全部學生紀錄（含學號）？')) return; try{ await API.adminClearAll(teacherToken); toast && toast('已清除全部學生紀錄'); await loadAllRank(); }catch(e){ alert('清除失敗：'+e.message); } }

  // 綁定 UI（存在才綁）
  $('btnStart')        && ($('btnStart').onclick=toggleRun);
  $('btnShowLeader')   && ($('btnShowLeader').onclick=openLeader);
  $('btnRestart')      && ($('btnRestart').onclick=()=>{ closeLeader(); closeResult(); restart(); });
  $('btnCloseLeader')  && ($('btnCloseLeader').onclick=closeLeader);
  $('btnRestartGame')  && ($('btnRestartGame').onclick=()=>{ closeLeader(); restart(); });

  $('go') && ($('go').onclick = async () => {
    let sid = $('sid').value.trim().replace(/\D/g,'');
    if (!/^\d{5}$/.test(sid)) { alert('請輸入5位數學號'); return; }
    me.sid = sid; me.name = '';
    try { await API.upsertStudent({ sid }); } catch (e) { alert('登入失敗：' + e.message); return; }
    setUserChip(); await setBest();
    if ($('login')) $('login').style.display='none';
    score=0; correct=0; wrong=0; combo=0; maxCombo=0; explosions.length=0; lasers.length=0; level=1;
    timeLeft=(LEVELS[level-1]?.duration)||60;
    setScore(); setTime(); meteors=[]; draw();
// ✅ 登入後自動開始
startGame();

  });

  $('teacherOpen') && ($('teacherOpen').onclick = () => { /* 預設超連結就會導去 /teacher */ });

  // 實體鍵盤
  addEventListener('keydown',e=>{
    if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
    if(e.key==='Escape'){ pauseGame(); return; }
    if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
  });

  // 初始化
  buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
});

/* ===== Admin Clear Utilities (for game page) =====
   作用：
   - 與 teacher.js 相同：固定帶 Content-Type 與 x-teacher-token
   - 401 會自動清掉 token，提醒重新輸入
   - 400 會把後端的錯誤訊息完整 alert 出來（便於查欄位/規則）
   用法：
   - window.clearClassFromGame('101')   // 清 101 班（含學號）
   - window.clearAllFromGame()          // 清全部（含學號）
   - 若頁面上有 #btnClearClass / #btnClearAll，會自動綁定
*/

function getTeacherToken() {
  return localStorage.getItem('teacher_token') || '';
}

function showTeacherLock() {
  // 遊戲頁通常沒有鎖定層，這裡保留掛鉤避免報錯
  if (typeof showLock === 'function') showLock();
}

async function adminJsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    let msg = '';
    try { msg = await res.text(); } catch (e) {}
    if (res.status === 401) {
      localStorage.removeItem('teacher_token');
      showTeacherLock();
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? ' - ' + msg : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const AdminAPI = {
  clearClass: (classPrefix, token) =>
    adminJsonFetch('/api/admin/clear-class', {
      method: 'POST',
      headers: { 'x-teacher-token': token },
      body: JSON.stringify({ classPrefix, mode: 'delete' })
    }),
  clearAll: (token) =>
    adminJsonFetch('/api/admin/clear-all', {
      method: 'POST',
      headers: { 'x-teacher-token': token },
      body: JSON.stringify({ mode: 'delete' })
    })
};

// 導出給 console 或其他模組呼叫
window.clearClassFromGame = async function (prefix) {
  const p = String(prefix || '').trim();
  const token = getTeacherToken();
  if (!token) { showTeacherLock(); alert('請先在教師後台輸入教師密碼。'); return; }
  if (!/^\d{3}$/.test(p)) { alert('請輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  if (!confirm(`確認要清除 ${p} 班全部學生紀錄（含學號）？`)) return;

  try {
    await AdminAPI.clearClass(p, token);
    alert(`已清除 ${p} 班紀錄`);
    // 若遊戲頁也有排行榜刷新函式，可在此呼叫
    if (typeof refreshLeaderboard === 'function') refreshLeaderboard();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請回教師後台重新輸入。');
    } else {
      alert('清除失敗：' + e.message); // 會包含 400 的詳細原因
    }
  }
};

window.clearAllFromGame = async function () {
  const token = getTeacherToken();
  if (!token) { showTeacherLock(); alert('請先在教師後台輸入教師密碼。'); return; }
  if (!confirm('確認要「清除全部學生紀錄（含學號）」嗎？')) return;

  try {
    await AdminAPI.clearAll(token);
    alert('已清除全部學生紀錄');
    if (typeof refreshLeaderboard === 'function') refreshLeaderboard();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請回教師後台重新輸入。');
    } else {
      alert('清除失敗：' + e.message);
    }
  }
};

// 如果頁面上剛好有按鈕，幫你自動綁定（沒有也不會報錯）
(function autoBindAdminButtons(){
  const btnC = document.getElementById('btnClearClass');
  const btnA = document.getElementById('btnClearAll');
  const inputP = document.getElementById('classPrefix');
  if (btnC && inputP) {
    btnC.addEventListener('click', () => window.clearClassFromGame(inputP.value));
  }
  if (btnA) {
    btnA.addEventListener('click', () => window.clearAllFromGame());
  }
})();
