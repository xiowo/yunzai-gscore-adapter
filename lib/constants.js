import path from "node:path"
import fs from "node:fs"
import YAML from "yaml"

export const PLUGIN_NAME = "Gscore-Adapter"
export const PLUGIN_DIR = path.resolve("plugins", PLUGIN_NAME)
export const CONFIG_DIR = path.join(PLUGIN_DIR, "config")
export const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, "default_config.yml")
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.yml")
export const ROUTE_BOT_ID_TEMPLATE = "Yunzai-{qq号}"
export const QQBOT_MESSAGE_ID_TTL = 300
export const QQBOT_MESSAGE_ID_KEY_PREFIX = "Yz:GscoreAdapter:QQBot:MessageId"
export const QQBOT_MESSAGE_ID_REPLY_LIMIT = 5

/** 上行积压队列的字节上限，超过后丢弃最旧的包，防止 core 宕机期间无界吃内存 */
export const SEND_QUEUE_MAX_BYTES = 32 * 1024 * 1024
/** ws 内核发送缓冲高水位；超过则暂停直接发送，改走队列慢速排空（背压） */
export const SEND_BUFFER_HIGH_WATER = 4 * 1024 * 1024
/**
 * 单条 core 下发消息的处理超时。
 * 必须明显小于 core 的 RECALL_WAIT_TIMEOUT（10 秒），否则超时回执送达时 core 已经放弃等待，
 * 起不到「立即结算」的作用，还会白白累加降级计数。
 */
export const CORE_SEND_TIMEOUT = 8000
/**
 * 回执截止时间：**任何**带回执（`echo` 非空）的下发，回执都必须在此刻前送达 core。
 *
 * 依据 references/11-meta-and-control.md §11.2 / §11.5：core 收到 `echo` 非空的
 * `MessageSend` 后会等 `RECALL_WAIT_TIMEOUT`（10 秒），超过窗口才到达的回执
 * 「变成噪音，照样计降级次数」，连续 3 次零回执还会把连接 latch 成「不支持回执」（§11.6）。
 * 留 1 秒余量取 9 秒，作为**所有**下发处理超时的硬上限。
 *
 * 注意它不只约束普通消息：`gscore_group_members_request` / `gscore_qqbot_active_test`
 * 的回包**只能**走 `recall_message_id` 回执（见 client.js `sendRecallReceipt`），
 * 必然带 `echo`，因此同样受这个截止时间约束。
 */
export const CORE_RECEIPT_DEADLINE = 9000
/**
 * 控制类请求（拉群成员 / 主动权限测试）的处理预算。
 *
 * 曾取 20 秒，但那是**越界**的：这两个请求的回包只能靠带回执的上行送达 core，
 * 20 秒才回的话 core 早已在 10 秒放弃等待 —— 回执既送不回去数据、还要计一次降级。
 * 超过 `CORE_RECEIPT_DEADLINE` 的预算没有任何收益，所以取同值；
 * 保留这个常量只是为了**能单独收紧**（例如压到 3 秒快速失败），不允许单独放宽。
 *
 * 这两个类型是本地扩展，不在 gscore-adapter-development 协议文档里，但已核过 core 源码
 * （`gsuid_core/bot.py:452` 只在 `wait_recall=True` 时生成 `echo`；`:530` 用同一个
 * `RECALL_WAIT_TIMEOUT` 窗口等待所有帧），确认它们与普通下发共用同一个 10 秒窗口。
 * 若日后 core 侧给它们另设更长的等待，必须**两边同时**放宽（core 的等待 + 这里的截止）。
 */
export const CORE_CONTROL_TIMEOUT = 9000
/**
 * 撤回 / 禁言控制包的「顺序屏障」等待上限。
 *
 * 协议 references/11-meta-and-control.md §11.5 要求：
 *   「撤回/禁言与普通消息共用同一发送队列：保持与在途消息的相对顺序」
 * 所以控制包执行前，要先等此前的在途下发落地。
 *
 * 取与普通单条下发超时同值（CORE_SEND_TIMEOUT）：超过这个时长，说明那条下发已按超时
 * 结算过了，再让序也没有意义，不如放控制包去执行。
 */
export const DOWN_ORDER_BARRIER_TIMEOUT = 8000
/** 重连退避上限，避免断线后高频重连 + 积压重放把事件循环打满 */
export const RECONNECT_MAX_INTERVAL = 30000
/** 连接要稳定存活多久才清零退避计数，防止 core 反复 accept-then-drop 时退避被打回起点 */
export const RECONNECT_STABLE_RESET = 60000
/**
 * 应用层心跳间隔。
 * 协议文档 references/03-connection-lifecycle.md §3.4 要求适配器侧保活：
 * 原文是「websockets 自带 ping/pong 心跳，配好 ping_interval/ping_timeout 即可保活」，
 * 即 Python 的 websockets 客户端会**主动发 ping** 并监测 pong。
 * Node 的 ws 客户端只被动回 pong（_autoPong），没有 pingInterval 选项，必须自己发。
 * core 是 websockets 服务端，收到 ping 会自动回 pong（RFC 6455），无需 core 侧改动。
 */
export const HEARTBEAT_INTERVAL = 30000
/**
 * 连续多久没收到 pong 就判定连接已死（相对心跳间隔的倍数）。
 * 取 2.5 个周期：容忍偶发丢一个来回，又不会让半开连接拖太久。
 */
export const HEARTBEAT_MISS_FACTOR = 2.5
/** TCP keepalive 空闲探测延迟：覆盖「socket 仍 OPEN 但对端已死」的半开连接 */
export const SOCKET_KEEPALIVE_DELAY = 30000
/** 积压丢弃告警的最小间隔，防止刷屏 */
export const SEND_DROP_WARN_INTERVAL = 30000

export const ADAPTER_BOT_ID_MAP = {
    QQBot: "qqgroup",
    QQGuild: "qqguild",
    KOOK: "kook",
    Telegram: "telegram",
    Discord: "discord",
}

export const FALLBACK_DEFAULT_CONFIG = {
    enable: true,
    defaultBotEnable: true,
    coreUrl: "ws://127.0.0.1:8765",
    token: "",
    routeBotId: "Yunzai",
    reconnectInterval: 5000,
    heartbeatInterval: 30000,
    sendTimeout: 8000,
    controlSendTimeout: 9000,
    reportPrivate: true,
    reportGroup: true,
    reportMeta: true,
    uploadLocalMarkdownImages: false,
    gsuidCoreRoot: "",
    silentUnauthorized: false,
    masterBypassGroupDisabled: false,
    quickEggCheck: false,
    quickEggCheckGlobal: false,
    quickEggCheckBots: [],
    gsuidBotPrefix: [],
    gsuidDisconnectReply: [],
    gsuidCommandMaintenanceReply: [],
    groupRules: {},
    bots: {},
}

function readDefaultConfig() {
    try {
        return YAML.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, "utf8")) || FALLBACK_DEFAULT_CONFIG
    } catch (err) {
        globalThis.logger?.warn?.(`[${PLUGIN_NAME}] 默认配置读取失败，使用内置默认值`, err)
        return FALLBACK_DEFAULT_CONFIG
    }
}

export const DEFAULT_CONFIG = readDefaultConfig()