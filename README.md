# 🦊 Yunzai早柚核心适配器 (Gscore-Adapter)

这是一个适用于 [Yunzai](https://github.com/TimeRainStarSky/Yunzai) 的 [GScore](https://github.com/Genshin-bots/gsuid_core)（早柚核心）适配器插件。它通过 WebSocket 连接 GScore 服务，将 Yunzai 收到的消息事件上报给 GScore，并将 GScore 下发的回复发送回对应会话。

## ✨ 主要功能

- **🚀 多 Bot 接入**: 支持为每个已登录 Bot 单独启用连接，未启用的 Bot 不会接入 GScore。
- **⚙️ WebUI 配置**: 支持在 Guoba / 插件 WebUI 中配置全局连接地址、Token、重连间隔和 Bot 列表。
- **🔄 断线重连**: WebSocket 断开后会按配置间隔自动重连，也支持手动触发重连。
- **📡 消息上报**: 支持将 Yunzai 群聊 / 私聊消息转换为 GScore `MessageReceive` 协议。
- **📡 元事件上报**: 支持上报进群、退群、戳一戳等标准 meta 事件。
- **🧩 合并转发**: OneBot 下 `node` 按合并转发发送，节点身份使用当前 Bot QQ 号和昵称；QQBot 下自动降级为单条消息逐条发送。
- **↩️ 撤回回执**: 支持 GScore `wait_recall` 场景，发送后回传 Yunzai 消息 ID。
- **🛡️ 控制包支持**: 支持 GScore 下发撤回、禁言等控制包。

## 🛠️ 安装插件

```bash
git clone https://github.com/xiowo/yunzai-gscore-adapter.git ./plugins/Gscore-Adapter
```

```bash
pnpm i
```

> 容器部署时请确保 Yunzai 容器可以访问 GScore 服务。如果 GScore 不在同一容器内，请不要把连接地址写成容器内的 `127.0.0.1`，建议使用宿主机 IP、Docker Network 容器名或同网络服务名。

## 📝 配置指南

你可以通过 Guoba / 插件 WebUI 修改配置，也可以直接编辑：`plugins/Gscore-Adapter/config/config.yaml`。

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
groupRules: {}
bots:
  "123456789":
    enable: true
    coreUrl: ""        # 留空使用全局 coreUrl
    token: ""          # 留空使用全局 token
```


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
