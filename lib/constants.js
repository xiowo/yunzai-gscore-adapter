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
    reportPrivate: true,
    reportGroup: true,
    reportMeta: true,
    silentUnauthorized: false,
    masterBypassGroupDisabled: false,
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