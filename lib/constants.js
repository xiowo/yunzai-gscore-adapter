import path from "node:path"

export const PLUGIN_NAME = "Gscore-Adapter"
export const PLUGIN_DIR = path.resolve("plugins", PLUGIN_NAME)
export const CONFIG_DIR = path.join(PLUGIN_DIR, "config")
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml")
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

export const DEFAULT_CONFIG = {
    enable: true,
    coreUrl: "ws://127.0.0.1:8765",
    token: "",
    reconnectInterval: 5000,
    reportPrivate: true,
    reportGroup: true,
    reportMeta: true,
    silentUnauthorized: false,
    masterBypassGroupDisabled: false,
    groupRules: {},
    bots: {},
}