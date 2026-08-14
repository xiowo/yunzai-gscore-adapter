# 🦊 Yunzai早柚核心适配器 (Gscore-Adapter)

这是一个适用于 [Yunzai](https://github.com/TimeRainStarSky/Yunzai) 的 [GScore](https://github.com/Genshin-bots/gsuid_core)（早柚核心）适配器插件。它通过 WebSocket 连接 GScore 服务，将 Yunzai 收到的消息事件上报给 GScore，并将 GScore 下发的回复发送回对应会话。

## ✨ 主要功能

- **🚀 多 Bot 接入**: 支持为每个已登录 Bot 单独启用连接，未启用的 Bot 不会接入 GScore。
- **⚙️ WebUI 配置**: 支持在 Guoba / 插件 WebUI 中配置全局连接地址、Token、重连间隔和 Bot 列表。
- **🔄 断线重连**: WebSocket 断开后会按配置间隔自动重连，也支持手动触发重连。
- **📡 消息上报**: 支持将 Yunzai 群聊 / 私聊消息转换为 GScore `MessageReceive` 协议。
- **📡 元事件上报**: 支持上报进群、退群、戳一戳等标准 meta 事件。
- **快捷查蛋**: 指定 Bot 的群聊和私聊可直接发送尺寸和重量，自动补全为精灵蛋查询命令。
- **🏷️ 转发前缀**: 可按 Bot 账号自动添加 GScore 命令前缀，并配置强制添加/跳过命令。
- **🛠️ 维护回复**: 支持断连达到阈值或指定命令维护时自动回复，并阻止消息进入离线队列。
- **🧩 合并转发**: OneBot 下 `node` 按合并转发发送，节点身份使用当前 Bot QQ 号和昵称；QQBot 下自动降级为单条消息逐条发送。
- **↩️ 撤回回执**: 支持 GScore `wait_recall` 场景，发送后回传 Yunzai 消息 ID。
- **🛡️ 控制包支持**: 支持 GScore 下发撤回、禁言等控制包。
- **Markdown 本地图片**: 可将 GScore Markdown 中的本地图片上传图床后再发送。

## 🛠️ 安装插件

```bash
git clone https://github.com/xiowo/yunzai-gscore-adapter.git ./plugins/Gscore-Adapter
```

```bash
pnpm i
```

> 容器部署时请确保 Yunzai 容器可以访问 GScore 服务。如果 GScore 不在同一容器内，请不要把连接地址写成容器内的 `127.0.0.1`，建议使用宿主机 IP、Docker Network 容器名或同网络服务名。

## 📝 配置指南

你可以通过 Guoba / 插件 WebUI 修改配置，也可以直接编辑：`plugins/Gscore-Adapter/config/config.yml`。

| 配置项 | 说明 | 默认值 |
| :--- | :--- | :--- |
| **启用适配器** | 全局开关；关闭后不会建立任何 GScore 连接 | `true` |
| **全局连接地址** | GScore WebSocket 地址，只支持 `ws://` / `wss://` | `ws://127.0.0.1:8765` |
| **全局 Token** | GScore `WS_TOKEN`，为空则不携带 Token | `空` |
| **重连间隔** | WebSocket 断开后的重连间隔，单位毫秒 | `5000` |
| **无权限静默** | 无权限用户执行插件命令时是否不返回提示 | `false` |
| **主人正常转发** | 开启后当前群禁用时仍转发主人消息 | `false` |
| **上报私聊** | 是否向 GScore 上报私聊消息 | `true` |
| **上报群聊** | 是否向 GScore 上报群聊消息 | `true` |
| **上报 Meta 事件** | 是否向 GScore 上报进群、退群、戳一戳等事件 | `true` |
| **上传 Markdown 本地图片** | 将 Markdown 本地图片调用 `Bot.imageToUrl` 上传后替换地址 | `false` |
| **早柚根目录** | 用于解析 `/gsuid_core/...` 图片路径；同目录部署可留空 | `空` |
| **快捷查蛋** | 指定 Bot 在群聊或私聊发送尺寸/重量时自动补全 `精灵蛋` 前缀 | `false` |
| **快捷查蛋全局启用** | 任意 Bot 均启用快捷查蛋，开启后无需配置 Bot 账号 | `false` |
| **转发前缀** | 按 Bot 账号为上报文本添加前缀 | `[]` |
| **断连维护回复** | 连接断开达到阈值后，命中命令自动回复并停止上报 | `[]` |
| **命令维护回复** | 命中维护命令后自动回复并停止上报 | `[]` |
| **群规则** | 群启用状态、群前缀、群内用户拉黑列表 | `{}` |
| **Bot 列表** | 需要接入 GScore 的 Bot 配置；每个 Bot 可单独启用 | `{}` |
| **Bot 连接地址** | 单个 Bot 的 GScore 地址；为空时使用全局连接地址 | `空` |
| **Bot Token** | 单个 Bot 的 GScore Token；为空时使用全局 Token | `空` |

配置文件示例：

```yaml
enable: true
coreUrl: ws://127.0.0.1:8765
token: ""
reconnectInterval: 5000
silentUnauthorized: false
masterBypassGroupDisabled: false
reportPrivate: true
reportGroup: true
reportMeta: true
uploadLocalMarkdownImages: false
gsuidCoreRoot: ""
quickEggCheck: true
quickEggCheckGlobal: false
quickEggCheckBots:
  - "123456789"
gsuidBotPrefix:
  - global: false
    botIds:
      - "123456789"
    prefix: 星铁
    skipIfHasPrefix: true
    forceAddPrefix:
      - 帮助
    noPrefixCommands:
      - core
gsuidDisconnectReply:
  - global: false
    botIds:
      - "123456789"
    enable: true
    disconnectCount: 3
    commands:
      - "*"
    message: |-
      机器人维护中~
      正在更新框架(꒪⌓꒪)
gsuidCommandMaintenanceReply:
  - global: false
    botIds:
      - "123456789"
    enable: true
    commands:
      - 某功能
    message: 功能正在调整中...
groupRules: {}
bots:
  "123456789":
    enable: true
    coreUrl: ""        # 留空使用全局 coreUrl
    token: ""          # 留空使用全局 token
```

### 消息增强规则

- 开启 **上传 Markdown 本地图片** 后，`![图片](/gsuid_core/data/...)` 等本地绝对路径会先通过 `Bot.imageToUrl` 上传，再替换为图床 URL。HTTP、base64、data 和 file 地址不会处理；文件不存在或上传失败时保留原文。

- **快捷查蛋**同时处理群聊和私聊。格式与 ws-plugin 一致，例如 `0.07m 0.146kg`、`炫彩 0.07 0.146kg`；已经以 `精灵蛋` 或 `查蛋` 开头的消息不会重复补全。
- **转发前缀**会先去掉消息开头的空格和 `/` 再添加。`skipIfHasPrefix` 开启时，字母或数字开头默认视作已经有命令前缀；`forceAddPrefix` 可覆盖该判断；`noPrefixCommands` 优先级最高。
- **维护命令**使用开头匹配，匹配前会忽略消息开头的空格和 `/`；填写 `*` 表示匹配全部消息。
- **断连次数**按同一 WebSocket 的连续断开次数计算，达到配置值时触发，连接恢复后清零。命中断连维护或命令维护时，插件会直接回复，不会把该条消息放入重连队列。
- 四项规则均可按 `self_id`（Yunzai Bot 账号）生效。插件 WebUI 会在二级页面展示已登录/已配置 Bot，通过开关选择；开启“全局启用”后会设置规则的 `global: true`，任意 Bot 均遵循该配置。
- 同一类规则中，每个 Bot 只对应一条规则；将 Bot 分配到新规则时，WebUI 会自动从该类的其他规则中移除。全局规则存在时优先于单 Bot 规则。

### 🐱 指令列表

指令默认使用 `#早柚` 前缀：

| 指令 | 说明 |
| :--- | :--- |
| `#早柚status` | 查看适配器启用 Bot 数、运行时间、拉黑群和拉黑用户人数 |
| `#早柚version` | 查看适配器版本号 |
| `#早柚更新` | 更新 Gscore-Adapter 插件本体 |
| `#早柚群禁用` / `#早柚群启用` | 禁用 / 启用当前群消息转发给早柚 |
| `#早柚拉黑@用户` / `#早柚取消拉黑@用户` | 控制被 @ 用户在当前群的消息是否转发给早柚 |
| `#早柚群前缀` | 设置当前群前缀，例如 `#早柚群前缀zz` 后仅转发 `zz` 开头消息；直接发送 `#早柚群前缀` 会清空前缀 |

> 群前缀判断会忽略消息开头的空格和 `/`，例如设置 `zz` 后，` /zzcore帮助` 会作为 `core帮助` 转发给早柚。

> Bot 是否接入 GScore 由配置中的 Bot 单独开关决定；全局开关开启不代表所有 Bot 都会连接。

## ❓ 常见问题 (FAQ)

### Q1: 无法连接到 GScore？

**A**:
1. 请确认 GScore 已启动，并监听配置中的 `全局连接地址` 地址。
2. 如果 GScore 开启了 `WS_TOKEN`，请在插件配置中正确填写 `token`。
3. 如果 Yunzai 运行在 Docker 容器中，容器内的 `127.0.0.1` 指向容器本身，请改用宿主机 IP 或 Docker Network 服务名。

### Q2: 为什么 GScore 没有收到消息？

**A**:
1. 请确认插件全局开关已开启。
2. 请确认对应 Bot 在 Bot 列表中已单独启用。
3. 请确认 `上报私聊` / `上报群聊` 没有关闭。
4. 请确认当前群没有被 `#早柚群禁用`，用户没有被 `#早柚拉黑`，以及群前缀配置是否匹配。
5. 发送 `#早柚status` 查看连接是否正常。

### Q3: 为什么 QQBot 的合并转发变成了多条消息？

**A**: QQBot 下默认不按 OneBot 合并转发协议发送 `node`，插件会自动降级为单个消息逐条发送，避免消息无法送达。

## 📄 License

MIT License
