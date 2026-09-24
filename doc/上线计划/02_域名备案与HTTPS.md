# 02 · 域名备案与 HTTPS

最后更新：2026-09-24
依据代码：`README.md` §三「可选：域名 + HTTPS」、`doc/02_系统架构与运行.md` §3.4、`backend/server.js`（BIND_HOST/TRUST_PROXY）。

## 1. 为什么必须（硬前提）

微信小程序连服务器 API 有强制要求（`README.md` §三 明确）：
1. **必须 HTTPS**（小程序 request/socket/downloadFile 合法域名只认 https）；
2. **域名必须已 ICP 备案**（国内服务器上对外提供 Web 服务需备案；微信后台校验域名备案状态）；
3. 域名要在小程序后台配入「request 合法域名」白名单。

所以：**域名 + 备案 + HTTPS 证书 = 上线不可绕过的第一步**，且备案有 2-4 周审核周期，务必最先启动。

## 2. 域名注册

| 项 | 建议 |
|---|---|
| 域名 | 短、好记，如 `lingdong.cn` / `ldgo.cn` / `lingdonggo.com`（团队商量，先查是否可注册） |
| 注册商 | 阿里云/腾讯云（与服务器同厂商便于备案联动，也可后续转） |
| 费用 | .cn 约 ¥30/年，.com 约 ¥60/年 |
| 实名 | 注册即需实名（身份证/企业证件），与备案主体一致 |
| 注意 | 不要买「备案域名」现成二手域名（历史备案/违规记录风险）；域名持有者信息要与备案主体一致 |

## 3. ICP 备案（最耗时，先办）

- 国内云服务器（阿里云/腾讯云）上架对外 Web 服务，域名**必须 ICP 备案**，否则会被机房封 80/443 端口（服务器厂商会定期扫描）。
- 流程（以腾讯云为例，阿里云类似）：
  1. 注册域名并实名（1-3 天）；
  2. 在云厂商「备案控制台」提交备案申请：主体信息（负责人证件/手机号）、网站信息（域名 + 用途说明，如"校园无人送餐服务"）；
  3. 云厂商初审（1-2 天）→ 提交管局；
  4. 管局审核（**通常 1-4 周**，各省不同；四川一般在 2-4 周）；
  5. 备案通过后获得备案号，域名可正常解析 80/443。
- **并行技巧**：备案等待期间，服务器部署、代码、小程序体验版、扫码功能联调全部可以继续做（用 IP 直连或临时域名测试），不影响开发节奏。备案号下来后再切正式域名。
- 主体选择：学生项目可用**个人备案**（个人身份证即可，费用 0）；若涉及经营性（收款/交易），微信支付商户与小程序类目可能要求企业主体——**以微信小程序后台要求为准**（个人主体小程序不支持微信支付！这一点必须确认：微信支付 JSAPI 要求小程序主体为企业/个体工商户）。
  - ⚠️ 重要确认项：若要以真实微信支付收款，小程序（零栋GO）必须是**企业/个体工商户主体**；个人主体小程序不能开通微信支付。师姐的号若是个人主体，需先确认支付能力（见 03 篇）。

## 4. 域名解析

```text
记录类型  主机记录  记录值（示例）
A         api       1.2.3.4        ← 后端域名（可单独用子域）
A         @         1.2.3.4        ← 主域（管理员/大屏用，也可都走 api）
```

- 建议统一用一个子域如 `api.lingdong.cn` 作为后端入口，小程序合法域名、图片绝对地址（PUBLIC_ORIGIN）、回调地址全用它，简单一致。

## 5. Nginx 反向代理 + HTTPS 证书

### 5.1 安装 Nginx + 证书（Let's Encrypt 免费）

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

### 5.2 配置站点

```nginx
# /etc/nginx/sites-available/lingdong
server {
    listen 80;
    server_name api.lingdong.cn;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name api.lingdong.cn;

    ssl_certificate     /etc/letsencrypt/live/api.lingdong.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.lingdong.cn/privkey.pem;

    # 上传大小上限：后端 express.json limit=8mb，这里对齐放宽
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（/ws）需要 Upgrade 头
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/lingdong /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 申请证书（先把 A 记录解析好、80 端口放通）
sudo certbot --nginx -d api.lingdong.cn
# certbot 会自动改配置 + 定时续期（90 天自动 renew）
```

### 5.3 后端配合调整（`backend/.env`）

```ini
BIND_HOST=127.0.0.1     # 只监听本机，由 Nginx 转发（安全：3000 不对外暴露）
TRUST_PROXY=1           # 采信 X-Forwarded-For（登录限流/审计取真实 IP）
PUBLIC_ORIGIN=https://api.lingdong.cn   # 图片等资源拼成完整 https URL
```

> 依据：`doc/02_系统架构与运行.md` §2.2 A 组（BIND_HOST/TRUST_PROXY）、`domains/_shared.js → PUBLIC_ORIGIN/assetAbs`。

### 5.4 防火墙 / 安全组

- 云安全组放行：**443**（公网）、80（公网，用于 certbot 验证）、22（SSH）。
- **3000 不需要公网放行**（BIND_HOST=127.0.0.1 + Nginx 转发）；若测试期需要 IP:3000 直连，再临时放行，上线后关掉。

## 6. 验证清单

- [ ] 域名已注册并实名，A 记录指向服务器 IP
- [ ] ICP 备案已提交（记录管局受理号），或已通过
- [ ] `https://api.lingdong.cn/api/goods/list` 浏览器访问返回 code:0（证书有效、Nginx 转发正常）
- [ ] `https://api.lingdong.cn/admin/` 管理员页可打开（注意末尾斜杠）
- [ ] `https://api.lingdong.cn/dashboard/` 大屏可打开
- [ ] 证书自动续期已配置（`certbot renew --dry-run` 通过）
- [ ] 安全组仅放行 443/80/22，3000 未对外
