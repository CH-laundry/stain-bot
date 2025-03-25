class AddressDetector {
    /**
     * 从文本中提取地址信息
     * @param {string} text - 输入文本
     * @returns {string|null} - 提取到的地址或null
     */
    static extractAddress(text) {
        // 地址的基本组成部分
        const cityPattern = /(台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)(縣|市)/;
        const districtPattern = /(市區|[一-龥]{1,3}區|[一-龥]{1,3}市|[一-龥]{1,3}鎮|[一-龥]{1,3}鄉)/;
        const streetPattern = /([一-龥]+路|[一-龥]+街|[一-龥]+大道|[一-龥]+巷|[一-龥]+弄)/;
        const numberPattern = /(\d+號|\d+樓|\d+F|\d+-\d+號?|\d+之\d+號?)/;

        // 完整地址模式
        const fullAddressPattern = new RegExp(
            `${cityPattern.source}.*?${districtPattern.source}.*?${streetPattern.source}.*?${numberPattern.source}`,
            'g'
        );

        // 尝试匹配完整地址
        const matches = text.match(fullAddressPattern);
        if (matches) {
            return matches[0];
        }

        // 如果没有完整匹配，尝试提取部分地址
        const partialAddressPattern = new RegExp(
            `(${cityPattern.source}.*?${districtPattern.source}.*?${streetPattern.source}|` +
            `${districtPattern.source}.*?${streetPattern.source}.*?${numberPattern.source})`,
            'g'
        );

        const partialMatches = text.match(partialAddressPattern);
        if (partialMatches) {
            return partialMatches[0];
        }

        // 最后尝试匹配最基本的地址形式
        const basicAddressPattern = /[一-龥]{2,}(路|街|巷|弄)\d+號(\d+樓)?/g;
        const basicMatches = text.match(basicAddressPattern);
        if (basicMatches) {
            return basicMatches[0];
        }

        return null;
    }

    /**
     * 判断文本是否包含地址
     * @param {string} text - 输入文本
     * @returns {boolean} - 是否包含地址
     */
    static isAddress(text) {
        return this.extractAddress(text) !== null;
    }

    /**
     * 格式化地址并生成回复
     * @param {string} text - 输入文本
     * @returns {Object} - 格式化后的地址和回复消息
     */
    static formatResponse(text) {
        const extractedAddress = this.extractAddress(text);
        if (!extractedAddress) {
            return {
                formattedAddress: null,
                response: '抱歉，我無法識別您的地址，請重新輸入完整地址。'
            };
        }

        // 清理和格式化地址
        let formattedAddress = extractedAddress
            .replace(/\s+/g, '')  // 移除空格
            .replace(/０-９/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角数字转半角
            .replace(/[，,、]/g, '');  // 移除分隔符

        console.log(`地址格式化 - 原始文本: ${text}`);
        console.log(`提取地址: ${extractedAddress}`);
        console.log(`格式化后: ${formattedAddress}`);

        return {
            formattedAddress,
            response: `可以的😊我們會到 ${formattedAddress} 收送，送達會再通知您🚚💨`
        };
    }
}

module.exports = AddressDetector;