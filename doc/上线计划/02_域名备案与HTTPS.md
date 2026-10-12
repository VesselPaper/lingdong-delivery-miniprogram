# 02 · 域名备案与 HTTPS

最后更新：2026-09-26

## 1. 为什么必须

小程序连服务器 API 强制要求：HTTPS、域名已 ICP 备案、域名配入小程序后台「request 合法域名」白名单。这是上线不可绕过的第一步，备案有 2-4 周周期，务必最先启动。

## 2. 域名注册

| 项 | 建议 |
|---|---|
| 域名 | 短、好记，如 lingdong.cn / ldgo.cn / lingdonggo.com，先查可注册性 |
| 注册商 | 阿里云/腾讯云，与服务器同厂商便于备案联动 |
| 费用 | .cn 约 ¥30/年，.com 约 ¥60/年 |
| 实名 | 注册即需实名，与备案主体一致 |
| 注意 | 不买二手"备案域名"，域名持有者信息与备案主体一致 |

## 3. ICP 备案（最耗时，先办）

国内云服务器对外提供 Web 服务必须备案，否则机房封 80/443 端口。

流程（以腾讯云为例）：
1. 注册域名并实名（1-3 天）
2. 云厂商「备案控制台」提交：主体信息（负责人证件/手机号）+ 网站信息（域名 + 用途说明）
3. 云厂商初审（1-2 天）→ 提交管局
4. 管局审核（通常 2-4 周，四川）
5. 通过后获得备案号，可正常解析 80/443

并行技巧：备案等待期间，服务器部署、代码、小程序体验版、扫码联调全部可继续（用 IP 直连或临时域名），备案号下来后再切正式域名。

主体选择：学生项目可个人备案（身份证，费用 0）。但微信支付 JSAPI 要求小程序主体为企业/个体工商户，个人主体不能开通微信支付——以微信小程序后台要求为准，需先确认。

## 4. 域名解析

```text
记录类型  主机记录  记录值（示例）
A         api       1.2.3.4
A         @         1.2.3.4
```

建议统一用一个子域如 api.lingdong.cn 作为后端入口，小程序合法域名、图片地址、回调地址全用它。

## 5. Nginx 反向代理 + HTTPS

### 5.1 安装

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

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/lingdong /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.lingdong.cn   # 自动改配置 + 90 天自动续期
```

### 5.3 后端配合调整（backend/.env）

```ini
BIND_HOST=127.0.0.1     # 只监听本机，Nginx 转发
TRUST_PROXY=1           # 采信 X-Forwarded-For
PUBLIC_ORIGIN=https://api.lingdong.cn   # 图片等资源绝对地址基址
```

### 5.4 防火墙 / 安全组

- 放行：443（公网）、80（certbot 验证）、22（SSH）。
- 3000 不需要公网放行（BIND_HOST=127.0.0.1 + Nginx 转发）；测试期需直连再临时放行，上线后关闭。

## 6. 验证清单

- [ ] 域名已注册并实名，A 记录指向服务器 IP
- [ ] ICP 备案已提交或已通过
- [ ] https://api.lingdong.cn/api/goods/list 返回 code:0
- [ ] https://api.lingdong.cn/admin/ 与 /dashboard/ 可打开
- [ ] certbot renew --dry-run 通过
- [ ] 安全组仅放行 443/80/22
