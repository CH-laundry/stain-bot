const jwt = require('jsonwebtoken');
const axios = require('axios');
const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

// 產生 JWT Token
function generateKlingToken() {
  const payload = {
    iss: KLING_ACCESS_KEY,
    exp: Math.floor(Date.now() / 1000) + 1800,
    nbf: Math.floor(Date.now() / 1000) - 5
  };
  return jwt.sign(payload, KLING_SECRET_KEY, { algorithm: 'HS256' });
}

// 送出影片生成請求
async function createVideo(prompt) {
  const token = generateKlingToken();
  const response = await axios.post(
    'https://api.klingai.com/v1/videos/text2video',
    {
      model_name: 'kling-v1',
      prompt: prompt,
      duration: '10',
      aspect_ratio: '9:16'
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.data.task_id;
}

// 輪詢等待影片完成
async function waitForVideo(taskId) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 30000));
    const token = generateKlingToken();
    const res = await axios.get(
      `https://api.klingai.com/v1/videos/text2video/${taskId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const status = res.data.data.task_status;
    console.log(`輪詢 ${i + 1}：${status}`);
    if (status === 'succeed') {
      return res.data.data.task_result.videos[0].url;
    }
    if (status === 'failed') throw new Error('影片生成失敗');
  }
  throw new Error('等待超時');
}

// 下載影片 + 疊加 Logo
async function addLogoToVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const tmpVideo = '/tmp/raw_video.mp4';
    const tmpOutput = '/tmp/output_video.mp4';
    const logoPath = path.join(__dirname, 'logo.png');

    const file = fs.createWriteStream(tmpVideo);
    https.get(videoUrl, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        const cmd = `ffmpeg -y -i ${tmpVideo} -i ${logoPath} -filter_complex "[1]scale=120:-1[logo];[0][logo]overlay=W-w-20:H-h-20" -codec:a copy ${tmpOutput}`;
        exec(cmd, (error) => {
          if (error) {
            console.error('ffmpeg 失敗，使用原始影片:', error.message);
            resolve(videoUrl);
          } else {
            resolve(tmpOutput);
          }
        });
      });
    }).on('error', reject);
  });
}

module.exports = { createVideo, waitForVideo, addLogoToVideo };
