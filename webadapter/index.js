import { DEFAULT_CONFIG } from "../lib/constants.js"
import { loadConfig, saveConfig } from "../lib/config.js"
import { getOnlineBotIds, stringifyId } from "../lib/utils.js"

function getBotInfo(botId) {
    const bot = globalThis.Bot?.[botId] || globalThis.Bot?.bots?.[botId]
    return {
        botId,
        name: String(bot?.nickname || bot?.name || bot?.info?.nickname || ""),
        avatar: botId && /^\d+$/.test(botId) ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(botId)}&s=100` : "",
        online: getOnlineBotIds().includes(botId),
    }
}

function normalizeWsUrl(value, { allowEmpty = false } = {}) {
    const text = String(value || "").trim().replace(/\/$/, "")
    if (allowEmpty && !text) return ""
    let url
    try {
        url = new URL(text)
    } catch {
        throw new Error(`无效的 WebSocket 地址：${text || "空值"}`)
    }
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error("连接地址仅支持 ws:// 或 wss://")
    return text
}

function normalizeStringList(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => stringifyId(item).trim()).filter(Boolean))]
}

function normalizeRuleList(value, normalizeItem) {
    if (!Array.isArray(value)) return []
    return value.map(item => ({
        global: item?.global === true,
        botIds: normalizeStringList(item?.botIds).filter(botId => botId.length <= 128),
        ...normalizeItem(item),
    })).filter(item => item.global || item.botIds.length)
}

function normalizeDisconnectCount(value) {
    const count = Number(value)
    return Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 3
}

function normalizeConfig(body = {}, currentConfig = {}) {
    const bots = Object.create(null)
    for (const item of Array.isArray(body.bots) ? body.bots : []) {
        const botId = stringifyId(item?.botId).trim()
        if (!botId || botId.length > 128 || ["__proto__", "prototype", "constructor"].includes(botId)) continue
        bots[botId] = {
            enable: item?.enable === true,
            coreUrl: normalizeWsUrl(item?.coreUrl, { allowEmpty: true }),
            token: String(item?.token || ""),
            routeBotId: stringifyId(item?.routeBotId).trim(),
        }
    }

    const reconnectInterval = Number(body.reconnectInterval)
    if (!Number.isFinite(reconnectInterval) || reconnectInterval < 1000 || reconnectInterval > 3600000) {
        throw new Error("重连间隔应为 1000 至 3600000 毫秒")
    }
    return {
        enable: body.enable === true,
        defaultBotEnable: body.defaultBotEnable === true,
        coreUrl: normalizeWsUrl(body.coreUrl || DEFAULT_CONFIG.coreUrl),
        token: String(body.token || ""),
        routeBotId: stringifyId(body.routeBotId || DEFAULT_CONFIG.routeBotId || "Yunzai").trim(),
        reconnectInterval: Math.round(reconnectInterval),
        reportPrivate: body.reportPrivate === true,
        reportGroup: body.reportGroup === true,
        reportMeta: body.reportMeta === true,
        uploadLocalMarkdownImages: body.uploadLocalMarkdownImages === true,
        gsuidCoreRoot: String(body.gsuidCoreRoot || "").trim(),
        silentUnauthorized: body.silentUnauthorized === true,
        masterBypassGroupDisabled: body.masterBypassGroupDisabled === true,
        quickEggCheck: body.quickEggCheck === undefined ? currentConfig.quickEggCheck === true : body.quickEggCheck === true,
        quickEggCheckGlobal: body.quickEggCheckGlobal === undefined ? currentConfig.quickEggCheckGlobal === true : body.quickEggCheckGlobal === true,
        quickEggCheckBots: normalizeStringList(body.quickEggCheckBots ?? currentConfig.quickEggCheckBots),
        gsuidBotPrefix: normalizeRuleList(body.gsuidBotPrefix ?? currentConfig.gsuidBotPrefix, item => ({
            prefix: String(item?.prefix || ""),
            skipIfHasPrefix: item?.skipIfHasPrefix !== false,
            forceAddPrefix: normalizeStringList(item?.forceAddPrefix),
            noPrefixCommands: normalizeStringList(item?.noPrefixCommands),
        })),
        gsuidDisconnectReply: normalizeRuleList(body.gsuidDisconnectReply ?? currentConfig.gsuidDisconnectReply, item => ({
            enable: item?.enable !== false,
            disconnectCount: normalizeDisconnectCount(item?.disconnectCount),
            commands: normalizeStringList(item?.commands),
            message: String(item?.message || ""),
        })),
        gsuidCommandMaintenanceReply: normalizeRuleList(body.gsuidCommandMaintenanceReply ?? currentConfig.gsuidCommandMaintenanceReply, item => ({
            enable: item?.enable !== false,
            commands: normalizeStringList(item?.commands),
            message: String(item?.message || ""),
        })),
        groupRules: currentConfig.groupRules || {},
        bots,
    }
}

function emitReload() {
    if (typeof globalThis.Bot?.em === "function") globalThis.Bot.em("gscore-adapter.reload")
    else globalThis.Bot?.emit?.("gscore-adapter.reload")
}

async function getPayload() {
    const config = await loadConfig()
    const configuredRuleBotIds = [
        ...(config.quickEggCheckBots || []),
        ...(config.gsuidBotPrefix || []).flatMap(rule => rule.botIds || []),
        ...(config.gsuidDisconnectReply || []).flatMap(rule => rule.botIds || []),
        ...(config.gsuidCommandMaintenanceReply || []).flatMap(rule => rule.botIds || []),
    ]
    const botIds = [...new Set([...getOnlineBotIds(), ...Object.keys(config.bots || {}), ...configuredRuleBotIds])]
    return {
        ok: true,
        config,
        bots: botIds.map(botId => ({ enable: config.defaultBotEnable, ...getBotInfo(botId), ...(config.bots?.[botId] || {}) })),
    }
}

export function init(ctx) {
    ctx.registerPage({
        id: "gscore-adapter",
        title: "Gscore 适配器",
        icon: "🦊",
        priority: 40,
        src: "page.html",
        style: "page.css",
    })

    ctx.registerApi("get", "/gscore-adapter/config", async (_req, res) => {
        try {
            res.json(await getPayload())
        } catch (error) {
            ctx.logger.error("[Gscore-Adapter] WebUI 读取配置失败", error)
            res.status(500).json({ ok: false, error: error.message || "读取配置失败" })
        }
    })

    ctx.registerApi("post", "/gscore-adapter/config", async (req, res) => {
        try {
            const config = normalizeConfig(req.body, await loadConfig())
            await saveConfig(config)
            emitReload()
            res.json({ ...(await getPayload()), message: "配置已保存并触发重载" })
        } catch (error) {
            ctx.logger.warn("[Gscore-Adapter] WebUI 保存配置失败", error)
            res.status(400).json({ ok: false, error: error.message || "保存配置失败" })
        }
    })
}