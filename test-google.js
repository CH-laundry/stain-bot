require('dotenv').config();

const { addCustomerInfo } = require('./services/google');

async function test() {
  await addCustomerInfo({
    userId: 'U4af49806ea6bd7bd117223c51785d483',
    userName: 'test',
    address: '台北市中山區'
  })
}

test();