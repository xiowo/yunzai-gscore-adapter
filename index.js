import { GscoreClient } from "./lib/client.js"
import { getBotRuntimeConfig, isBotEnabled, loadConfig } from "./lib/config.js"
import { PLUGIN_NAME } from "./lib/constants.js"
import { getOnlineBotIds, stringifyId } from "./lib/utils.js"

const clients = new Map()
let eventsBound = false
const connectEventsBound = new Set()

function stopAllClients() {
    for (const client of clients.values()) client.stop()
    clients.clear()
}

function startClient(config, selfId) {
    const botId = stringifyId(selfId)
    if (!botId || !isBotEnabled(config, botId)) return false

    const runtimeConfig = getBotRuntimeConfig(config, botId)
    const oldClient = clients.get(botId)
    if (oldClient?.hasSameConnection(runtimeConfig)) {
        oldClient.updateConfig(runtimeConfig)
        return true
    }

    oldClient?.stop()
    const client = new GscoreClient(runtimeConfig)
    clients.set(botId, client)
    if (process.env.GSCORE_ADAPTER_DRY_RUN !== "1") client.start()
    return true
}

function bindGlobalEvents() {
    if (eventsBound) return
    eventsBound = true
    Bot.on("message", e => clients.get(stringifyId(e?.self_id))?.reportMessage(e).catch(err => logger.error(`[${PLUGIN_NAME}] 上报消息失败`, err)))
    Bot.on("notice", e => clients.get(stringifyId(e?.self_id))?.reportMeta(e).catch(err => logger.error(`[${PLUGIN_NAME}] 上报元事件失败`, err)))
    Bot.on("connect", e => startAdapter(stringifyId(e?.self_id)))
    Bot.on("gscore-adapter.reload", () => startAdapter().catch(err => logger.error(`[${PLUGIN_NAME}] 自动重载失败`, err)))
}

function bindConfiguredConnectEvents(config) {
    for (const botId of new Set([...Object.keys(config.bots || {}), ...getOnlineBotIds()])) {
        if (!botId || connectEventsBound.has(botId)) continue
        connectEventsBound.add(botId)
        Bot.on(`connect.${botId}`, () => startAdapter(botId))
    }
}

async function startAdapter(onlySelfId = "") {
    const config = await loadConfig()
    bindGlobalEvents()
    bindConfiguredConnectEvents(config)

    if (!config.enable) {
        stopAllClients()
        logger.info(`[${PLUGIN_NAME}] 全局未启用，跳过连接`)
        return
    }

    if (onlySelfId) {
        const botId = stringifyId(onlySelfId)
        if (!startClient(config, botId)) {
            clients.get(botId)?.stop()
            clients.delete(botId)
        }
        return
    }

    const onlineBotIds = new Set(getOnlineBotIds())
    const keepBotIds = new Set()
    for (const botId of onlineBotIds) {
        if (startClient(config, botId)) keepBotIds.add(stringifyId(botId))
    }
    for (const [botId, client] of clients.entries()) {
        if (keepBotIds.has(botId)) continue
        client.stop()
        clients.delete(botId)
    }
}

await startAdapter()

export class GscoreAdapterStatus extends plugin {
    constructor() {
        super({
            name: "Gscore-Adapter状态",
            dsc: "查看/重连 GsCore 早柚适配器",
            event: "message",
            priority: 500,
            rule: [
                { reg: "^#?gscore(状态|status)$", fnc: "status", permission: "master" },
                { reg: "^#?gscore(重连|reconnect)$", fnc: "reconnect", permission: "master" },
            ],
        })
    }

    async status() {
        const lines = [...clients.entries()].map(([botId, client]) => {
            const state = client.connected ? "已连接" : client.connecting ? "连接中" : "未连接"
            return `${botId}：${state} ${client.url.replace(/token=[^&]+/, "token=***")}`
        })
        await this.reply(`Gscore-Adapter：${lines.length ? "\n" + lines.join("\n") : "未启用任何 Bot"}`, true)
        return true
    }

    async reconnect() {
        await startAdapter()
        await this.reply("Gscore-Adapter 已重新加载配置并发起连接", true)
        return true
    }
}