require('dotenv').config();

const addressDetector = require('./utils/address');

console.log(addressDetector.extractAddress('吳芷薇 0988245855 新北市板橋區華江一路37號11樓 一件單人被'));