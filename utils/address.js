class AddressDetector {
    static isAddress(text) {
        const addressPatterns = [
            /\d+號/,
            /路|街|巷|弄|樓/,
            /市|區|鎮|鄉|村/
        ];

        const hasAddressPattern = addressPatterns.some(p => p.test(text));
        const isLongEnough = text.length >= 8;

        console.log(`地址检测 - 文本: ${text}, 包含地址特征: ${hasAddressPattern}, 长度足够: ${isLongEnough}`);

        return (hasAddressPattern && isLongEnough) || /路|巷|號|樓/.test(text);
    }

    static formatResponse(address) {
        let addressMatch = address;

        if (/^\d+\s+.*?\s+/.test(address)) {
            addressMatch = address.replace(/^\d+\s+.*?\s+/, '');
        }

        console.log(`地址格式化 - 原始: ${address}, 格式化后: ${addressMatch}`);

        return {
            formattedAddress: addressMatch,
            response: `可以的😊我們會到 ${addressMatch} 收送，送達會再通知您🚚💨`
        };
    }
}

module.exports = AddressDetector;