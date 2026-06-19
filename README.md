# 网址与域名监控控制台

一个 Docker/VPS 友好的监控控制台，支持网址可用性、域名到期、ICP备案状态检测，并通过 Telegram Bot 告警。

## 快速开始

```bash
cp .env.example .env
pnpm install
pnpm run db:push
pnpm run dev
```

默认开发密码是 `admin123`。生产环境请设置 `ADMIN_PASSWORD_HASH` 和强随机 `SESSION_SECRET`。

生成密码 hash：

```bash
node -e "import('bcryptjs').then(b=>b.hash('你的密码',10).then(console.log))"
```

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

访问 `http://服务器IP:3000`。

## ICP 备案检测

备案检测使用本地自托管的 ICP_Query 服务，不再保留其他查询方式。系统会在北京时间每天 `12:00`、`15:00` 和 `18:00` 自动检测开启备案检测的域名；手动检测按钮仍可立即触发单个域名检测。

默认本地服务地址：

```text
ICP_QUERY_BASE_URL=http://127.0.0.1:16181
```

ICP_Query 项目参考：`https://github.com/HG-ha/ICP_Query`。接口格式：

```text
GET /query/web?search=baidu.com
```

如果本地 ICP_Query 不可用，系统会按 `30 秒`、`2 分钟` 间隔重试，总计 3 次。仍失败时只记录查询错误，不会误判为掉备。

## Telegram 多接收人

`TELEGRAM_CHAT_ID` 或设置页里的 Telegram Chat ID 支持逗号分隔：

```text
123456789,-100xxxxxxxxxx,987654321
```

告警会逐个发送到每个 chat id。
