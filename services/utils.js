// services/utils.js
function isOneKey(s) {
  if (typeof s !== 'string') return false;
  const x = s.trim();
  return x === '1' || x === '１' || x === '①' || x === '一' || x === '壹';
}

function isTwoKey(s) {
  if (typeof s !== 'string') return false;
  const x = s.trim();
  return x === '2' || x === '２' || x === '②' || x === '二' || x === '貳';
}

module.exports = { isOneKey, isTwoKey };
