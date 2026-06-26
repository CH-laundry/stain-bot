const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const GAME_DATA_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data', 'game-data.json');

// 讀取遊戲資料
function loadGameData() {
  try {
    if (fs.existsSync(GAME_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(GAME_DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

// 儲存遊戲資料
function saveGameData(data) {
  fs.writeFileSync(GAME_DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 取得玩家資料
router.get('/api/game/player/:userId', (req, res) => {
  const { userId } = req.params;
  const allData = loadGameData();
  
  if (!allData[userId]) {
    // 新玩家初始資料
    allData[userId] = {
      userId,
      coins: 0,
      level: 1,
      exp: 0,
      totalWashes: 0,
      stainSolved: 0,
      createdAt: new Date().toISOString()
    };
    saveGameData(allData);
  }
  
  res.json({ success: true, player: allData[userId] });
});

// 更新玩家金幣（送洗連動用）
router.post('/api/game/add-coins', (req, res) => {
  const { userId, coins, reason } = req.body;
  if (!userId || !coins) return res.json({ success: false, error: '缺少參數' });
  
  const allData = loadGameData();
  if (!allData[userId]) {
    allData[userId] = { userId, coins: 0, level: 1, exp: 0, totalWashes: 0, stainSolved: 0, createdAt: new Date().toISOString() };
  }
  
  allData[userId].coins += parseInt(coins);
  allData[userId].lastCoinReason = reason || '';
  allData[userId].lastCoinAt = new Date().toISOString();
  saveGameData(allData);
  
  console.log(`[Game] ${userId} 獲得 ${coins} 金幣（${reason}）`);
  res.json({ success: true, newTotal: allData[userId].coins });
});

// 污漬解謎答題
router.post('/api/game/stain-quiz', (req, res) => {
  const { userId, questionId, answer } = req.body;
  
  // 題庫
  const questions = {
    q1: { correct: 'A', reward: 50 },
    q2: { correct: 'C', reward: 50 },
    q3: { correct: 'B', reward: 50 },
  };
  
  const q = questions[questionId];
  if (!q) return res.json({ success: false, error: '題目不存在' });
  
  const isCorrect = answer === q.correct;
  
  if (isCorrect && userId) {
    const allData = loadGameData();
    if (!allData[userId]) {
      allData[userId] = { userId, coins: 0, level: 1, exp: 0, totalWashes: 0, stainSolved: 0, createdAt: new Date().toISOString() };
    }
    allData[userId].coins += q.reward;
    allData[userId].stainSolved = (allData[userId].stainSolved || 0) + 1;
    saveGameData(allData);
  }
  
  res.json({ success: true, correct: isCorrect, reward: isCorrect ? q.reward : 0 });
});

// 遊戲頁面
router.get('/game', (req, res) => {
  res.sendFile('game.html', { root: './public' });
});

module.exports = router;
