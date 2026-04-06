// scripts/inspectStorage.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR_FALLBACK || path.join(__dirname, '../data');
const PERSISTENT_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'stain-bot')
  : path.join('/app', '.persist', 'stain-bot');
const BACKUP_DIR = path.join(PERSISTENT_ROOT, 'backup');

const FILES = ['customers.json', 'orders.json', 'templates.json'];

function statOrNull(p) {
  try {
    const s = fs.statSync(p);
    return {
      path: p,
      isFile: s.isFile(),
      size: s.size,
      mtime: s.mtime,
    };
  } catch { return null; }
}

function listOrEmpty(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

console.log('=== Storage Inspect ===');
console.log('RAILWAY_VOLUME_MOUNT_PATH =', process.env.RAILWAY_VOLUME_MOUNT_PATH || '(undefined)');
console.log('DATA_DIR_FALLBACK        =', process.env.DATA_DIR_FALLBACK || '(undefined)');
console.log('DATA_DIR                 =', DATA_DIR);
console.log('PERSISTENT_ROOT          =', PERSISTENT_ROOT);
console.log('BACKUP_DIR               =', BACKUP_DIR);
console.log('');

console.log('--- Paths Stat ---');
console.log('DATA_DIR       :', statOrNull(DATA_DIR));
console.log('PERSISTENT_ROOT:', statOrNull(PERSISTENT_ROOT));
console.log('BACKUP_DIR     :', statOrNull(BACKUP_DIR));
console.log('');

console.log('--- Files Stat ---');
for (const f of FILES) {
  const p1 = path.join(DATA_DIR, f);
  console.log(`${f}:`, statOrNull(p1));
}
console.log('');

console.log('--- Persistent Root Listing ---');
console.log(listOrEmpty(PERSISTENT_ROOT));
console.log('');

console.log('--- Backup Listing (top 10) ---');
console.log(listOrEmpty(BACKUP_DIR).slice(0, 10));
console.log('');

console.log('✅ Inspect done.');
