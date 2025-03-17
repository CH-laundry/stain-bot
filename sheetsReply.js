const exceljs = require('exceljs');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');

class SheetsReply {
  constructor() {
    this.qaData = [];
  }

  async loadData() {
    const workbook = new exceljs.Workbook();
    // 使用相对路径，更容易在不同环境中运行
    const filePath = path.resolve('./CH資料庫.xlsx');
    
    try {
      // 验证文件是否存在
      console.log('文件存在:', fs.existsSync(filePath));
      console.log('加载文件路径:', filePath);

      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.getWorksheet(1);

      this.qaData = [];
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // 跳过表头

        const formulaCell = row.getCell(2); // B列是公式
        const answerCell = row.getCell(3);  // C列是回答

        // 调试日志：原始公式
        const rawFormula = formulaCell.formula || '';
        console.log(`\n=== 处理第 ${rowNumber} 行 ===`);
        console.log('原始公式:', rawFormula);

        // 深度清洗公式（关键修复）
        const cleanedFormula = this.deepCleanFormula(rawFormula);
        console.log('清洗后:', cleanedFormula);

        // 提取所有正则表达式
        const regexPatterns = this.extractRegexPatterns(cleanedFormula);
        console.log('提取结果:', regexPatterns);

        const answer = answerCell.text.replace(/\\n/g, '\n') || '';

        if (regexPatterns.length > 0 && answer) {
          this.qaData.push({
            pattern: new RegExp(regexPatterns.join('|'), 'i'),
            answer
          });
          console.log(`✅ 规则加载成功`);
        } else {
          console.log('❌ 无效规则');
        }
      });

      // 按关键词数量排序
      this.qaData.sort((a, b) => 
        b.pattern.source.split('|').length - a.pattern.source.split('|').length
      );

      console.log(`✅ 成功加载 ${this.qaData.length} 条规则`);
      return true;

    } catch (error) {
      console.error('加载失败:', error);
      return false;
    }
  }

  // ==== 关键方法 ====
  deepCleanFormula(formula) {
    return formula
      // 完全移除Google Sheets兼容性函数
      .replace(/IFERROR\(__xludf\.DUMMYFUNCTION\(/gi, '')
      .replace(/\)\,\s*"[^"]*"\)/g, '') // 动态匹配任意结尾参数
      // 处理多层嵌套引号
      .replace(/"{2,}/g, '"')
      // 移除字符串连接符
      .replace(/"\s*&\s*"/g, '')
      // 标准化空格
      .replace(/\s+/g, '');
  }

  extractRegexPatterns(formula) {
    // 增强正则匹配（支持任意层嵌套引号）
    const regex = /REGEXMATCH\(A\d+,\s*"((?:\\"|""|[^"])+)"\)/gi;
    const matches = [];
    let match;

    while ((match = regex.exec(formula)) !== null) {
      let pattern = match[1]
        .replace(/\\"/g, '"')    // 处理转义引号
        .replace(/""/g, '"')     // 处理双引号转义
        .replace(/\|+/g, '|');   // 标准化分隔符
      
      // 处理正则表达式特殊符号（如括号）
      pattern = pattern.replace(/([()])/g, '\\$1');
      
      matches.push(pattern);
    }

    return matches;
  }
  // ==== 方法结束 ====

  getReply(input) {
    // 增强输入清洗（兼容全角/半角符号）
    const cleanInput = input
      .replace(/[\s？。，、]/g, '') // 移除空格和标点
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)); // 全角转半角
    
    console.log('\n当前输入:', cleanInput);

    // 周六优先逻辑
    if (dayjs().format('dddd') === 'Saturday') {
      const saturdayReply = this.qaData.find(qa => qa.answer.includes('週六公休'));
      if (saturdayReply) {
        console.log('匹配周六公休规则');
        return saturdayReply.answer;
      }
      return '📅 週六公休';
    }

    // 精确匹配
    for (const qa of this.qaData) {
      if (qa.pattern.test(cleanInput)) {
        console.log('匹配规则:', qa.pattern.source);
        return qa.answer;
      }
    }
    
    return '📥 已记录问题将转交客服处理';
  }
}

module.exports = SheetsReply;