class AddressDetector {
  static isAddress(text) {
    const addressPatterns = [
      /\d+號/, 
      /路|街|巷|弄|樓/,
      /市|區|鎮|鄉|村/
    ];
    return addressPatterns.some(p => p.test(text)) && text.length >= 10;
  }

  static formatResponse(address) {
    return `🚚 已收到地址：${address}\n我們將於1小時內前往收件！`;
  }
}

module.exports = AddressDetector;
