// 环境配置
// 商家端不存放开放物流平台凭据，平台调用由后端完成。

// 真机预览（手机与电脑同一 WiFi）时改为电脑局域网 IP，如 http://192.168.x.x:3000/api
// 查看 IP：命令行 ipconfig（以太网 IPv4 地址）；模拟器用 localhost 亦可
const LAN_BASE = 'http://10.75.155.19:3000/api'

const ENV = {
  dev: {
    baseUrl: LAN_BASE
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
