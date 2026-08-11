import fs from "node:fs/promises"
import YAML from "yaml"
import _ from "lodash"
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG } from "./constants.js"
import { normalizeBool, stringifyId } from "./utils.js"

function normalizeBotConfig(botConfig = {}) {
    return {
        enable: normalizeBool(botConfig.enable, false),
        coreUrl: String(botConfig.coreUrl || "").replace(/\/$/, ""),
        token: String(botConfig.token || ""),
    }
}

function normalizeStringList(value) {
    const list = Array.isArray(value) ? value : []
    return [...new Set(list.map(item => stringifyId(item).trim()).filter(Boolean))]
}

function normalizeGroupRule(rule = {}) {
    return {
        enabled: normalizeBool(rule.enabled, true),
        prefix: String(rule.prefix || "").trim(),
        blackUsers: normalizeStringList(rule.blackUsers),
    }
}

function normalizeGroupRules(groupRules = {}) {
    return Object.fromEntries(
        Object.entries(groupRules || {})
            .map(([groupId, rule]) => [stringifyId(groupId).trim(), normalizeGroupRule(rule)])
            .filter(([groupId]) => Boolean(groupId)),
    )
}

export async function loadConfig() {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    let userConfig = {}
    let missing = false
    try {
        userConfig = YAML.parse(await fs.readFile(CONFIG_FILE, "utf8")) || {}
    } catch {
        missing = true
    }

    const config = _.merge({}, DEFAULT_CONFIG, userConfig)
    config.enable = normalizeBool(config.enable, DEFAULT_CONFIG.enable)
    config.reportPrivate = normalizeBool(config.reportPrivate, DEFAULT_CONFIG.reportPrivate)
    config.reportGroup = normalizeBool(config.reportGroup, DEFAULT_CONFIG.reportGroup)
    config.reportMeta = normalizeBool(config.reportMeta, DEFAULT_CONFIG.reportMeta)
    config.silentUnauthorized = normalizeBool(config.silentUnauthorized, DEFAULT_CONFIG.silentUnauthorized)
    config.masterBypassGroupDisabled = normalizeBool(config.masterBypassGroupDisabled, DEFAULT_CONFIG.masterBypassGroupDisabled)
    config.reconnectInterval = Math.max(1000, Number(config.reconnectInterval) || DEFAULT_CONFIG.reconnectInterval)
    delete config.maxReconnectAttempts
    config.coreUrl = String(config.coreUrl || DEFAULT_CONFIG.coreUrl).replace(/\/$/, "")
    config.token = String(config.token || "")
    delete config.platformBotId
    config.groupRules = normalizeGroupRules(config.groupRules)
    config.bots = Object.fromEntries(
        Object.entries(config.bots || {}).map(([botId, botConfig]) => [stringifyId(botId), normalizeBotConfig(botConfig)]),
    )

    if (missing || YAML.stringify(config) !== YAML.stringify(userConfig)) try {
        await fs.writeFile(CONFIG_FILE, YAML.stringify(config), "utf8")
    } catch { }
    return config
}

export async function saveConfig(config) {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    await fs.writeFile(CONFIG_FILE, YAML.stringify(config), "utf8")
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