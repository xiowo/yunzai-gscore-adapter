import { WebSocket } from "ws"
import { CORE_CONTROL_TIMEOUT, CORE_RECEIPT_DEADLINE, CORE_SEND_TIMEOUT, DOWN_ORDER_BARRIER_TIMEOUT, HEARTBEAT_INTERVAL, HEARTBEAT_MISS_FACTOR, PLUGIN_NAME, QQBOT_MESSAGE_ID_KEY_PREFIX, QQBOT_MESSAGE_ID_REPLY_LIMIT, QQBOT_MESSAGE_ID_TTL, RECONNECT_MAX_INTERVAL, RECONNECT_STABLE_RESET, ROUTE_BOT_ID_TEMPLATE, SEND_BUFFER_HIGH_WATER, SEND_DROP_WARN_INTERVAL, SEND_QUEUE_MAX_BYTES, SOCKET_KEEPALIVE_DELAY } from "./constants.js"
import { makeReceivePacket, resolvePlatformBotId, toYunzaiButtons, toYunzaiMessage } from "./message.js"
import { getMarkdownContent, uploadLocalMarkdownImages } from "./markdown-images.js"
import { addGscoreBotPrefix, addQuickEggCheckPrefix, cloneMessageEvent, getBotScopedRule, getCommandMaintenanceReply, getDisconnectMaintenanceReply } from "./message-rules.js"
import { makeMetaPacket } from "./meta.js"
import { isDebugLogEnabled, maskBase64, resolveRouteBotId, stringifyId } from "./utils.js"

/**
 * 解析单条下发的处理超时。
 *
 * 控制类请求（拉群成员 / 主动权限测试）走独立配置，其余用 sendTimeout。
 * 两个值都可能因为直接构造（测试 / 旧配置）而不存在，这里保留兜底默认。
 *
 * 最后统一压低到 `CORE_RECEIPT_DEADLINE`：这是协议硬约束（references/11-meta-and-control.md
 * §11.2 / §11.5）——回执必须在 core 放弃等待前送达。给再多处理时间都不可能变成有效回执，
 * 只会让回执迟到、白计一次降级。控制类同样受约束：它的回包只能靠回执送回 core。
 */
export function resolveCoreSendTimeout(msg, config) {
    const type = msg?.content?.[0]?.type
    const isControl = type === "gscore_group_members_request" || type === "gscore_qqbot_active_test"
    const value = Number(isControl ? config?.controlSendTimeout : config?.sendTimeout)
    const fallback = isControl ? CORE_CONTROL_TIMEOUT : CORE_SEND_TIMEOUT
    const resolved = Number.isFinite(value) && value > 0 ? value : fallback
    return Math.min(resolved, CORE_RECEIPT_DEADLINE)
}

/**
 * 判断是否是「必须与在途消息保持相对顺序」的控制包。
 *
 * 协议 references/11-meta-and-control.md §11.5：
 *   「撤回/禁言与普通消息共用同一发送队列：保持与在途消息的相对顺序」
 * 判定口径与 dispatchCoreSend 的短路条件保持一致（同样先滤掉 group 段），
 * 否则会出现「分发时当控制包、屏障时当普通包」的不一致。
 *
 * 不含 gscore_group_members_request / gscore_qqbot_active_test：那两个是查询类响应，
 * 不操作某条在途消息，无需让序。
 */
function isOrderedControlPacket(msg) {
    const content = (msg?.content || []).filter(segment => segment?.type !== "group")
    if (content.length !== 1) return false
    const type = content[0]?.type
    return type === "excute_delete_message" || type === "excute_ban_user"
}

export class GscoreClient {
    constructor(config) {
        this.setConfig(config)
        this.ws = null
        this.queue = []
        this.queueBytes = 0
        this.flushing = false
        this.drainTimer = null
        this.droppedPackets = 0
        this.droppedWarnAt = 0
        this.connected = false
        this.connecting = false
        this.closed = false
        this.reconnectCount = 0
        this.hasDisconnected = false
        this.reconnectTimer = null
        this.stableTimer = null
        this.heartbeatTimer = null
        this.lastPongAt = 0
        /** 在途下发的 promise 集合，供撤回/禁言的顺序屏障等待（协议 §11.5） */
        this.inflightDown = new Set()
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
        clearTimeout(this.stableTimer)
        this.stableTimer = null
        this.stopHeartbeat()
        clearTimeout(this.drainTimer)
        this.drainTimer = null
        this.flushing = false
        this.queue = []
        this.queueBytes = 0
        this.inflightDown.clear()
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
            this.hasDisconnected = false
            this.enableSocketKeepAlive(ws)
            this.startHeartbeat(ws)
            // 退避计数只在连接稳定存活一段时间后才清零：core 若反复 accept-then-drop，
            // 一 open 就清零会让退避永远打回起点，退化成固定间隔的重连风暴。
            clearTimeout(this.stableTimer)
            this.stableTimer = setTimeout(() => {
                this.stableTimer = null
                this.reconnectCount = 0
            }, RECONNECT_STABLE_RESET)
            logger.mark(`[${PLUGIN_NAME}] 已连接 GsCore: ${this.url.replace(/token=[^&]+/, "token=***")}`)
            this.flushQueue()
        })

        ws.on("message", raw => this.handleCoreMessage(raw).catch(err => logger.error(`[${PLUGIN_NAME}] 处理 core 下发失败`, err)))
        // 适配器发出 ping 后，core 回的 pong 在这里刷新计时；
        // 反向的 core ping 由 ws 协议层自动回 pong（_autoPong），不经过这里
        ws.on("pong", () => {
            this.lastPongAt = Date.now()
        })
        ws.on("error", err => logger.error(`[${PLUGIN_NAME}] WebSocket 错误: ${err.message}`))
        ws.on("close", (code, reason) => {
            this.connecting = false
            this.connected = false
            this.stopHeartbeat()
            clearTimeout(this.stableTimer)
            this.stableTimer = null
            if (!this.closed) {
                this.hasDisconnected = true
                this.reconnectCount++
            }
            logger.warn(`[${PLUGIN_NAME}] 与 GsCore 断开: ${code} ${reason?.toString?.() || ""}`)
            this.scheduleReconnect()
        })
    }

    /**
     * 应用层心跳（主机制）。协议文档 §3.4 要求适配器侧保活，Python 的 websockets 客户端
     * 会主动发 ping 并监测 pong；ws 客户端只被动回 pong，所以由这里自己发。
     * 这与「core 会发 ping」不重复：core 的 ping 验证的是**适配器**是否活着，
     * 而这里验证的是**core 是否还在应答**——半开连接下 core 的 FIN 可能同样到达不了适配器。
     * 收不到 pong 就主动断开重连，把「一直往死 socket 里塞数据」的自锁状态解开。
     */
    startHeartbeat(ws) {
        this.stopHeartbeat()
        this.lastPongAt = Date.now()
        // 生产路径的间隔下限由 config.js 钳制；这里只防「0 / NaN / 负数」把 setInterval 打爆
        const configured = Number(this.config.heartbeatInterval)
        const interval = Number.isFinite(configured) && configured > 0 ? configured : HEARTBEAT_INTERVAL
        const deadline = interval * HEARTBEAT_MISS_FACTOR
        this.heartbeatTimer = setInterval(() => {
            if (this.ws !== ws || this.closed) return
            const idle = Date.now() - this.lastPongAt
            if (idle > deadline) {
                logger.warn(`[${PLUGIN_NAME}] 心跳超时（${Math.round(idle / 1000)}s 未收到 pong），判定连接已死，主动重连`)
                this.stopHeartbeat()
                this.resetConnection("心跳超时")
                return
            }
            try {
                ws.ping()
            } catch (err) {
                logger.debug(`[${PLUGIN_NAME}] 发送心跳 ping 失败: ${err?.message || err}`)
            }
        }, interval)
        this.heartbeatTimer.unref?.()
    }

    stopHeartbeat() {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    /**
     * 打开 TCP 层 keepalive（内核级补充）。ws 8 客户端不调 setKeepAlive，
     * 半开连接（对端已死、本机 socket 仍是 OPEN）在**空闲方向**不会产生任何 error/close：
     * 没有未确认数据就不会触发重传，只能靠 keepalive 探活才会最终报错。
     * 应用层心跳已覆盖同一场景且更快，这里保留是因为它的开销在正常运行时约为零
     * （只要 core 心跳/业务帧让连接不空闲满 30s，探活报文根本不会发出）。
     */
    enableSocketKeepAlive(ws) {
        try {
            ws?._socket?.setKeepAlive?.(true, SOCKET_KEEPALIVE_DELAY)
        } catch (err) {
            logger.debug(`[${PLUGIN_NAME}] 设置 TCP keepalive 失败: ${err?.message || err}`)
        }
    }

    scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return
        const base = Math.max(Number(this.config.reconnectInterval) || 5000, 1000)
        const attempt = Math.max(this.reconnectCount - 1, 0)
        const delay = Math.min(base * 2 ** Math.min(attempt, 3), RECONNECT_MAX_INTERVAL)
        if (attempt > 0) logger.warn(`[${PLUGIN_NAME}] ${delay / 1000} 秒后重连（第 ${this.reconnectCount} 次）`)
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, delay)
    }

    /** ws 是否还有内核缓冲余量可以直发。readyState 由 trySend 统一判定，这里不重复。 */
    canSendDirect() {
        return this.connected && (this.ws?.bufferedAmount ?? Infinity) <= SEND_BUFFER_HIGH_WATER
    }

    sendPacket(packet) {
        let payload
        try {
            payload = Buffer.from(JSON.stringify(packet))
        } catch (err) {
            logger.error(`[${PLUGIN_NAME}] 上报包序列化失败，已跳过`, err)
            return
        }

        // 队列非空时一律排队，否则新包会插到积压前面，破坏撤回/禁言与在途消息的相对顺序
        // （references/11-meta-and-control.md §11.5 要求共用同一队列保序）
        if (!this.queue.length && this.canSendDirect() && this.trySend(payload)) return

        // 未连接或内核缓冲已到高水位：入队，由 drainQueue 逐帧慢慢排空（背压）
        this.enqueue(payload)
        if (this.connected) this.flushQueue()
        else this.connect()
    }

    /**
     * 真正交给 ws。关键点是**必须传 callback**：
     * ws 在 sendAfterClose 分支下不传 callback 时既不抛异常也不 emit('error')，
     * 只把字节数加进 bufferedAmount —— 发送失败会完全静默。
     */
    trySend(payload) {
        const ws = this.ws
        if (!this.connected || ws?.readyState !== WebSocket.OPEN) return false
        try {
            ws.send(payload, err => {
                if (err) this.handleSendFailure(payload, err)
            })
            return true
        } catch (err) {
            this.handleSendFailure(payload, err)
            return true
        }
    }

    handleSendFailure(payload, err) {
        if (this.closed) return
        logger.warn(`[${PLUGIN_NAME}] 上报发送失败（${err?.message || err}），已重新入队等待重连`)
        this.enqueue(payload, true)
        this.resetConnection("发送失败")
    }

    /** 强制断开以触发 close → 重连，避免僵尸连接下无限往里塞数据 */
    resetConnection(reason) {
        const ws = this.ws
        this.connected = false
        this.connecting = false
        this.stopHeartbeat()
        if (ws && ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED) {
            logger.warn(`[${PLUGIN_NAME}] 连接异常（${reason}），主动断开重连`)
            try {
                ws.terminate?.()
            } catch { }
        }
        this.scheduleReconnect()
    }

    getQueueSnapshot() {
        return { count: this.queue.length, bytes: this.queueBytes, dropped: this.droppedPackets }
    }

    enqueue(payload, front = false) {
        const size = payload.length
        // 超上限时丢最旧的包；重入队的包放队首时改丢队尾，避免刚入队就被自己挤掉
        while (this.queue.length && this.queueBytes + size > SEND_QUEUE_MAX_BYTES) {
            const dropped = front ? this.queue.pop() : this.queue.shift()
            this.queueBytes -= dropped.length
            this.droppedPackets++
        }
        if (this.queueBytes + size > SEND_QUEUE_MAX_BYTES) {
            this.droppedPackets++
            this.warnDroppedPackets()
            return
        }
        if (front) this.queue.unshift(payload)
        else this.queue.push(payload)
        this.queueBytes += size
        this.warnDroppedPackets()
    }

    warnDroppedPackets() {
        if (!this.droppedPackets) return
        const now = Date.now()
        if (now - this.droppedWarnAt < SEND_DROP_WARN_INTERVAL) return
        this.droppedWarnAt = now
        logger.warn(`[${PLUGIN_NAME}] 上报积压超过 ${Math.round(SEND_QUEUE_MAX_BYTES / 1048576)}MB 上限，已丢弃 ${this.droppedPackets} 条最旧消息`)
        this.droppedPackets = 0
    }

    scheduleDrainRetry() {
        if (this.closed || this.drainTimer) return
        this.drainTimer = setTimeout(() => {
            this.drainTimer = null
            if (!this.flushing) this.flushQueue()
        }, 50)
    }

    flushQueue() {
        if (this.flushing) return
        this.flushing = true
        this.drainQueue()
    }

    drainQueue() {
        try {
            this.drainQueueStep()
        } catch (err) {
            this.flushing = false
            logger.error(`[${PLUGIN_NAME}] 上报队列排空异常`, err)
        }
    }

    /**
     * 一 tick 一帧地排空积压。
     * 原来的 while 循环会在单个 tick 内同步写完整个队列（ws 的帧编码与写入是同步的，回调才异步），
     * 既不看 bufferedAmount 也不让出事件循环 —— core 重连后积压一次性倾泻就是卡死的直接来源。
     */
    drainQueueStep() {
        const ws = this.ws
        if (this.closed || !this.connected || ws?.readyState !== WebSocket.OPEN) {
            this.flushing = false
            return
        }
        if (ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) {
            this.flushing = false
            this.scheduleDrainRetry()
            return
        }

        const payload = this.queue.shift()
        if (!payload) {
            this.flushing = false
            return
        }
        this.queueBytes -= payload.length

        if (!this.trySend(payload)) {
            this.queue.unshift(payload)
            this.queueBytes += payload.length
            this.flushing = false
            return
        }
        setImmediate(() => this.drainQueue())
    }

    getEventConfig(e) {
        return this.botConfigs.get(stringifyId(e?.self_id))
    }

    isDisconnectMaintenanceActive(disconnectCount = 3) {
        const count = Number(disconnectCount)
        const threshold = Number.isFinite(count) ? Math.max(Math.floor(count), 1) : 3
        return this.hasDisconnected && !this.closed && !this.connected && this.reconnectCount >= threshold
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
        const event = this.normalizePrefixedGroupMessage(cloneMessageEvent(e))
        if (!event) return

        addQuickEggCheckPrefix(event, config)

        const disconnectRule = getBotScopedRule(config.gsuidDisconnectReply, event.self_id)
        const disconnectReply = getDisconnectMaintenanceReply(event, config, this.isDisconnectMaintenanceActive(disconnectRule?.disconnectCount))
        if (disconnectReply !== null) {
            await this.replyToEvent(e, disconnectReply)
            return
        }

        const commandMaintenanceReply = getCommandMaintenanceReply(event, config)
        if (commandMaintenanceReply !== null) {
            await this.replyToEvent(e, commandMaintenanceReply)
            return
        }

        addGscoreBotPrefix(event, config)
        await this.rememberQQBotMessageId(event)
        const packet = await makeReceivePacket(event, config)
        if (!packet) return

        if (isDebugLogEnabled()) logger.debug(`[${PLUGIN_NAME}] 上报消息: ${maskBase64(packet)}`)
        this.sendPacket(packet)
    }

    async replyToEvent(e, message) {
        if (typeof e?.reply === "function") return e.reply(message)
        if (e?.message_type === "private") {
            return globalThis.Bot?.sendFriendMsg?.(e.self_id, e.user_id, message)
        }
        if (e?.message_type === "group") {
            return globalThis.Bot?.sendGroupMsg?.(e.self_id, e.group_id, message)
        }
    }

    async reportMeta(e) {
        const config = this.getEventConfig(e)
        if (!config || !this.selfIds.has(stringifyId(e?.self_id))) return
        const packet = makeMetaPacket(e, config)
        if (!packet) return

        if (isDebugLogEnabled()) logger.debug(`[${PLUGIN_NAME}] 上报元事件: ${maskBase64(packet)}`)
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

        // 撤回 / 禁言必须先等此前的在途下发落地，否则会抢在它要操作的那条消息之前执行（协议 §11.5）
        if (isOrderedControlPacket(msg)) await this.drainInflightDown()

        let recallId = null
        try {
            recallId = await this.awaitCoreSend(msg)
        } catch (err) {
            logger.error(`[${PLUGIN_NAME}] 处理 core 下发失败`, err)
        } finally {
            // 协议要求：只要 echo 非空就必须回执一次，即便拿不到 id 也要回（id=null），
            // 让 core 立即结算该帧，而不是空等满 RECALL_WAIT_TIMEOUT。
            if (msg.echo) this.sendRecallReceipt(msg, recallId)
        }
    }

    /**
     * 给单条下发加超时。超时不等于失败终止 —— 超时后依然回执 id=null，
     * 由 core 侧决定该帧的结果，适配器这边不再无限期挂着。
     */
    /**
     * 顺序屏障：等待「此前已在途的下行」落地。
     *
     * 为什么需要：JS 这边每条下发是独立的 promise 链（不像 Python 参考实现的单个 recv 协程
     * 天然串行）。若 core 先下发一条消息、紧接着下发它的撤回包，撤回会抢在那条消息真正
     * 发出之前执行 → 平台报「消息不存在」，撤回静默失败。
     *
     * 只取一次快照：快照之后到达的下发本来就晚于本控制包，顺序天然正确，不该等 ——
     * 否则持续流量下控制包会永远等不到「队列清空」。
     *
     * 这**不是**并发上限：普通消息之间依然全速并发，只有控制包会让序。
     *
     * @param {number} limit 等待上限，默认 DOWN_ORDER_BARRIER_TIMEOUT
     */
    async drainInflightDown(limit = DOWN_ORDER_BARRIER_TIMEOUT) {
        const snapshot = [...this.inflightDown]
        if (!snapshot.length) return
        const wait = Number(limit) > 0 ? Number(limit) : DOWN_ORDER_BARRIER_TIMEOUT
        let timer = null
        try {
            await Promise.race([
                Promise.allSettled(snapshot),
                new Promise(resolve => {
                    timer = setTimeout(() => {
                        logger.warn(`[${PLUGIN_NAME}] 顺序屏障等待超时（${wait}ms），仍有 ${this.inflightDown.size} 条在途下发未落地，控制包继续执行`)
                        resolve()
                    }, wait)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * 给单条下发加超时。超时不等于失败终止 —— 超时后依然回执 id=null，
     * 由 core 侧决定该帧的结果，适配器这边不再无限期挂着。
     */
    async awaitCoreSend(msg) {
        const timeout = resolveCoreSendTimeout(msg, this.config)
        const task = Promise.resolve().then(() => this.dispatchCoreSend(msg))
        // 超时先返回时原任务仍可能 reject，这里挂个兜底，避免 unhandledRejection
        task.catch(() => { })
        // 登记为在途下发，供撤回/禁言的顺序屏障等待（协议 §11.5）
        this.inflightDown.add(task)
        const release = () => this.inflightDown.delete(task)
        task.then(release, release)
        let timer = null
        try {
            return await Promise.race([
                task,
                new Promise(resolve => {
                    timer = setTimeout(() => {
                        logger.warn(`[${PLUGIN_NAME}] core 下发处理超时（${timeout}ms），按无 id 回执并继续`)
                        // 超时即视为本帧已结算（core 已收到 id=null 回执），
                        // 从在途集合移除：否则底层调用若永久悬挂，会让之后每一个撤回/禁言
                        // 都白等满一次顺序屏障超时。
                        release()
                        resolve(null)
                    }, timeout)
                }),
            ])
        } finally {
            clearTimeout(timer)
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
        const effectiveContent = (msg.content || []).filter(segment => segment?.type !== "group")
        const control = effectiveContent.length === 1 ? effectiveContent[0] : null
        if (control?.type === "excute_delete_message") return this.deleteMessage(msg, control.data)
        if (control?.type === "excute_ban_user") return this.banUser(msg, control.data)
        if (control?.type === "gscore_group_members_request") {
            return this.replyGroupMembersRequest(msg, control.data)
        }
        if (control?.type === "gscore_qqbot_active_test") {
            return this.replyQQBotActiveTest(msg, control.data)
        }

        const targetType = msg.target_type === "direct" ? "direct" : "group"
        const botSelfId = stringifyId(msg.bot_self_id)
        const bot = Bot?.[botSelfId]
        const targetId = bot?.adapter?.id === "QQBot"
            ? this.normalizeQQBotTargetId(botSelfId, targetType, msg.target_id)
            : stringifyId(msg.target_id)
        if (!targetId) return null

        if (isDebugLogEnabled()) logger.debug(`[${PLUGIN_NAME}] core 下发消息: ${maskBase64(msg)}`)
        return this.sendYunzaiMessage(msg.bot_self_id, targetType, targetId, msg.content || [])
    }

    async replyGroupMembersRequest(msg, data = {}) {
        const botSelfId = stringifyId(msg.bot_self_id)
        const groupId = stringifyId(data.group_id || msg.target_id)
        const requestId = stringifyId(data.request_id)
        const bot = Bot?.[botSelfId]
        const group = bot?.pickGroup?.(groupId) || bot?.group?.get?.(groupId)
        let members = []
        if (requestId) {
            logger.debug(`[${PLUGIN_NAME}] 收到群成员WS请求: request_id=${requestId}, bot=${botSelfId}, group=${groupId}`)
            if (group?.getMemberMap) {
                try {
                    const memberMap = await group.getMemberMap()
                    const entries = memberMap instanceof Map ? [...memberMap.entries()] : Object.entries(memberMap || {})
                    members = entries.map(([userId, member]) => ({
                        user_id: stringifyId(member?.user_id || userId),
                        nickname: stringifyId(member?.card || member?.nickname || ""),
                    })).filter(member => member.user_id)
                } catch (error) {
                    logger.debug(`[${PLUGIN_NAME}] 获取群成员列表失败: ${error?.message || error}`)
                }
            }
            logger.debug(`[${PLUGIN_NAME}] 已生成群成员WS回包: request_id=${requestId}, count=${members.length}`)
            return JSON.stringify({
                request_id: requestId,
                member_ids: members.map(member => member.user_id),
            })
        }
        return null
    }

    /**
     * 主动消息权限测试：直连平台主动发送通道，返回 { ok, message_id, error }。
     * 必须绕开 sendQQBotMessage 的 Redis 被动回复兜底，否则会因为会话里有
     * 最新入站消息 ID 而被当成被动回复，测试结果永远为真。
     */
    async replyQQBotActiveTest(msg, data = {}) {
        const botSelfId = stringifyId(data.bot_self_id || msg.bot_self_id)
        const targetType = (data.target_type || msg.target_type) === "direct" ? "direct" : "group"
        const targetId = stringifyId(data.target_id || msg.target_id)
        if (!botSelfId || !targetId) {
            return JSON.stringify({ ok: false, message_id: null, error: "缺少 bot_self_id 或 target_id" })
        }

        const message = await toYunzaiMessage(
            [{ type: "text", data: "✅主动权限确认成功" }],
            this.botConfigs.get(botSelfId) || this.config,
        )
        const rawTargetId = this.toQQBotRawTargetId(botSelfId, targetType, targetId)
        try {
            const ret = await this.sendQQBotActiveMessage(botSelfId, targetType, rawTargetId, message)
            const ids = ret?.message_id ?? ret?.data?.message_id ?? []
            const messageId = (Array.isArray(ids) ? ids[0] : ids) || ""
            if (!messageId) {
                const reason = ret?.error?.[0]?.message || String(ret?.error?.[0] || "")
                return JSON.stringify({ ok: false, message_id: null, error: reason || "主动发送失败，可能是权限不足或频次限制" })
            }
            return JSON.stringify({ ok: true, message_id: stringifyId(messageId), error: "" })
        } catch (err) {
            return JSON.stringify({ ok: false, message_id: null, error: err?.message || String(err) })
        }
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
        const replyId = await this.getLatestQQBotMessageId(selfId, targetType, targetId)
        const rawTargetId = this.toQQBotRawTargetId(selfId, targetType, targetId)
        if (!this.isValidQQBotReplyId(replyId)) {
            return this.sendQQBotActiveMessage(selfId, targetType, rawTargetId, message)
        }
        if (!(await this.canReplyQQBotMessage(selfId, replyId))) {
            return this.sendQQBotActiveMessage(selfId, targetType, rawTargetId, message)
        }

        const eventId = replyId.startsWith("event_") ? replyId.slice("event_".length) : ""
        const event = eventId ? { event_id: eventId } : { id: replyId }
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

    isValidQQBotReplyId(replyId) {
        const id = stringifyId(replyId).trim()
        if (!id || id === "0" || id === "null" || id === "undefined") return false
        if (id === "event_") return false
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
                const markdown = await uploadLocalMarkdownImages(seg.data, config)
                const content = getMarkdownContent(markdown)
                if (content.trim()) result.push({ type: "markdown", data: content })
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