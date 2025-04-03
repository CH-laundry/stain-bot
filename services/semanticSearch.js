const { getEmbedding } = require("./openai");
const { fetchFAQFromSheet } = require("./faqFetcher");

let faqList = [];
let embeddings = [];

async function loadFAQs() {
  faqList = await fetchFAQFromSheet();
  embeddings = await Promise.all(
    faqList.map(item => getEmbedding(item.keywords + " " + item.answer))
  );
}

function cosineSimilarity(vec1, vec2) {
  const dot = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
  const norm1 = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
  const norm2 = Math.sqrt(vec2.reduce((sum, v) => sum + v * v, 0));
  return dot / (norm1 * norm2);
}

async function findSimilarAnswer(userInput, threshold = 0.85) {
  if (faqList.length === 0 || embeddings.length === 0) {
    await loadFAQs();
  }

  const inputVec = await getEmbedding(userInput);
  let bestScore = -1;
  let bestAnswer = null;

  embeddings.forEach((vec, i) => {
    const score = cosineSimilarity(inputVec, vec);
    if (score > bestScore) {
      bestScore = score;
      bestAnswer = faqList[i].answer;
    }
  });

  return bestScore >= threshold ? bestAnswer : null;
}

module.exports = { findSimilarAnswer };
