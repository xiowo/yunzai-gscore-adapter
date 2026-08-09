import fs from "node:fs/promises"
import YAML from "yaml"
import { CONFIG_FILE, DEFAULT_CONFIG } from "../lib/constants.js"
import { loadConfig } from "../lib/config.js"
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

function normalizeConfig(body = {}) {
    const bots = Object.create(null)
    for (const item of Array.isArray(body.bots) ? body.bots : []) {
        const botId = stringifyId(item?.botId).trim()
        if (!botId || botId.length > 128 || ["__proto__", "prototype", "constructor"].includes(botId)) continue
        bots[botId] = {
            enable: item?.enable === true,
            coreUrl: normalizeWsUrl(item?.coreUrl, { allowEmpty: true }),
            token: String(item?.token || ""),
        }
    }

    const reconnectInterval = Number(body.reconnectInterval)
    if (!Number.isFinite(reconnectInterval) || reconnectInterval < 1000 || reconnectInterval > 3600000) {
        throw new Error("重连间隔应为 1000 至 3600000 毫秒")
    }

    return {
        enable: body.enable === true,
        coreUrl: normalizeWsUrl(body.coreUrl || DEFAULT_CONFIG.coreUrl),
        token: String(body.token || ""),
        reconnectInterval: Math.round(reconnectInterval),
        reportPrivate: body.reportPrivate === true,
        reportGroup: body.reportGroup === true,
        reportMeta: body.reportMeta === true,
        bots,
    }
}

function emitReload() {
    if (typeof globalThis.Bot?.em === "function") globalThis.Bot.em("gscore-adapter.reload")
    else globalThis.Bot?.emit?.("gscore-adapter.reload")
}

async function getPayload() {
    const config = await loadConfig()
    const botIds = [...new Set([...getOnlineBotIds(), ...Object.keys(config.bots || {})])]
    return {
        ok: true,
        config,
        bots: botIds.map(botId => ({ ...getBotInfo(botId), ...(config.bots?.[botId] || {}) })),
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
            const current = await loadConfig()
            const config = { ...normalizeConfig(req.body), splitNode: current.splitNode ?? DEFAULT_CONFIG.splitNode }
            await fs.writeFile(CONFIG_FILE, YAML.stringify(config), "utf8")
            emitReload()
            res.json({ ...(await getPayload()), message: "配置已保存并触发重载" })
        } catch (error) {
            ctx.logger.warn("[Gscore-Adapter] WebUI 保存配置失败", error)
            res.status(400).json({ ok: false, error: error.message || "保存配置失败" })
        }
    })
}