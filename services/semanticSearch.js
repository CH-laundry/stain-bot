const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { getEmbedding } = require("./openai");

let replyData = [];
let embeddings = [];

async function loadReplyCSV() {
  const filePath = path.join(__dirname, "..", "reply.csv");
  replyData = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (row["回應內容"] && row["負責詞列表（更多寫法）"]) {
          replyData.push({
            keywords: row["負責詞列表（更多寫法）"],
            answer: row["回應內容"]
          });
        }
      })
      .on("end", async () => {
        embeddings = await Promise.all(
          replyData.map((item) => getEmbedding(item.keywords + " " + item.answer))
        );
        resolve();
      })
      .on("error", reject);
  });
}

function cosineSimilarity(vec1, vec2) {
  const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
  const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
  const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));
  return dot / (norm1 * norm2);
}

/**
 * 傳入 userInput，找語意相近的表格回答（若分數不夠高，回 null → 交給 GPT）
 * @param {string} userInput
 * @returns {Promise<{answer: string, source: string} | null>}
 */
async function findSimilarAnswer(userInput) {
  if (replyData.length === 0 || embeddings.length === 0) {
    await loadReplyCSV();
  }

  const userVec = await getEmbedding(userInput);
  let bestIndex = 0;
  let bestScore = -1;

  embeddings.forEach((vec, index) => {
    const score = cosineSimilarity(userVec, vec);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  const threshold = 0.9;
  if (bestScore >= threshold) {
    return {
      answer: replyData[bestIndex].answer,
      source: "semantic"
    };
  }

  return null; // 語意分數不夠高，交給 GPT 回答
}

module.exports = {
  findSimilarAnswer
};
