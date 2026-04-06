// bootstrap/storageBridge.js
// v2: 修復 ELOOP（避免 data/ 指向自己的子目錄）
// 策略：
// - 有 Volume: 使用 <RAILWAY_VOLUME_MOUNT_PATH>/stain-bot
// - 無 Volume: 使用 /app/.persist/stain-bot  (不放到 /app/data/ 裡，以免自我參照)
// - 若偵測到 data/ 是指向 data/* 的壞連結 -> 直接刪除並重建正確連結
// - 啟動時自動備份 repo 內 data/*.json 至 persistentRoot/backup/

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  // 若 dir 是壞 symlink，mkdir 會噴 ELOOP；這裡先處理在外層。
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFileIfNewerOrMissing(src, dest) {
  try {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      return;
    }
    const s = fs.statSync(src);
    const d = fs.statSync(dest);
    if (s.mtimeMs > d.mtimeMs || s.size !== d.size) fs.copyFileSync(src, dest);
  } catch (e) {
    console.warn('⚠️ copyFileIfNewerOrMissing:', e.message);
  }
}

function safeBackup(filePath, backupDir) {
  try {
    if (!fs.existsSync(filePath)) return;
    const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    const base = path.basename(filePath);
    const dest = path.join(backupDir, `${base}.${ts}.bak`);
    fs.copyFileSync(filePath, dest);
  } catch (e) {
    console.warn('⚠️ backup:', e.message);
  }
}

(function bridgeDataDir() {
  try {
    const projectRoot = process.cwd();
    const repoDataDir = path.join(projectRoot, 'data'); // 你的原始資料夾（程式都用 ../data）
    const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;

    // ★ 新的「安全」預設持久路徑（不在 /app/data 底下，避免循環）
    let persistentRoot = volumeRoot
      ? path.join(volumeRoot, 'stain-bot')
      : path.join('/app', '.persist', 'stain-bot');

    // 安全守門員：如果不小心把 persistent 設到 repoDataDir 裡，直接改到 /app/.persist
    const resolvedRepoDataDir = path.resolve(repoDataDir);
    const resolvedPersistent = path.resolve(persistentRoot);
    if (resolvedPersistent.startsWith(resolvedRepoDataDir + path.sep)) {
      // 這代表 persistent 指到 data/ 的子目錄 → 會造成 ELOOP；改用 /app/.persist
      persistentRoot = path.join('/app', '.persist', 'stain-bot');
    }

    // 先處理 data/ 如果是壞 symlink（指向 data/* 本身）
    let dataIsSymlink = false;
    try {
      const st = fs.lstatSync(repoDataDir);
      dataIsSymlink = st.isSymbolicLink();
      if (dataIsSymlink) {
        const target = fs.readlinkSync(repoDataDir);
        const absTarget = path.resolve(path.dirname(repoDataDir), target);

        // 如果目標在 data/ 之下，就刪掉，避免循環
        if (absTarget.startsWith(resolvedRepoDataDir + path.sep)) {
          fs.rmSync(repoDataDir, { recursive: true, force: true });
          dataIsSymlink = false;
          console.warn('🧹 已移除循環 symlink: data/ -> data/*');
        }
      }
    } catch { /* data/ 不存在也沒關係 */ }

    // 建立持久路徑與 backup
    ensureDir(persistentRoot);
    const backupDir = path.join(persistentRoot, 'backup');
    ensureDir(backupDir);

    // 先準備一個臨時「真實」資料夾（若 data/ 還不存在）
    if (!fs.existsSync(repoDataDir)) {
      fs.mkdirSync(repoDataDir, { recursive: true });
    }

    // 備份 repoDataDir 裡常見資料
    const candidates = ['customers.json', 'orders.json', 'templates.json'];
    candidates.forEach(name => {
      const src = path.join(repoDataDir, name);
      if (fs.existsSync(src)) safeBackup(src, backupDir);
    });

    // 同步 repo -> persistent（第一次啟動把既有資料帶過去）
    candidates.forEach(name => {
      const src = path.join(repoDataDir, name);
      const dst = path.join(persistentRoot, name);
      copyFileIfNewerOrMissing(src, dst);
    });

    // 同步 persistent -> repo（確保本地讀也有資料）
    candidates.forEach(name => {
      const src = path.join(persistentRoot, name);
      const dst = path.join(repoDataDir, name);
      copyFileIfNewerOrMissing(src, dst);
    });

    // 建立正確的 symlink：讓 ./data 指向 persistentRoot（注意：persistentRoot 不在 data/ 裡）
    // 先把現有的 data/（可能是真資料夾）移掉（已經備份與同步）
    try {
      const st = fs.lstatSync(repoDataDir);
      if (st.isSymbolicLink() || st.isDirectory()) {
        fs.rmSync(repoDataDir, { recursive: true, force: true });
      } else {
        fs.rmSync(repoDataDir, { force: true });
      }
    } catch { /* ignore */ }

    try {
      fs.symlinkSync(persistentRoot, repoDataDir, 'dir');
      console.log(`🔗 data/ → ${persistentRoot}`);
    } catch (e) {
      console.warn('⚠️ 無法建立 symlink，將直接使用持久路徑：', e.message);
      process.env.DATA_DIR_FALLBACK = persistentRoot;
      // 若你的程式有 ensureDataDirectory() 會 mkdir ../data，因為此時 data/ 可能不存在，
      // 請把常數改成使用 DATA_DIR_FALLBACK（見先前說明）。大多數情況 symlink 能成功，就不必改。
    }

    console.log('✅ Storage bridge ready.');
    console.log('📦 PERSISTENT_ROOT =', persistentRoot);
    if (volumeRoot) console.log('🗄️ 使用 Railway Volume：', volumeRoot);
    else console.log('🗂️ 暫用容器內路徑（無 Volume）：/app/.persist/stain-bot');
  } catch (err) {
    console.error('❌ storageBridge 初始化失敗：', err);
  }
})();
