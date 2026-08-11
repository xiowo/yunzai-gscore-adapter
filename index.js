import fs from "node:fs/promises"
import path from "node:path"
import { update as FrameworkUpdate } from "../other/update.js"
import { GscoreClient } from "./lib/client.js"
import { getBotRuntimeConfig, hasCustomConnection, isBotEnabled, loadConfig, saveConfig } from "./lib/config.js"
import { PLUGIN_DIR, PLUGIN_NAME } from "./lib/constants.js"
import { getOnlineBotIds, stringifyId } from "./lib/utils.js"

const clients = new Map()
let eventsBound = false
const connectEventsBound = new Set()
let updating = false
const startedAt = Date.now()

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const days = Math.floor(totalSeconds / 86400)
    const hours = Math.floor((totalSeconds % 86400) / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const parts = []
    if (days) parts.push(`${days}天`)
    if (hours) parts.push(`${hours}小时`)
    if (minutes) parts.push(`${minutes}分钟`)
    if (!parts.length || seconds) parts.push(`${seconds}秒`)
    return parts.join("")
}

async function getPackageVersion() {
    const pkg = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, "package.json"), "utf8"))
    return stringifyId(pkg.version || "0.0.0")
}

function stopAllClients() {
    for (const client of clients.values()) client.stop()
    clients.clear()
}

function getClientKey(config) {
    return `${config.coreUrl}\n${config.token}\n${config.routeBotId}`
}

function buildRuntimeConfigs(config, botIds) {
    const groups = new Map()
    for (const botId of botIds) {
        const selfId = stringifyId(botId)
        if (!selfId || !isBotEnabled(config, selfId)) continue
        const botConfig = config.bots?.[selfId] || {}
        const runtimeConfig = getBotRuntimeConfig(config, selfId)
        if (!hasCustomConnection(botConfig)) runtimeConfig.routeBotId = config.routeBotId
        const key = hasCustomConnection(botConfig) ? getClientKey(runtimeConfig) : "default"
        const group = groups.get(key) || { ...runtimeConfig, selfId, selfIds: [], botConfigs: {} }
        group.selfIds.push(selfId)
        group.botConfigs[selfId] = runtimeConfig
        groups.set(key, group)
    }
    return groups
}

function startClient(key, runtimeConfig) {
    const oldClient = clients.get(key)
    if (oldClient?.hasSameConnection(runtimeConfig)) {
        oldClient.updateConfig(runtimeConfig)
        return true
    }

    oldClient?.stop()
    const client = new GscoreClient(runtimeConfig)
    clients.set(key, client)
    if (process.env.GSCORE_ADAPTER_DRY_RUN !== "1") client.start()
    return true
}

function bindGlobalEvents() {
    if (eventsBound) return
    eventsBound = true
    Bot.on("message", e => {
        for (const client of clients.values()) client.reportMessage(e).catch(err => logger.error(`[${PLUGIN_NAME}] 上报消息失败`, err))
    })
    Bot.on("notice", e => {
        for (const client of clients.values()) client.reportMeta(e).catch(err => logger.error(`[${PLUGIN_NAME}] 上报元事件失败`, err))
    })
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

    const onlineBotIds = new Set(getOnlineBotIds())
    if (onlySelfId) onlineBotIds.add(stringifyId(onlySelfId))
    const runtimeConfigs = buildRuntimeConfigs(config, onlineBotIds)
    const keepBotIds = new Set()
    for (const [key, runtimeConfig] of runtimeConfigs) {
        if (startClient(key, runtimeConfig)) keepBotIds.add(key)
    }
    for (const [key, client] of clients.entries()) {
        if (keepBotIds.has(key)) continue
        client.stop()
        clients.delete(key)
    }
}

await startAdapter()

export class GscoreAdapterStatus extends plugin {
    constructor() {
        super({
            name: "Gscore-Adapter状态",
            dsc: "查看/重连/管理 GsCore 早柚适配器",
            event: "message",
            priority: 500,
            rule: [
                { reg: "^#?gscore(状态|status)$", fnc: "status" },
                { reg: "^#?gscore(重连|reconnect)$", fnc: "reconnect" },
                { reg: "^#早柚status$", fnc: "adapterStatus" },
                { reg: "^#早柚version$", fnc: "version" },
                { reg: "^#早柚更新$", fnc: "updatePlugin" },
                { reg: "^#早柚群禁用$", fnc: "disableGroup" },
                { reg: "^#早柚群启用$", fnc: "enableGroup" },
                { reg: "^#早柚拉黑", fnc: "blackUser" },
                { reg: "^#早柚取消拉黑", fnc: "unblackUser" },
                { reg: "^#早柚群前缀", fnc: "setGroupPrefix" },
            ],
        })
    }

    async status() {
        if (!(await this.requireMaster())) return false
        const lines = [...clients.entries()].map(([botId, client]) => {
            const state = client.connected ? "已连接" : client.connecting ? "连接中" : "未连接"
            return `${botId}：${state}（${client.selfIds?.size || 0} 个 Bot） ${client.url.replace(/token=[^&]+/, "token=***")}`
        })
        await this.reply(`Gscore-Adapter：${lines.length ? "\n" + lines.join("\n") : "未启用任何 Bot"}`, true)
        return true
    }

    async reconnect() {
        if (!(await this.requireMaster())) return false
        await startAdapter()
        await this.reply("Gscore-Adapter 已重新加载配置并发起连接", true)
        return true
    }

    async adapterStatus() {
        const config = await loadConfig()
        const groupRules = Object.values(config.groupRules || {})
        const enabledBotCount = Object.values(config.bots || {}).filter(item => item?.enable).length
        const disabledGroupCount = groupRules.filter(rule => rule?.enabled === false).length
        const blackUserCount = groupRules.reduce((sum, rule) => sum + new Set(rule?.blackUsers || []).size, 0)
        const connectedCount = [...clients.values()].reduce((sum, client) => sum + (client.connected ? client.selfIds?.size || 0 : 0), 0)
        await this.reply([
            "🦊 早柚适配器状态",
            `启用 Bot：${enabledBotCount} 个（已连接 ${connectedCount} 个）`,
            `运行时间：${formatDuration(Date.now() - startedAt)}`,
            `拉黑群：${disabledGroupCount} 个`,
            `拉黑用户：${blackUserCount} 人`,
        ].join("\n"), true)
        return true
    }

    async version() {
        await this.reply(`🦊适配器 v${await getPackageVersion()}`, true)
        return true
    }

    isGroupAdmin() {
        return this.e?.isMaster || this.e?.member?.is_owner || this.e?.member?.is_admin || ["owner", "admin"].includes(this.e?.sender?.role)
    }

    async replyNoPermission(message) {
        const config = await loadConfig()
        if (!config.silentUnauthorized) await this.reply(message, true)
        return false
    }

    async requireMaster() {
        if (this.e?.isMaster) return true
        return this.replyNoPermission("❌仅主人可使用该命令")
    }

    async requireGroupAdmin() {
        if (!this.e?.isGroup || !this.e?.group_id) {
            await this.reply("❌ 请在群聊中使用该命令", true)
            return false
        }
        if (!this.isGroupAdmin()) {
            return this.replyNoPermission("❌ 仅群主/管理员/主人可使用该命令")
        }
        return true
    }

    getAtUserId() {
        const at = this.e?.at || this.e?.atBot || ""
        const atId = stringifyId(at)
        if (atId && atId !== stringifyId(this.e?.self_id) && !["all", "0"].includes(atId)) return atId
        for (const seg of Array.isArray(this.e?.message) ? this.e.message : []) {
            const userId = stringifyId(seg?.qq)
            if (seg?.type === "at" && userId && userId !== stringifyId(this.e?.self_id) && !["all", "0"].includes(userId)) return userId
        }
        return ""
    }

    atUser(userId) {
        return globalThis.segment?.at ? globalThis.segment.at(userId) : `@${userId}`
    }

    async updateGroupRule(mutator) {
        const config = await loadConfig()
        const groupId = stringifyId(this.e.group_id)
        const rule = { enabled: true, prefix: "", blackUsers: [], ...(config.groupRules?.[groupId] || {}) }
        mutator(rule)
        config.groupRules = { ...(config.groupRules || {}), [groupId]: rule }
        await saveConfig(config)
        for (const client of clients.values()) {
            client.config.groupRules = config.groupRules
            client.config.silentUnauthorized = config.silentUnauthorized
            client.config.masterBypassGroupDisabled = config.masterBypassGroupDisabled
            for (const item of client.botConfigs?.values?.() || []) {
                item.groupRules = config.groupRules
                item.silentUnauthorized = config.silentUnauthorized
                item.masterBypassGroupDisabled = config.masterBypassGroupDisabled
            }
        }
        return rule
    }

    async enableGroup() {
        if (!(await this.requireGroupAdmin())) return false
        await this.updateGroupRule(rule => { rule.enabled = true })
        await this.reply("✅ 本群早柚核心适配已开启", true)
        return true
    }

    async disableGroup() {
        if (!(await this.requireGroupAdmin())) return false
        await this.updateGroupRule(rule => { rule.enabled = false })
        await this.reply("🚫 本群早柚核心适配已关闭", true)
        return true
    }

    async blackUser() {
        if (!(await this.requireGroupAdmin())) return false
        const userId = this.getAtUserId()
        if (!userId) {
            await this.reply("❌ 请 @ 要拉黑的用户", true)
            return false
        }
        await this.updateGroupRule(rule => {
            rule.blackUsers = [...new Set([...(rule.blackUsers || []), userId])]
        })
        await this.reply(["✅ 已拉黑用户 ", this.atUser(userId)], true)
        return true
    }

    async unblackUser() {
        if (!(await this.requireGroupAdmin())) return false
        const userId = this.getAtUserId()
        if (!userId) {
            await this.reply("❌请 @ 要取消拉黑的用户", true)
            return false
        }
        await this.updateGroupRule(rule => {
            rule.blackUsers = (rule.blackUsers || []).filter(id => id !== userId)
        })
        await this.reply(["✅ 已取消拉黑用户 ", this.atUser(userId)], true)
        return true
    }

    async setGroupPrefix() {
        if (!(await this.requireGroupAdmin())) return false
        const prefix = stringifyId(this.e?.msg).replace(/^#早柚群前缀/, "").trim()
        await this.updateGroupRule(rule => { rule.prefix = prefix })
        await this.reply(prefix ? `✅ 已设置本群早柚前缀：${prefix}` : "✅ 已清空本群早柚前缀", true)
        return true
    }

    async updatePlugin() {
        if (!(await this.requireMaster())) return false
        if (updating) {
            await this.reply("Gscore-Adapter 正在更新，请稍候再试", true)
            return false
        }
        updating = true
        try {
            const updater = new FrameworkUpdate()
            updater.e = { ...this.e, msg: `#更新${PLUGIN_NAME}` }
            updater.reply = this.reply.bind(this)
            return updater.update()
        } finally {
            updating = false
        }
    }
}