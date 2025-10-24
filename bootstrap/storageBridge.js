// bootstrap/storageBridge.js
// 作用：在啟動時，將 repo 內的 ./data 目錄「橋接」到可持久化的存放處。
// - 若 Railway 有 Volume：使用 <RAILWAY_VOLUME_MOUNT_PATH>/stain-bot
// - 若尚未開 Volume：暫用 /app/data/stain-bot
// - 自動建立 backup 目錄
// - 第一次會把現有 data/ 內的 customers.json、orders.json 等檔案複製到持久化目錄
// - 嘗試用 symlink 讓原本程式不用改路徑；若 symlink 失敗，仍會備份並提示你微調常數（備有訊息）

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
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
    if (s.mtimeMs > d.mtimeMs || s.size !== d.size) {
      fs.copyFileSync(src, dest);
    }
  } catch (e) {
    console.warn('⚠️ copyFileIfNewerOrMissing error:', e.message);
  }
}

function safeBackup(filePath, backupDir) {
  try {
    if (!fs.existsSync(filePath)) return;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const base = path.basename(filePath);
    const dest = path.join(backupDir, `${base}.${ts}.bak`);
    fs.copyFileSync(filePath, dest);
  } catch (e) {
    console.warn('⚠️ backup error:', e.message);
  }
}

(function bridgeDataDir() {
  try {
    const projectRoot = process.cwd();
    const repoDataDir = path.join(projectRoot, 'data'); // 你原本的資料夾（大多數檔案都用 ../data/... 指到這）
    const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;

    // ① 選擇最終持久化根目錄
    const persistentRoot = volumeRoot
      ? path.join(volumeRoot, 'stain-bot')
      : path.join('/app', 'data', 'stain-bot');

    const backupDir = path.join(persistentRoot, 'backup');

    ensureDir(persistentRoot);
    ensureDir(backupDir);

    // ② 把 repoDataDir 內常見檔案備份到 backup，並複製到 persistentRoot
    const candidates = [
      'customers.json',
      'orders.json',
      'templates.json',
      // 你有其它自訂檔就加進來
    ];

    ensureDir(repoDataDir); // 若不存在，先建起來避免錯誤
    candidates.forEach((name) => {
      const src = path.join(repoDataDir, name);
      const dst = path.join(persistentRoot, name);
      if (fs.existsSync(src)) {
        // 先備份一份 repo 內檔案
        safeBackup(src, backupDir);
        // 再把較新的（或不存在的）同步到持久化目錄
        copyFileIfNewerOrMissing(src, dst);
      }
    });

    // ③ 若持久化目錄有較新檔案，也同步回 repoDataDir（確保你本地讀起來有資料）
    candidates.forEach((name) => {
      const src = path.join(persistentRoot, name);
      const dst = path.join(repoDataDir, name);
      copyFileIfNewerOrMissing(src, dst);
    });

    // ④ 嘗試用 symlink：讓 ./data 指向 persistentRoot
    //    這樣你既有程式用 ../data/*.json 的路徑完全不必改。
    let needSymlink = true;
    try {
      const stat = fs.lstatSync(repoDataDir);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(repoDataDir);
        if (path.resolve(target) === path.resolve(persistentRoot)) {
          needSymlink = false; // 已經是正確連結
        } else {
          fs.rmSync(repoDataDir, { recursive: true, force: true });
        }
      } else {
        // 真實資料夾，先移除（已備份與同步過）
        fs.rmSync(repoDataDir, { recursive: true, force: true });
      }
    } catch {
      // 不存在就繼續
    }

    if (needSymlink) {
      try {
        fs.symlinkSync(persistentRoot, repoDataDir, 'dir');
        console.log(`🔗 data/ 已連結到持久化目錄：${persistentRoot}`);
      } catch (e) {
        // 有些環境（極少數）不允許建立 symlink
        console.warn('⚠️ 無法建立 symlink，改為直接使用持久化目錄。原因：', e.message);
        // 提供一個環境變數給你在常數中切換（若你願意稍改常數定義）
        process.env.DATA_DIR_FALLBACK = persistentRoot;
        console.warn('ℹ️ 請將常數中的 ../data 改為使用 process.env.DATA_DIR_FALLBACK（見下方註解）。');
      }
    }

    // ⑤ 額外：在每次寫入前你若用到原本的檔案路徑，因為 symlink，實際會寫到 persistentRoot
    //    如 symlink 失敗且你不想改程式，也至少已經把最新檔同步與備份到 persistentRoot。
    console.log('✅ Storage bridge ready.');
    console.log('📦 PERSISTENT_ROOT =', persistentRoot);
    if (volumeRoot) console.log('🗄️ 使用 Railway Volume：', volumeRoot);
    else console.log('🗂️ 暫用容器內路徑（無 Volume）：/app/data/stain-bot');
  } catch (err) {
    console.error('❌ storageBridge 初始化失敗：', err);
  }
})();
