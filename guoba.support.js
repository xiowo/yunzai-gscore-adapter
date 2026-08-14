import fs from "node:fs"
import YAML from "yaml"
import _ from "lodash"
import { CONFIG_FILE, DEFAULT_CONFIG, PLUGIN_NAME } from "./lib/constants.js"

function readConfig() {
    try {
        return _.merge({}, DEFAULT_CONFIG, YAML.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {})
    } catch {
        return { ...DEFAULT_CONFIG }
    }
}

function writeConfig(config) {
    fs.mkdirSync(CONFIG_FILE.replace(/[/\\][^/\\]+$/, ""), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, YAML.stringify(config), "utf8")
}

function reloadAdapter() {
    if (typeof globalThis.Bot?.em === "function") globalThis.Bot.em("gscore-adapter.reload")
    else globalThis.Bot?.emit?.("gscore-adapter.reload")
}

function flattenBotConfig(bots = {}) {
    return Object.entries(bots).map(([botId, item]) => ({
        botId,
        enable: !!item?.enable,
        coreUrl: item?.coreUrl || "",
        token: item?.token || "",
        routeBotId: item?.routeBotId || "",
    }))
}

function restoreBotConfig(botList = []) {
    const bots = {}
    for (const item of Array.isArray(botList) ? botList : []) {
        const botId = String(item?.botId || "").trim()
        if (!botId) continue
        bots[botId] = {
            enable: !!item.enable,
            coreUrl: String(item.coreUrl || "").trim(),
            token: String(item.token || ""),
            routeBotId: String(item.routeBotId || "").trim(),
        }
    }
    return bots
}

function normalizePersistConfig(config) {
    const next = { ...config }
    delete next.platformBotId
    delete next.botList
    delete next.gsuidBotPrefixList
    delete next.gsuidDisconnectReplyList
    delete next.gsuidCommandMaintenanceReplyList
    delete next.maxReconnectAttempts
    return next
}

function normalizeRuleList(list = [], normalizeItem) {
    if (!Array.isArray(list)) return []
    return list.map(item => ({
        global: item?.global === true,
        botIds: normalizeStringList(item?.botIds),
        ...normalizeItem(item || {}),
    })).filter(item => item.global || item.botIds.length)
}

function normalizeStringList(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean))]
}

function normalizeDisconnectCount(value) {
    const count = Number(value)
    return Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 3
}

function getLoginBotIds() {
    const bot = globalThis.Bot
    const uin = bot?.uin
    if (Array.isArray(uin)) return uin.map(i => String(i)).filter(Boolean)
    if (uin) return [String(uin)]
    return []
}

function mergeLoginBots(config = {}) {
    const merged = new Map(flattenBotConfig(config.bots || {}).map(item => [String(item.botId), item]))
    for (const botId of getLoginBotIds()) {
        if (!merged.has(botId)) {
            merged.set(botId, {
                botId,
                enable: config.defaultBotEnable !== false,
                coreUrl: "",
                token: "",
                routeBotId: "",
            })
        }
    }
    return [...merged.values()]
}

function getSaveMessage(config) {
    if (config.enable === false) return "保存成功，已自动重载：适配器全局关闭，已断开现有连接"
    const enabledCount = Object.values(config.bots || {}).filter(item => !!item?.enable).length
    if (!enabledCount) return "保存成功，已自动重载：未启用任何 Bot，已断开现有连接"
    return `保存成功，已自动重载：${enabledCount} 个 Bot 将尝试连接`
}

export function supportGuoba() {
    return {
        pluginInfo: {
            name: "Gscore适配器",
            title: PLUGIN_NAME,
            description: "一个适用于Yunzai的早柚核心适配器",
            author: "@MortalCat",
            authorLink: "https://github.com/xiowo",
            link: "https://github.com/xiowo/yunzai-gscore-adapter",
            isV3: true,
            isV2: false,
            showInMenu: "auto",
            icon: "mdi:connection",
            iconColor: "#ffba53",
        },
        configInfo: {
            schemas: [
                { label: "全局配置", component: "SOFT_GROUP_BEGIN" },
                { field: "enable", label: "启用适配器", component: "Switch", bottomHelpMessage: "默认开启；是否连接由下方 Bot 单独开关决定。" },
                { field: "defaultBotEnable", label: "新增 Bot 默认启用", component: "Switch", bottomHelpMessage: "开启后新登录/新发现的 Bot 默认启用；关闭后默认不启用。" },
                { field: "coreUrl", label: "全局连接地址", component: "Input", componentProps: { placeholder: "ws://127.0.0.1:8765" } },
                { field: "token", label: "全局 Token", component: "InputPassword", componentProps: { placeholder: "core 配置 WS_TOKEN 时填写" } },
                { field: "routeBotId", label: "全局 WS BotID", component: "Input", componentProps: { placeholder: "Yunzai" }, bottomHelpMessage: "所有未单独配置连接的启用 Bot 共用该 WS BotID。" },
                { field: "reconnectInterval", label: "重连间隔(ms)", component: "InputNumber", componentProps: { min: 1000, step: 1000 } },
                { field: "silentUnauthorized", label: "无权限静默", component: "Switch", bottomHelpMessage: "开启后无权限用户执行插件命令不返回提示。" },
                { field: "masterBypassGroupDisabled", label: "主人正常转发", component: "Switch", bottomHelpMessage: "开启后即使当前群被禁用，主人消息仍会转发给早柚。" },
                { field: "reportPrivate", label: "上报私聊", component: "Switch" },
                { field: "reportGroup", label: "上报群聊", component: "Switch" },
                { field: "reportMeta", label: "上报 Meta 事件", component: "Switch" },
                { label: "消息增强", component: "SOFT_GROUP_BEGIN" },
                { field: "quickEggCheck", label: "快捷查蛋", component: "Switch", bottomHelpMessage: "开启后，将指定 Bot 在群聊或私聊收到的 0.07m 0.146kg 等消息自动补为精灵蛋查询。" },
                { field: "quickEggCheckGlobal", label: "快捷查蛋全局启用", component: "Switch", bottomHelpMessage: "开启后任意 Bot 均启用快捷查蛋，无需填写下方账号。" },
                { field: "quickEggCheckBots", label: "快捷查蛋 Bot", component: "Select", bottomHelpMessage: "未全局启用时，仅列表内 Bot 账号生效。", componentProps: { allowClear: true, mode: "tags" } },
                {
                    field: "gsuidBotPrefixList",
                    label: "转发前缀",
                    component: "GSubForm",
                    bottomHelpMessage: "按 Bot 账号为上报到 GScore 的文本自动添加前缀。",
                    componentProps: {
                        multiple: true,
                        modalProps: { title: "Bot 转发前缀" },
                        schemas: [
                            { field: "global", label: "全局启用", component: "Switch" },
                            { field: "botIds", label: "Bot 账号", component: "Select", componentProps: { allowClear: true, mode: "tags" } },
                            { field: "prefix", label: "前缀", component: "Input", required: true },
                            { field: "skipIfHasPrefix", label: "有前缀不插入", component: "Switch", componentProps: { defaultValue: true } },
                            { field: "forceAddPrefix", label: "强制加前缀命令", component: "Select", componentProps: { allowClear: true, mode: "tags" } },
                            { field: "noPrefixCommands", label: "不加前缀命令", component: "Select", componentProps: { allowClear: true, mode: "tags" } },
                        ],
                    },
                },
                {
                    field: "gsuidDisconnectReplyList",
                    label: "断连维护回复",
                    component: "GSubForm",
                    bottomHelpMessage: "连接连续断开达到配置次数后，命中命令自动回复维护消息并停止上报。",
                    componentProps: {
                        multiple: true,
                        modalProps: { title: "断连维护回复" },
                        schemas: [
                            { field: "global", label: "全局启用", component: "Switch" },
                            { field: "botIds", label: "Bot 账号", component: "Select", componentProps: { allowClear: true, mode: "tags" } },
                            { field: "enable", label: "启用", component: "Switch", componentProps: { defaultValue: true } },
                            { field: "disconnectCount", label: "断连次数", component: "InputNumber", required: true, componentProps: { min: 0, addonAfter: "次" } },
                            { field: "commands", label: "触发命令", component: "Select", required: true, componentProps: { allowClear: true, mode: "tags", options: [{ value: "*" }] } },
                            { field: "message", label: "维护消息", component: "InputTextArea", componentProps: { rows: 3 } },
                        ],
                    },
                },
                {
                    field: "gsuidCommandMaintenanceReplyList",
                    label: "命令维护回复",
                    component: "GSubForm",
                    bottomHelpMessage: "命中命令时自动回复维护消息，并阻止该消息上报到 GScore。",
                    componentProps: {
                        multiple: true,
                        modalProps: { title: "命令维护回复" },
                        schemas: [
                            { field: "global", label: "全局启用", component: "Switch" },
                            { field: "botIds", label: "Bot 账号", component: "Select", componentProps: { allowClear: true, mode: "tags" } },
                            { field: "enable", label: "启用", component: "Switch", componentProps: { defaultValue: true } },
                            { field: "commands", label: "触发命令", component: "Select", required: true, componentProps: { allowClear: true, mode: "tags", options: [{ value: "*" }] } },
                            { field: "message", label: "维护消息", component: "InputTextArea", componentProps: { rows: 3 } },
                        ],
                    },
                },
                { label: "启用连接 Bot", component: "SOFT_GROUP_BEGIN" },
                {
                    field: "botList",
                    label: "Bot 列表",
                    component: "GSubForm",
                    bottomHelpMessage: "会自动带出当前已登录 Bot；新增 Bot 默认启用受全局开关控制。自定义地址/Token/WS BotID 留空时使用全局配置。",
                    componentProps: {
                        multiple: true,
                        modalProps: { title: "Bot 连接配置" },
                        schemas: [
                            { field: "botId", label: "Bot QQ", component: "Input", required: true, bottomHelpMessage: "填写当前 Yunzai 已登录的 Bot QQ" },
                            { field: "enable", label: "启用连接", component: "Switch", bottomHelpMessage: "控制该 Bot 是否连接 gsuid-core" },
                            { field: "coreUrl", label: "连接地址", component: "Input", componentProps: { placeholder: "留空使用全局连接地址" } },
                            { field: "token", label: "Token", component: "InputPassword", componentProps: { placeholder: "留空使用全局 Token" } },
                            { field: "routeBotId", label: "WS BotID", component: "Input", componentProps: { placeholder: "留空使用全局 WS BotID" } },
                        ],
                    },
                },
            ],
            getConfigData() {
                const config = readConfig()
                return {
                    ...config,
                    botList: mergeLoginBots(config),
                    gsuidBotPrefixList: config.gsuidBotPrefix,
                    gsuidDisconnectReplyList: config.gsuidDisconnectReply,
                    gsuidCommandMaintenanceReplyList: config.gsuidCommandMaintenanceReply,
                }
            },
            setConfigData(data, { Result }) {
                const config = readConfig()
                const next = { ...config, ...data }
                if (Array.isArray(data.botList)) next.bots = restoreBotConfig(data.botList)
                if (Array.isArray(data.gsuidBotPrefixList)) next.gsuidBotPrefix = normalizeRuleList(data.gsuidBotPrefixList, item => ({
                    prefix: String(item?.prefix || ""),
                    skipIfHasPrefix: item?.skipIfHasPrefix !== false,
                    forceAddPrefix: normalizeStringList(item?.forceAddPrefix),
                    noPrefixCommands: normalizeStringList(item?.noPrefixCommands),
                }))
                if (Array.isArray(data.gsuidDisconnectReplyList)) next.gsuidDisconnectReply = normalizeRuleList(data.gsuidDisconnectReplyList, item => ({
                    enable: item?.enable !== false,
                    disconnectCount: normalizeDisconnectCount(item?.disconnectCount),
                    commands: normalizeStringList(item?.commands),
                    message: String(item?.message || ""),
                }))
                if (Array.isArray(data.gsuidCommandMaintenanceReplyList)) next.gsuidCommandMaintenanceReply = normalizeRuleList(data.gsuidCommandMaintenanceReplyList, item => ({
                    enable: item?.enable !== false,
                    commands: normalizeStringList(item?.commands),
                    message: String(item?.message || ""),
                }))
                writeConfig(normalizePersistConfig(next))
                reloadAdapter()
                return Result.ok({}, getSaveMessage(next))
            },
        },
    }
}
