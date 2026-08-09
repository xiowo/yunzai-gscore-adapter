# Gscore-Adapter for Yunzai

把 Yunzai 作为平台侧适配器接入 `gsuid-core`（早柚核心）：

- Yunzai 收到的群聊/私聊消息会按 GsCore `MessageReceive` 协议上报到 core。
- core 下发的 `MessageSend` 会被转换为 Yunzai 消息并发回对应群/私聊。
- 支持文本、图片、@、回复、语音、视频、文件、node 拆分发送、日志包、撤回回执、撤回/禁言控制包。
- 支持进群、退群、戳一戳三类标准 meta 事件上报。
- QQBot 会按私聊/群聊分别在 Redis 记录最近 5 分钟消息 ID，下发时优先使用最新消息 ID 走被动发送窗口。

## 配置

编辑：`plugins/Gscore-Adapter/config/config.yaml`

```yaml
# 全局开关默认开启；是否连接由 bots 下每个 Bot 单独控制
enable: true
coreUrl: ws://127.0.0.1:8765
token: ""
reconnectInterval: 5000
reportPrivate: true
reportGroup: true
reportMeta: true
splitNode: true
bots:
  "123456789":
    enable: true
    coreUrl: ""        # 留空使用全局 coreUrl
    token: ""          # 留空使用全局 token
```

`coreUrl` 指向 gsuid-core 的 HTTP/WS 地址；如果 core 配置了 `WS_TOKEN`，请同步填写 `token`。连接路由 ID 固定为 `Yunzai-{qq号}`，运行时会替换为对应 bot 账号，例如 `Yunzai-123456789`，不作为配置项暴露。

全局开关默认开启，但 Bot 默认都关闭：需要在 `bots` 下为指定 QQ 号设置 `enable: true` 才会连接。单个 Bot 的 `coreUrl` 留空时使用全局 `coreUrl`，也可为不同 Bot 配不同 core 地址。

## Guoba WebUI

已新增 `guoba.support.js`，安装并启用 Guoba-Plugin 后可在后台配置：

- 全局启用开关、全局连接地址、Token。
- “Bot 列表”使用可增删的列表表单，并会自动带出当前已登录 Bot。
- 每个 Bot 单独启用/关闭，默认关闭；开启后才会连接 core。
- 每个 Bot 可自定义连接地址、Token；留空则回退到全局配置。
- 路由 ID 固定为 `Yunzai-{qq号}`，不在 WebUI 中配置。
- 保存后会自动重载配置并发起连接；也可发送 `#gscore重连` 手动重连。

## 目录结构

- `index.js`：插件入口、事件绑定、状态/重连命令。
- `lib/client.js`：WebSocket 连接、重连、core 下发调度。
- `lib/message.js`：Yunzai 消息与 GsCore 消息段互转。
- `lib/meta.js`：notice/meta 事件转换。
- `lib/config.js` / `lib/constants.js` / `lib/utils.js`：配置加载、默认值和公共工具；路由 ID 固定模板在常量中定义。
- `guoba.support.js`：Guoba WebUI 配置表单。

## 命令

- `#gscore状态`：查看连接状态。
- `#gscore重连`：重读配置并重新连接。

## 验证

```powershell
Set-Location d:\AAxiowo\yunzai\yunzai
node --check plugins/Gscore-Adapter/index.js
```

## 注意

上报和接收过滤使用的 `bot_id` 会根据 `e.bot.adapter.id` 自动识别平台：`QQBot -> qqgroup`、`QQGuild -> qqguild`、`KOOK -> kook`、`Telegram -> telegram`、`Discord -> discord`；其余适配器固定视为 `onebot`。

QQBot 被动发送依赖最近消息 ID：插件收到 QQBot 私聊/群聊消息时，会写入 `Yz:GscoreAdapter:QQBot:MessageId:{selfId}:{direct|group}:{targetId}`，TTL 为 300 秒；core 下发到同一私聊/群聊时会优先读取该 ID 作为 `{ id }` 发送事件参数，过期后自动丢弃并回退普通发送。