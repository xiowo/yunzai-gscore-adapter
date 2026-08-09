import fs from "node:fs/promises"
import YAML from "yaml"
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG } from "./constants.js"
import { normalizeBool, stringifyId } from "./utils.js"

function normalizeBotConfig(botConfig = {}) {
    return {
        enable: normalizeBool(botConfig.enable, false),
        coreUrl: String(botConfig.coreUrl || "").replace(/\/$/, ""),
        token: String(botConfig.token || ""),
    }
}

export async function loadConfig() {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    let userConfig = {}
    let needInit = false
    try {
        userConfig = YAML.parse(await fs.readFile(CONFIG_FILE, "utf8")) || {}
    } catch {
        needInit = true
    }

    const config = { ...DEFAULT_CONFIG, ...userConfig }
    config.enable = normalizeBool(config.enable, DEFAULT_CONFIG.enable)
    config.reportPrivate = normalizeBool(config.reportPrivate, DEFAULT_CONFIG.reportPrivate)
    config.reportGroup = normalizeBool(config.reportGroup, DEFAULT_CONFIG.reportGroup)
    config.reportMeta = normalizeBool(config.reportMeta, DEFAULT_CONFIG.reportMeta)
    config.splitNode = normalizeBool(config.splitNode, DEFAULT_CONFIG.splitNode)
    config.reconnectInterval = Math.max(1000, Number(config.reconnectInterval) || DEFAULT_CONFIG.reconnectInterval)
    config.coreUrl = String(config.coreUrl || DEFAULT_CONFIG.coreUrl).replace(/\/$/, "")
    config.token = String(config.token || "")
    delete config.platformBotId
    config.bots = Object.fromEntries(
        Object.entries(config.bots || {}).map(([botId, botConfig]) => [stringifyId(botId), normalizeBotConfig(botConfig)]),
    )

    if (needInit) try {
        await fs.writeFile(CONFIG_FILE, YAML.stringify(config), "utf8")
    } catch { }
    return config
}

export function getBotRuntimeConfig(config, selfId) {
    const botConfig = config.bots?.[stringifyId(selfId)] || {}
    return {
        ...config,
        selfId: stringifyId(selfId),
        coreUrl: botConfig.coreUrl || config.coreUrl,
        token: botConfig.token || config.token,
    }
}

export function isBotEnabled(config, selfId) {
    const botConfig = config.bots?.[stringifyId(selfId)]
    return normalizeBool(botConfig?.enable, false)
}