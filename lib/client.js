import { WebSocket } from "ws"
import { PLUGIN_NAME, QQBOT_MESSAGE_ID_KEY_PREFIX, QQBOT_MESSAGE_ID_REPLY_LIMIT, QQBOT_MESSAGE_ID_TTL, ROUTE_BOT_ID_TEMPLATE } from "./constants.js"
import { makeReceivePacket, resolvePlatformBotId, toYunzaiButtons, toYunzaiMessage } from "./message.js"
import { makeMetaPacket } from "./meta.js"
import { maskBase64, resolveRouteBotId, stringifyId } from "./utils.js"

export class GscoreClient {
    constructor(config) {
        this.setConfig(config)
        this.ws = null
        this.queue = []
        this.connected = false
        this.connecting = false
        this.closed = false
        this.reconnectTimer = null
    }

    setConfig(config) {
        this.config = config
        this.selfIds = new Set((config.selfIds || [config.selfId]).map(stringifyId).filter(Boolean))
        this.selfId = stringifyId(config.selfId || [...this.selfIds][0])
        this.botConfigs = new Map(Object.entries(config.botConfigs || { [this.selfId]: config }).map(([selfId, item]) => [stringifyId(selfId), item]))
        this.routeBotId = stringifyId(config.routeBotId || resolveRouteBotId(ROUTE_BOT_ID_TEMPLATE, this.selfId))
    }

    get url() {
        const url = new URL(`/ws/${encodeURIComponent(this.routeBotId)}`, this.config.coreUrl)
        if (this.config.token) url.searchParams.set("token", this.config.token)
        return url.toString()
    }

    start() {
        if (!this.config.enable) {
            logger.info(`[${PLUGIN_NAME}] 未启用，跳过连接`)
            return
        }
        this.connect()
    }

    updateConfig(config) {
        this.setConfig(config)
    }

    hasSameConnection(config) {
        const nextRouteBotId = stringifyId(config.routeBotId || resolveRouteBotId(ROUTE_BOT_ID_TEMPLATE, stringifyId(config.selfId)))
        const nextUrl = new URL(`/ws/${encodeURIComponent(nextRouteBotId)}`, config.coreUrl)
        if (config.token) nextUrl.searchParams.set("token", config.token)
        return this.url === nextUrl.toString()
    }

    stop() {
        this.closed = true
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.connected = false
        this.connecting = false
        const ws = this.ws
        this.ws = null
        if (!ws || ws.readyState === WebSocket.CLOSED) return
        try {
            ws.terminate?.()
        } catch {
            ws.close()
        }
    }

    connect() {
        if (this.closed || this.connecting || this.connected) return
        this.connecting = true
        const ws = new WebSocket(this.url, { maxPayload: 2 ** 26, handshakeTimeout: 60000 })
        this.ws = ws

        ws.on("open", () => {
            this.connecting = false
            this.connected = true
            logger.mark(`[${PLUGIN_NAME}] 已连接 GsCore: ${this.url.replace(/token=[^&]+/, "token=***")}`)
            this.flushQueue()
        })

        ws.on("message", raw => this.handleCoreMessage(raw).catch(err => logger.error(`[${PLUGIN_NAME}] 处理 core 下发失败`, err)))
        ws.on("error", err => logger.error(`[${PLUGIN_NAME}] WebSocket 错误: ${err.message}`))
        ws.on("close", (code, reason) => {
            this.connecting = false
            this.connected = false
            logger.warn(`[${PLUGIN_NAME}] 与 GsCore 断开: ${code} ${reason?.toString?.() || ""}`)
            this.scheduleReconnect()
        })
    }

    scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, this.config.reconnectInterval)
    }

    sendPacket(packet) {
        const payload = Buffer.from(JSON.stringify(packet))
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(payload)
            return
        }
        this.queue.push(payload)
        this.connect()
    }

    flushQueue() {
        while (this.queue.length && this.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(this.queue.shift())
        }
    }

    getEventConfig(e) {
        return this.botConfigs.get(stringifyId(e?.self_id))
    }

    shouldIgnoreEvent(e, config = this.getEventConfig(e)) {
        if (!e || e.adapter_id === "GSUIDCore") return true
        if (!config || !this.selfIds.has(stringifyId(e.self_id))) return true
        if (stringifyId(e.self_id) === this.routeBotId) return true
        if (e.post_type === "message" && /^\s*#(?:早柚|gscore)/i.test(stringifyId(e.raw_message || e.msg))) return true
        if (e.post_type === "message" && e.message_type === "private" && !config.reportPrivate) return true
        if (e.post_type === "message" && e.message_type === "group" && !config.reportGroup) return true
        if (e.post_type === "message" && e.message_type === "group") {
            const rule = config.groupRules?.[stringifyId(e.group_id)]
            if (rule?.enabled === false && !(config.masterBypassGroupDisabled && e.isMaster)) return true
            if (rule?.blackUsers?.includes?.(stringifyId(e.user_id))) return true
        }
        return false
    }

    normalizePrefixedGroupMessage(e) {
        if (e?.post_type !== "message" || e?.message_type !== "group") return e
        const prefix = String(this.getEventConfig(e)?.groupRules?.[stringifyId(e.group_id)]?.prefix || "")
        if (!prefix) return e

        const raw = stringifyId(e.raw_message || e.msg || "")
        const leading = raw.match(/^[\s/]*/)?.[0] || ""
        const body = raw.slice(leading.length)
        if (!body.startsWith(prefix)) return null

        const nextText = body.slice(prefix.length)
        const nextMessage = Array.isArray(e.message) ? e.message.map(seg => ({ ...seg })) : []
        const firstText = nextMessage.find(seg => seg?.type === "text")
        if (firstText) firstText.text = nextText
        else nextMessage.unshift({ type: "text", text: nextText })
        return { ...e, raw_message: nextText, msg: nextText, message: nextMessage }
    }

    async reportMessage(e) {
        const config = this.getEventConfig(e)
        if (this.shouldIgnoreEvent(e, config)) return
        const event = this.normalizePrefixedGroupMessage(e)
        if (!event) return
        await this.rememberQQBotMessageId(event)
        const packet = makeReceivePacket(event, config)
        if (!packet) return

        logger.debug(`[${PLUGIN_NAME}] 上报消息: ${maskBase64(packet)}`)
        this.sendPacket(packet)
    }

    async reportMeta(e) {
        const config = this.getEventConfig(e)
        if (!config || !this.selfIds.has(stringifyId(e?.self_id))) return
        const packet = makeMetaPacket(e, config)
        if (!packet) return

        logger.debug(`[${PLUGIN_NAME}] 上报元事件: ${maskBase64(packet)}`)
        this.sendPacket(packet)
    }

    async handleCoreMessage(raw) {
        let msg
        try {
            msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw))
        } catch (err) {
            logger.error(`[${PLUGIN_NAME}] core 下发 JSON 解析失败`, err)
            return
        }

        if (this.handleCoreLog(msg)) return
        const botSelfId = stringifyId(msg.bot_self_id)
        const bot = Bot?.[botSelfId]
        if (msg.bot_id !== resolvePlatformBotId({ bot })) return

        let recallId = null
        try {
            recallId = await this.dispatchCoreSend(msg)
        } finally {
            if (msg.echo) this.sendRecallReceipt(msg, recallId)
        }
    }

    handleCoreLog(msg) {
        if (msg.bot_id !== this.routeBotId) return false
        const first = msg.content?.[0]
        if (!first?.type?.startsWith?.("log_")) return true
        const level = first.type.split("_").pop()?.toLowerCase?.() || "info"
        const text = `[GsCore] ${first.data}`
        if (level === "warning" || level === "warn") logger.warn(text)
        else if (level === "error") logger.error(text)
        else if (level === "success" || level === "mark") logger.mark(text)
        else logger.info(text)
        return true
    }

    async dispatchCoreSend(msg) {
        const control = msg.content?.length === 1 ? msg.content[0] : null
        if (control?.type === "excute_delete_message") return this.deleteMessage(msg, control.data)
        if (control?.type === "excute_ban_user") return this.banUser(msg, control.data)

        const targetType = msg.target_type === "direct" ? "direct" : "group"
        const botSelfId = stringifyId(msg.bot_self_id)
        const bot = Bot?.[botSelfId]
        const targetId = bot?.adapter?.id === "QQBot"
            ? this.normalizeQQBotTargetId(botSelfId, targetType, msg.target_id)
            : stringifyId(msg.target_id)
        if (!targetId) return null

        logger.debug(`[${PLUGIN_NAME}] core 下发消息: ${maskBase64(msg)}`)
        return this.sendYunzaiMessage(msg.bot_self_id, targetType, targetId, msg.content || [])
    }

    async sendYunzaiMessage(selfId, targetType, targetId, content) {
        const bot = Bot?.[selfId]
        const isQQBot = bot?.adapter?.id === "QQBot"
        if (isQQBot) {
            const chunks = await this.toQQBotMessageChunks(content, stringifyId(selfId))
            if (!chunks.length) return null
            const messageIds = []
            for (const chunk of chunks) {
                const ret = await this.sendQQBotMessage(bot, stringifyId(selfId), targetType, targetId, chunk)
                const id = ret?.message_id ?? ret?.data?.message_id
                if (Array.isArray(id)) messageIds.push(...id)
                else if (id) messageIds.push(id)
            }
            if (!messageIds.length) return null
            return messageIds.length === 1 ? messageIds[0] : messageIds
        }

        const message = await toYunzaiMessage(content, this.botConfigs.get(stringifyId(selfId)) || this.config)
        if (!message.length) return null
        const ret = targetType === "direct"
            ? await Bot.sendFriendMsg(selfId, targetId, message)
            : await Bot.sendGroupMsg(selfId, targetId, message)
        return ret?.message_id ?? ret?.data?.message_id ?? null
    }

    getQQBotMessageIdKey(selfId, targetType, targetId) {
        return `${QQBOT_MESSAGE_ID_KEY_PREFIX}:${stringifyId(selfId)}:${targetType}:${stringifyId(targetId)}`
    }

    getQQBotMessageReplyCountKey(selfId, messageId) {
        return `${QQBOT_MESSAGE_ID_KEY_PREFIX}:ReplyCount:${stringifyId(selfId)}:${stringifyId(messageId)}`
    }

    async rememberQQBotMessageId(e) {
        if (e?.bot?.adapter?.id !== "QQBot") return
        const selfId = stringifyId(e.self_id)
        const messageId = stringifyId(e.message_id)
        const targetType = e.message_type === "private" ? "direct" : "group"
        const targetId = this.normalizeQQBotTargetId(selfId, targetType, targetType === "direct" ? e.user_id : e.group_id)
        if (!messageId || !targetId) return
        await redis.set(this.getQQBotMessageIdKey(selfId, targetType, targetId), messageId, { EX: QQBOT_MESSAGE_ID_TTL })
        await redis.del(this.getQQBotMessageReplyCountKey(selfId, messageId))
    }

    async getLatestQQBotMessageId(selfId, targetType, targetId) {
        return stringifyId(await redis.get(this.getQQBotMessageIdKey(selfId, targetType, targetId)))
    }

    async canReplyQQBotMessage(selfId, messageId) {
        const key = this.getQQBotMessageReplyCountKey(selfId, messageId)
        const count = await redis.incr(key)
        if (count === 1) await redis.expire(key, QQBOT_MESSAGE_ID_TTL)
        return count <= QQBOT_MESSAGE_ID_REPLY_LIMIT
    }

    async sendQQBotMessage(bot, selfId, targetType, targetId, message) {
        const messageId = await this.getLatestQQBotMessageId(selfId, targetType, targetId)
        const rawTargetId = this.toQQBotRawTargetId(selfId, targetType, targetId)
        if (!this.isValidQQBotMessageId(messageId)) {
            return this.sendQQBotActiveMessage(selfId, targetType, rawTargetId, message)
        }
        if (!(await this.canReplyQQBotMessage(selfId, messageId))) {
            return this.sendQQBotActiveMessage(selfId, targetType, rawTargetId, message)
        }

        const event = { id: messageId }
        const data = targetType === "direct"
            ? { ...bot.fl?.get?.(targetId), self_id: selfId, bot, user_id: rawTargetId, platform: "QQ-private" }
            : { ...bot.gl?.get?.(targetId), self_id: selfId, bot, group_id: rawTargetId, platform: "QQ-group" }
        try {
            return targetType === "direct"
                ? await bot.adapter.sendFriendMsg(data, message, event)
                : await bot.adapter.sendGroupMsg(data, message, event)
        } catch (err) {
            return this.sendQQBotActiveMessage(selfId, targetType, rawTargetId, message)
        }
    }

    isValidQQBotMessageId(messageId) {
        const id = stringifyId(messageId).trim()
        if (!id || id === "0" || id === "null" || id === "undefined") return false
        if (id.startsWith("event_")) return false
        return true
    }

    async sendQQBotActiveMessage(selfId, targetType, rawTargetId, message) {
        return targetType === "direct"
            ? await Bot.sendFriendMsg(selfId, rawTargetId, message)
            : await Bot.sendGroupMsg(selfId, rawTargetId, message)
    }

    toQQBotRawTargetId(selfId, targetType, targetId) {
        const id = this.normalizeQQBotTargetId(selfId, targetType, targetId)
        if (targetType === "direct") return id.startsWith(`${selfId}:`) ? id.slice(`${selfId}:`.length) : id
        if (targetType !== "group") return id
        return id.startsWith(`${selfId}:`) ? id.slice(`${selfId}:`.length) : id
    }

    normalizeQQBotTargetId(selfId, targetType, targetId) {
        const id = stringifyId(targetId)
        if (!id || targetType !== "group") return id
        return id.startsWith(`${selfId}:`) ? id : `${selfId}:${id}`
    }

    async toQQBotMessage(content, selfId = this.selfId) {
        const config = this.botConfigs.get(stringifyId(selfId)) || this.config
        const result = []
        for (const seg of Array.isArray(content) ? content : []) {
            if (!seg || seg.data === undefined || seg.data === null) continue
            if (seg.type === "node") {
                if (Array.isArray(seg.data)) {
                    for (const nodeSeg of seg.data) result.push(...(await this.toQQBotMessage([nodeSeg], selfId)))
                }
                continue
            }
            if (seg.type === "markdown") {
                const content = String(seg.data)
                if (content.trim()) result.push({ type: "markdown", data: { content } })
                continue
            }
            if (seg.type === "buttons") {
                const buttons = toYunzaiButtons(seg.data)
                if (buttons) result.push(buttons)
                continue
            }
            if (seg.type === "template_buttons" || seg.type === "template_markdown") {
                logger.debug("[Gscore-Adapter] QQBot 下发暂不转发模板段 " + seg.type + "，已跳过")
                continue
            }
            result.push(...(await toYunzaiMessage([seg], config)))
        }
        return result
    }

    async toQQBotMessageChunks(content, selfId = this.selfId) {
        const chunks = []
        let current = []
        const flush = () => {
            if (current.length) chunks.push(current)
            current = []
        }

        for (const seg of Array.isArray(content) ? content : []) {
            if (!seg || seg.data === undefined || seg.data === null) continue
            if (seg.type === "node" && Array.isArray(seg.data)) {
                flush()
                for (const nodeSeg of seg.data) {
                    const message = await this.toQQBotMessage([nodeSeg], selfId)
                    if (message.length) chunks.push(message)
                }
                continue
            }

            current.push(...(await this.toQQBotMessage([seg], selfId)))
        }

        flush()
        return chunks
    }

    async deleteMessage(msg, data) {
        const messageId = stringifyId(data?.message_id)
        if (!messageId) return null
        try {
            const target = msg.target_type === "direct"
                ? Bot[msg.bot_self_id]?.pickFriend?.(msg.target_id)
                : Bot[msg.bot_self_id]?.pickGroup?.(msg.target_id)
            if (target?.recallMsg) await target.recallMsg(messageId)
        } catch (err) {
            logger.warn(`[${PLUGIN_NAME}] 撤回消息失败: ${err.message}`)
        }
        return null
    }

    async banUser(msg, data) {
        const userId = stringifyId(data?.user_id)
        const groupId = stringifyId(data?.group_id || msg.target_id)
        const duration = Number(data?.duration)
        if (!userId || !groupId || !Number.isFinite(duration)) return null
        try {
            const group = Bot[msg.bot_self_id]?.pickGroup?.(groupId)
            if (group?.muteMember) await group.muteMember(userId, duration)
            else if (group?.pickMember?.(userId)?.mute) await group.pickMember(userId).mute(duration)
            else logger.warn(`[${PLUGIN_NAME}] 当前账号/平台不支持禁言`)
        } catch (err) {
            logger.warn(`[${PLUGIN_NAME}] 禁言失败: ${err.message}`)
        }
        return null
    }

    sendRecallReceipt(msg, id) {
        this.sendPacket({
            bot_id: msg.bot_id,
            bot_self_id: msg.bot_self_id,
            msg_id: "",
            user_type: "direct",
            group_id: null,
            user_id: "",
            sender: {},
            user_pm: 6,
            content: [{ type: "recall_message_id", data: { echo: msg.echo, id } }],
        })
    }
}