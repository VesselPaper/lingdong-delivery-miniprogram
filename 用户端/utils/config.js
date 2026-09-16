// 环境配置
// 小程序端不存放开放物流平台凭据（appid/secret），
// 所有平台调用由后端服务完成，此处仅配置自建后端地址。

const ENV = {
  dev: {
    // 真机预览用电脑局域网 IP（手机热点模式下为热点网段，手机与电脑需同一网络）；模拟器用 localhost 亦可
    baseUrl: 'http://192.168.70.50:3000/api'
  },
  prod: {
    baseUrl: 'http://localhost:3000/api'
  }
}

// 当前环境：dev 开发环境，prod 生产环境
const CURRENT = 'dev'

module.exports = {
  baseUrl: ENV[CURRENT].baseUrl,
  env: CURRENT
}
