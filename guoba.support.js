import fs from "node:fs"
import YAML from "yaml"
import { CONFIG_FILE, DEFAULT_CONFIG, PLUGIN_NAME } from "./lib/constants.js"

function readConfig() {
    try {
        return { ...DEFAULT_CONFIG, ...(YAML.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}) }
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
        }
    }
    return bots
}

function getLoginBotIds() {
    const bot = globalThis.Bot
    const uin = bot?.uin
    if (Array.isArray(uin)) return uin.map(i => String(i)).filter(Boolean)
    if (uin) return [String(uin)]
    return []
}

function mergeLoginBots(bots = {}) {
    const merged = new Map(flattenBotConfig(bots).map(item => [String(item.botId), item]))
    for (const botId of getLoginBotIds()) {
        if (!merged.has(botId)) {
            merged.set(botId, {
                botId,
                enable: false,
                coreUrl: "",
                token: "",
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
                { field: "coreUrl", label: "全局连接地址", component: "Input", componentProps: { placeholder: "ws://127.0.0.1:8765" } },
                { field: "token", label: "全局 Token", component: "InputPassword", componentProps: { placeholder: "core 配置 WS_TOKEN 时填写" } },
                { field: "reconnectInterval", label: "重连间隔(ms)", component: "InputNumber", componentProps: { min: 1000, step: 1000 } },
                { field: "reportPrivate", label: "上报私聊", component: "Switch" },
                { field: "reportGroup", label: "上报群聊", component: "Switch" },
                { field: "reportMeta", label: "上报 Meta 事件", component: "Switch" },
                { label: "启用连接 Bot", component: "SOFT_GROUP_BEGIN" },
                {
                    field: "botList",
                    label: "Bot 列表",
                    component: "GSubForm",
                    bottomHelpMessage: "会自动带出当前已登录 Bot；启用后才会连接 core。自定义地址/Token 留空时使用全局配置，路由 ID 固定为 Yunzai-{qq号}。",
                    componentProps: {
                        multiple: true,
                        modalProps: { title: "Bot 连接配置" },
                        schemas: [
                            { field: "botId", label: "Bot QQ", component: "Input", required: true, bottomHelpMessage: "填写当前 Yunzai 已登录的 Bot QQ" },
                            { field: "enable", label: "启用连接", component: "Switch", bottomHelpMessage: "默认关闭，开启后该 Bot 才会连接 gsuid-core" },
                            { field: "coreUrl", label: "连接地址", component: "Input", componentProps: { placeholder: "留空使用全局连接地址" } },
                            { field: "token", label: "Token", component: "InputPassword", componentProps: { placeholder: "留空使用全局 Token" } },
                        ],
                    },
                },
            ],
            getConfigData() {
                const config = readConfig()
                return {
                    ...config,
                    botList: mergeLoginBots(config.bots),
                }
            },
            setConfigData(data, { Result }) {
                const config = readConfig()
                const next = { ...config, ...data }
                if (Array.isArray(data.botList)) next.bots = restoreBotConfig(data.botList)
                delete next.platformBotId
                delete next.botList
                writeConfig(next)
                reloadAdapter()
                return Result.ok({}, getSaveMessage(next))
            },
        },
    }
}