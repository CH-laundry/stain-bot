// public/ai-town/assets/ai-engine.js
;(() => {
  const TILE = 48;              // 每格像素
  const COLS = 16;              // 地圖寬
  const ROWS = 9;               // 地圖高
  const W = COLS * TILE;
  const H = ROWS * TILE;

  // 簡易地圖(0=草地,1=水)
  const MAP = [
    // 16 欄 × 9 列
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,
    0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,
    0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,
    0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
  ];

  // 人物定義（id 對應 agents.js）
  const AGENTS = [
    { id: 'cs',      name: '小C.H客服', emoji: '💬', color: '#7c3aed', x: 2,  y: 6 },
    { id: 'cleaner', name: '清潔師傅',   emoji: '🧼', color: '#22c55e', x: 5,  y: 4 },
    { id: 'iron',    name: '熨燙師傅',   emoji: '👔', color: '#f59e0b', x: 8,  y: 6 },
    { id: 'runner',  name: '收送人員',   emoji: '🚚', color: '#38bdf8', x: 12, y: 5 },
    { id: 'manager', name: '店長',       emoji: '🏪', color: '#eab308', x: 10, y: 2 },
  ];

  // 取得畫布
  const stage = document.getElementById('stage');
  if (!stage) return; // 頁面沒有舞台就不啟動
  const ctx = stage.getContext('2d', { alpha: false });
  resizeCanvas();

  // 窗口自適應（固定比例縮放）
  function resizeCanvas(){
    stage.width  = W;
    stage.height = H;
    stage.style.width  = '100%';
    stage.style.maxWidth = '900px';
    stage.style.display = 'block';
    stage.style.margin = '12px auto';
    stage.style.borderRadius = '14px';
  }

  // 把網格座標轉像素
  const toPx = (v) => v * TILE + TILE/2;

  // 隨機走路控制
  AGENTS.forEach(a => {
    a.fx = toPx(a.x);
    a.fy = toPx(a.y);
    a.tx = a.fx;
    a.ty = a.fy;
    a.timer = 0;
  });

  // 每隔一段時間讓角色選一個鄰近格子移動（不能進水）
  function planMove(a, dt){
    a.timer -= dt;
    if (a.timer > 0) return;
    a.timer = 1200 + Math.random()*1500; // 1.2~2.7 秒

    const dirs = [
      {dx:  1, dy:  0}, {dx: -1, dy: 0},
      {dx:  0, dy:  1}, {dx:  0, dy: -1},
      {dx:  1, dy:  1}, {dx: -1, dy:-1},
      {dx:  1, dy: -1}, {dx: -1,dy: 1}
    ];
    for (let i=0;i<8;i++){
      const d = dirs[(Math.random()*dirs.length)|0];
      const nx = Math.max(0, Math.min(COLS-1, a.x + d.dx));
      const ny = Math.max(0, Math.min(ROWS-1, a.y + d.dy));
      if (tile(nx,ny) === 0) { // 只走草地
        a.x = nx; a.y = ny;
        a.tx = toPx(a.x);
        a.ty = toPx(a.y);
        break;
      }
    }
  }

  function tile(x,y){ return MAP[y*COLS+x] }

  // 點擊選角：找到最近的 agent
  stage.addEventListener('click', (e)=>{
    const rect = stage.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (stage.width/rect.width);
    const my = (e.clientY - rect.top)  * (stage.height/rect.height);
    let best = null, bd = 1e9;
    for (const a of AGENTS){
      const d = (a.fx-mx)**2 + (a.fy-my)**2;
      if (d < bd){ bd=d; best=a; }
    }
    if (best && bd <= (TILE*TILE*1.1)){  // 距離夠近才算點到
      // 呼叫前端選角（在 app.js 內我會把 selectAgent 掛到全域）
      if (typeof window.AITOWN_selectAgent === 'function'){
        window.AITOWN_selectAgent(best.id);
      }
      // 顯示一下名牌
      flashBalloon(best);
    }
  });

  let balloon = null;
  function flashBalloon(a){
    balloon = { text: a.name, x: a.fx, y: a.fy - 30, t: 1000 };
  }

  // 主迴圈
  let last = performance.now();
  function loop(now){
    const dt = now - last; last = now;

    // 移動規劃 & 緩動
    for (const a of AGENTS){
      planMove(a, dt);
      a.fx += (a.tx - a.fx) * 0.08;
      a.fy += (a.ty - a.fy) * 0.08;
    }
    draw(dt);
    requestAnimationFrame(loop);
  }

  function draw(dt){
    // 背景
    ctx.fillStyle = '#102039';
    ctx.fillRect(0,0,W,H);

    // 畫地圖
    for (let y=0;y<ROWS;y++){
      for (let x=0;x<COLS;x++){
        const k = tile(x,y);
        if (k===0){
          ctx.fillStyle = (x+y)%2 ? '#1a2f55' : '#17325d';
        } else {
          ctx.fillStyle = '#0d5b7a'; // 水面
        }
        ctx.fillRect(x*TILE, y*TILE, TILE, TILE);
      }
    }

    // 畫角色
    for (const a of AGENTS){
      // 外圈
      ctx.beginPath();
      ctx.fillStyle = a.color + 'AA';
      ctx.arc(a.fx, a.fy, 18, 0, Math.PI*2);
      ctx.fill();

      // 內圈
      ctx.beginPath();
      ctx.fillStyle = '#0b1220';
      ctx.arc(a.fx, a.fy, 14, 0, Math.PI*2);
      ctx.fill();

      // emoji
      ctx.font = '20px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.emoji, a.fx, a.fy);

      // 名稱（淡淡的）
      ctx.font = '10px "Noto Sans TC", system-ui';
      ctx.fillStyle = '#93c5fd';
      ctx.fillText(a.name, a.fx, a.fy + 26);
    }

    // 氣泡
    if (balloon){
      balloon.t -= dt;
      const alpha = Math.max(0, Math.min(1, balloon.t/1000));
      if (alpha <= 0) { balloon = null; }
      else {
        ctx.globalAlpha = alpha;
        roundRect(ctx, balloon.x-40, balloon.y-22, 80, 18, 8, '#0b1220', '#60a5fa');
        ctx.globalAlpha = 1;
      }
    }
  }

  function roundRect(ctx,x,y,w,h,r,fill,stroke){
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y,   x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x,   y+h, r);
    ctx.arcTo(x,   y+h, x,   y,   r);
    ctx.arcTo(x,   y,   x+w, y,   r);
    ctx.closePath();
    if (fill){ ctx.fillStyle = fill; ctx.fill(); }
    if (stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  requestAnimationFrame(loop);
})();
