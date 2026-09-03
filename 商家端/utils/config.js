// 环境配置
// 商家端不存放开放物流平台凭据，平台调用由后端完成。

const ENV = {
  dev: {
    baseUrl: 'http://localhost:3000/api'
  },
  prod: {
    baseUrl: 'http://localhost:3000/api'
  }
}

const CURRENT = 'dev'

module.exports = {
  baseUrl: ENV[CURRENT].baseUrl,
  env: CURRENT
}
