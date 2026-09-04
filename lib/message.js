import { normalizeMedia, stringifyId } from "./utils.js"
import { ADAPTER_BOT_ID_MAP } from "./constants.js"

export function resolvePlatformBotId(e) {
    const adapterId = e?.bot?.adapter?.id
    return ADAPTER_BOT_ID_MAP[adapterId] || "onebot"
}

export function getUserPm(e) {
    if (e.isMaster) return 1
    if (e.member?.is_owner || e.sender?.role === "owner") return 2
    if (e.member?.is_admin || e.sender?.role === "admin") return 3
    return 6
}

export function makeSender(e) {
    const userId = stringifyId(e.user_id)
    const avatar = e.sender?.avatar
        || e.member?.getAvatarUrl?.()
        || e.friend?.getAvatarUrl?.()
        || ""

    return {
        ...(e.sender || {}),
        user_id: userId,
        nickname: e.sender?.nickname || e.sender?.card || e.nickname || userId,
        card: e.sender?.card,
        avatar,
    }
}

function cleanTextSegment(text) {
    return String(text || "").replace(/<attachmentType="[^"]+"[^>]*>\s*(?:<https?:\/\/[^>\s]+>)?/gi, "").trim()
}

function appendUniqueImage(content, seenImages, image) {
    const url = stringifyId(image).trim()
    if (!url || seenImages.has(url)) return
    content.push({ type: "image", data: url })
    seenImages.add(url)
}

function getRawPayloads(e) {
    const payloads = [e, e?.raw, e?.raw?.d, e?.raw_event, e?.raw_event?.d]
    return payloads.filter((payload, index) => payload && typeof payload === "object" && payloads.indexOf(payload) === index)
}

function getRawMsgElements(e) {
    for (const payload of getRawPayloads(e)) {
        if (Array.isArray(payload.msg_elements)) return payload.msg_elements
    }
    return []
}

function getQQBotQuote(e) {
    if (!isQQBotEvent(e)) return null

    const payloads = getRawPayloads(e)
    const quotePayload = payloads.find(payload => Number(payload.message_type) === 103)
    if (!quotePayload) return null

    let replyId = stringifyId(e?.ref_msg_idx || quotePayload?.ref_msg_idx)
    for (const payload of payloads) {
        if (replyId) break
        for (const ext of Array.isArray(payload?.message_scene?.ext) ? payload.message_scene.ext : []) {
            const value = stringifyId(ext)
            if (value.startsWith("ref_msg_idx=")) {
                replyId = value.slice("ref_msg_idx=".length)
                break
            }
        }
    }

    const elements = getRawMsgElements(e)
    const quotedElement = elements.find(element => replyId && stringifyId(element?.msg_idx) === replyId)
        || elements.find(element => Number(element?.message_type) === 103)
    if (!replyId) replyId = stringifyId(quotedElement?.msg_idx)

    const text = cleanTextSegment(quotedElement?.content || quotedElement?.text)
    if (!replyId && !text) return null
    return { replyId, text }
}

function getFileName(e, seg) {
    if (e?.bot?.adapter?.id === "QQBot" && e?.raw_event?.d?.filename) {
        return stringifyId(e.raw_event.d.filename)
    }
    return stringifyId(seg.name || seg.file || "file")
}

function appendMsgElementImages(content, seenImages, e) {
    for (const element of Array.isArray(getRawMsgElements(e)) ? getRawMsgElements(e) : []) {
        for (const attachment of Array.isArray(element?.attachments) ? element.attachments : []) {
            const contentType = stringifyId(attachment?.content_type).toLowerCase()
            if (contentType.includes("image")) appendUniqueImage(content, seenImages, attachment?.url)
        }
    }
}

function parseQQChatRecord(raw) {
    const text = stringifyId(raw).replace(/\r/g, "")
    if (!text.includes("群聊的聊天记录") || !text.includes("=== 消息")) return []
    const lines = text.split("\n")
    const records = []
    let record = null
    for (const line of lines) {
        const message = line.match(/^\s*\[消息内容\]\s*(.*)$/)?.[1]
        if (message !== undefined) {
            record = { message: message.trim(), sender: "", images: [] }
            records.push(record)
            continue
        }
        const sender = line.match(/^\s*\[发送者\]\s*(.*)$/)?.[1]
        if (sender && record) {
            record.sender = sender.trim()
            continue
        }
        const url = line.match(/\bhttps?:\/\/[^\s\r\n]+/)?.[0]
        if (url && record) record.images.push(url)
    }
    const items = []
    for (const current of records) {
        if (!current.sender || current.message === "[群聊的聊天记录]") {
            for (const url of current.images) items.push({ type: "image", data: url })
            continue
        }
        items.push({ type: "text", data: `${current.sender}：` })
        if (current.message && !current.message.startsWith("<attachmentType=")) {
            items.push({ type: "text", data: current.message })
        }
        for (const url of current.images) items.push({ type: "image", data: url })
    }
    return items
}

function getQQMessageElementText(e) {
    return getRawMsgElements(e)
        .map(element => element?.content || element?.text || "")
        .filter(Boolean)
        .join("\n")
}

function getQQRecordSource(e) {
    return [e?.raw_message, e?.msg, e?.message_str, e?.text, getQQMessageElementText(e)]
}

function isQQBotEvent(e) {
    return e?.bot?.adapter?.id === "QQBot" || e?.adapter?.id === "QQBot"
}

function getQQChatRecord(e, isQQ = isQQBotEvent(e)) {
    if (!isQQ) return []
    const candidates = [...getQQRecordSource(e), getReplyText(e)]
    for (const candidate of candidates) {
        const items = parseQQChatRecord(candidate)
        if (items.length) return items
    }
    return []
}

function isQQQuotedRecord(e) {
    return isQQBotEvent(e) && (Number(e?.message_type) === 103 || getQQRecordSource(e).some(text => stringifyId(text).includes("[消息类型] 引用消息")))
}

function getReplyText(reply) {
    if (!reply || typeof reply !== "object") return ""
    if (reply.text || reply.message_str) return String(reply.text || reply.message_str)
    if (typeof reply.message === "string") return reply.message.replace(/\[CQ:[^\]]+\]/g, "").trim()
    if (Array.isArray(reply.message)) {
        return reply.message
            .filter(item => item?.type === "text")
            .map(item => item.text || item.data?.text || item.data?.content || (typeof item.data === "string" ? item.data : ""))
            .join("")
    }
    if (typeof reply.raw_message === "string") return reply.raw_message.replace(/\[CQ:[^\]]+\]/g, "").trim()
    return ""
}

function normalizeQuotedMessage(response) {
    let current = response
    const seen = new Set()
    for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
        if (seen.has(current)) break
        seen.add(current)
        const message = current.message || current.content
        if (Array.isArray(message) || typeof message === "string") {
            return {
                message,
                raw_message: current.raw_message,
                message_str: current.message_str,
                msg_elements: current.msg_elements,
            }
        }
        if (typeof current.raw_message === "string" || typeof current.message_str === "string") {
            return {
                message: [],
                raw_message: current.raw_message,
                message_str: current.message_str,
                msg_elements: current.msg_elements,
            }
        }
        if (Array.isArray(current.msg_elements)) {
            return {
                message: [],
                raw_message: current.raw_message,
                message_str: current.message_str,
                msg_elements: current.msg_elements,
            }
        }
        current = current.data
    }
    return null
}

async function getQuotedMessage(e, replyId) {
    const bot = e.bot || globalThis.Bot?.[stringifyId(e.self_id)]
    if (!replyId) return null
    try {
        let response
        if (typeof bot?.sendApi === "function") {
            response = await bot.sendApi("get_msg", { message_id: replyId })
        } else if (typeof bot?.getMsg === "function") {
            response = await bot.getMsg(replyId)
        } else if (typeof e.group?.getMsg === "function") {
            response = await e.group.getMsg(replyId)
        } else {
            return null
        }
        return normalizeQuotedMessage(response)
    } catch (err) {
        logger.debug?.(`[Gscore-Adapter] 获取引用消息 ${replyId} 失败: ${err.message}`)
        return null
    }
}

async function appendReply(content, seenImages, seg, e) {
    const replyId = stringifyId(seg.id || seg.message_id || seg.data?.id)
    if (replyId) content.push({ type: "reply_id", data: replyId })

    const quoted = replyId ? await getQuotedMessage(e, replyId) || seg : seg
    const quotedMessage = Array.isArray(quoted.message) ? quoted.message : []
    const forward = quotedMessage.find(item => item?.type === "forward" || item?.type === "forward_msg")
    let nodeItems = []
    if (forward) {
        const directItems = forward.data?.content || forward.data?.message
        nodeItems = Array.isArray(directItems)
            ? await flattenForwardItems(e, directItems, 0, new Set())
            : await fetchForwardItems(e, getForwardId(forward.data), 0, new Set())
    }

    const qqRecordItems = getQQChatRecord(quoted, isQQBotEvent(e))
    if (!nodeItems.length && qqRecordItems.length) nodeItems = qqRecordItems
    const quotedText = qqRecordItems.length ? "" : getReplyText(quoted)
    const replyText = nodeItems.length ? formatNodePreview(nodeItems, quotedText) : quotedText
    if (replyText) content.push({ type: "reply", data: replyText })
    for (const quoted of quotedMessage) {
        if (quoted?.type === "image") {
            appendUniqueImage(content, seenImages, quoted.url || quoted.file || quoted.data?.url || quoted.data?.file)
        }
    }
    if (nodeItems.length) {
        content.push({ type: "node", data: nodeItems })
    }
}

const NODE_MARK = "[合并转发]"
const NODE_MAX_DEPTH = 3

function formatNodePreview(items, quotedText = "") {
    const lines = [NODE_MARK]
    if (quotedText && !quotedText.includes(NODE_MARK)) lines.push(quotedText)
    let pendingNickname = ""
    for (const item of items) {
        if (item.type === "text" && item.data) {
            const text = String(item.data).trim()
            if (text.endsWith(":") || text.endsWith("：")) {
                pendingNickname = `${text.slice(0, -1)}：`
                continue
            }
            lines.push(`${pendingNickname}${text}`)
            pendingNickname = ""
        } else if (item.type === "image") {
            lines.push(`${pendingNickname}[图片]`)
            pendingNickname = ""
        } else if (item.type === "record") {
            lines.push(`${pendingNickname}[语音]`)
            pendingNickname = ""
        } else if (item.type === "video") {
            lines.push(`${pendingNickname}[视频]`)
            pendingNickname = ""
        } else if (item.type === "file") {
            lines.push(`${pendingNickname}[文件]`)
            pendingNickname = ""
        }
    }
    if (pendingNickname) lines.push(pendingNickname)
    return lines.filter(Boolean).join("\n")
}

function getForwardId(value) {
    if (typeof value === "string" || typeof value === "number") return stringifyId(value)
    if (!value || typeof value !== "object") return ""
    return stringifyId(value.id || value.message_id || value.data?.id || value.data?.message_id)
}

function getRawForwardId(e) {
    const raw = stringifyId(e?.raw_message || e?.msg).trim()
    const match = raw.match(/^\[CQ:forward,([^\]]+)\]$/i)
    if (!match) return ""
    return match[1]
        .split(",")
        .map(item => item.split("=", 2))
        .find(([key]) => /^(?:id|message_id)$/i.test(key))?.[1] || ""
}

function getRawReplyId(e) {
    if (isQQBotEvent(e)) return ""
    const raw = stringifyId(e?.raw_message || e?.msg)
    const params = raw.match(/\[CQ:reply,([^\]]+)\]/i)?.[1]
    if (!params) return ""
    return params
        .split(",")
        .map(item => item.split("=", 2))
        .find(([key]) => /^(?:id|message_id)$/i.test(key))?.[1] || ""
}

async function fetchForwardItems(e, forwardId, depth, seen) {
    if (!forwardId || depth >= NODE_MAX_DEPTH || seen.has(forwardId)) return [{ type: "text", data: NODE_MARK }]
    seen.add(forwardId)
    try {
        const bot = e.bot || globalThis.Bot?.[stringifyId(e.self_id)]
        if (typeof bot?.sendApi !== "function") throw new Error("当前 OneBot 实例不支持 sendApi")
        const response = await bot.sendApi("get_forward_msg", { message_id: forwardId })
        const messages = Array.isArray(response)
            ? response
            : response?.data?.messages || response?.messages || response?.data
        if (!Array.isArray(messages)) return [{ type: "text", data: NODE_MARK }]
        return flattenForwardItems(e, messages, depth + 1, seen)
    } catch (err) {
        logger.debug?.(`[Gscore-Adapter] 获取合并转发 ${forwardId} 失败: ${err.message}`)
        return [{ type: "text", data: NODE_MARK }]
    }
}

async function flattenForwardItems(e, items, depth, seen) {
    const result = []
    for (const item of items) {
        if (!item || typeof item !== "object") continue
        const payload = item.type === "node" && item.data && !Array.isArray(item.data) ? item.data : item
        const nickname = payload.sender?.nickname || payload.name || ""
        if (nickname) result.push({ type: "text", data: `${nickname}:` })
        const nested = payload.type === "forward" || payload.type === "forward_msg"
            ? payload.data
            : item.type === "forward" || item.type === "forward_msg" ? item.data : null
        if (nested !== null) {
            result.push({ type: "text", data: NODE_MARK })
            result.push(...await fetchForwardItems(e, getForwardId(nested), depth, seen))
            continue
        }
        const nodeContent = payload.content || payload.message
        if (Array.isArray(nodeContent)) {
            result.push(...await flattenForwardItems(e, nodeContent, depth, seen))
            continue
        }
        if (item.type === "text") {
            const text = cleanTextSegment(item.text || item.data?.text || item.data)
            if (text) result.push({ type: "text", data: text })
        } else if (item.type === "image") {
            const image = item.url || item.file || item.data?.url || item.data
            if (image) result.push({ type: "image", data: stringifyId(image) })
        } else if (item.type === "at") {
            result.push({ type: "at", data: stringifyId(item.qq || item.data?.qq || item.data) })
        } else if (item.type === "file") {
            const file = item.url || item.file || item.data?.url
            if (file) result.push({ type: "file", data: `file|${file}` })
        }
    }
    return result
}

async function appendNode(content, node, e) {
    const directItems = Array.isArray(node) ? node : node?.content || node?.message
    const forwardId = getForwardId(node)
    const items = Array.isArray(directItems)
        ? await flattenForwardItems(e, directItems, 0, new Set())
        : forwardId ? await fetchForwardItems(e, forwardId, 0, new Set()) : []
    if (items.length) content.push({ type: "node", data: items })
}

export async function toGscoreContent(e) {
    const content = []
    const seenImages = new Set()
    const replySegments = []
    const rawForwardId = getRawForwardId(e)
    if (rawForwardId) {
        await appendNode(content, { id: rawForwardId }, e)
        return content
    }

    const qqRecordItems = getQQChatRecord(e)
    if (qqRecordItems.length) {
        const quotedRecord = isQQQuotedRecord(e)
        if (quotedRecord) content.push({ type: "reply", data: formatNodePreview(qqRecordItems) })
        content.push({ type: "node", data: qqRecordItems })
        if (!quotedRecord) return content
    }

    const message = Array.isArray(e.message) ? e.message : []
    for (const seg of message) {
        if (!seg || typeof seg !== "object") continue
        switch (seg.type) {
            case "text": {
                const text = cleanTextSegment(seg.text)
                if (text) content.push({ type: "text", data: text })
                break
            }
            case "at":
                content.push({ type: "at", data: stringifyId(seg.qq) })
                break
            case "image":
                appendUniqueImage(content, seenImages, seg.url)
                break
            case "reply":
                replySegments.push(seg)
                break
            case "node":
                await appendNode(content, seg.data, e)
                break
            case "forward":
            case "forward_msg":
                await appendNode(content, seg.data, e)
                break
            case "record":
                if (seg.url || seg.file) content.push({ type: "record", data: seg.url || seg.file })
                break
            case "file": {
                const name = getFileName(e, seg)
                const file = seg.url
                if (file) content.push({ type: "file", data: `${name}|${file}` })
                break
            }
        }
    }

    for (const reply of replySegments) await appendReply(content, seenImages, reply, e)
    if (!replySegments.length) {
        const quote = getQQBotQuote(e)
        if (quote) {
            await appendReply(content, seenImages, {
                id: quote.replyId,
                message: quote.text ? [{ type: "text", text: quote.text }] : [],
            }, e)
        } else {
            const rawReplyId = getRawReplyId(e)
            if (rawReplyId) await appendReply(content, seenImages, { id: rawReplyId }, e)
        }
    }

    appendMsgElementImages(content, seenImages, e)

    if (!content.length && e.raw_message) content.push({ type: "text", data: String(e.raw_message) })
    return content
}

export async function makeReceivePacket(e, config) {
    const content = await toGscoreContent(e)
    if (!content.length) return null

    const userType = e.message_type === "private" ? "direct" : "group"
    return {
        bot_id: resolvePlatformBotId(e),
        bot_self_id: stringifyId(e.self_id),
        msg_id: stringifyId(e.message_id || e.message_seq || e.seq || Date.now()),
        user_type: userType,
        group_id: userType === "group" ? stringifyId(e.group_id) : null,
        user_id: stringifyId(e.user_id),
        sender: makeSender(e),
        user_pm: getUserPm(e),
        content,
    }
}

function normalizeButtonRows(data) {
    if (!Array.isArray(data)) return []
    if (!Array.isArray(data[0])) return [data]
    return data
}

function normalizeButtonPermission(button = {}) {
    const permission = button.permission ?? button.permisson
    const specifyUserIds = Array.isArray(button.specify_user_ids)
        ? button.specify_user_ids.map(stringifyId).filter(Boolean)
        : []

    if (specifyUserIds.length) return specifyUserIds
    if (permission === "admin" || permission === 1 || permission === "1") return "admin"
    if (Array.isArray(permission)) return permission.map(stringifyId).filter(Boolean)
    if (permission === 0 || permission === "0") return []
    if (permission === 2 || permission === "2" || permission === undefined || permission === null) return undefined
    if (permission === 3 || permission === "3") return undefined
    if (typeof permission === "number") return stringifyId(permission)
    if (typeof permission === "string" && permission.trim()) return permission
    return undefined
}

function toYunzaiButton(button = {}) {
    const text = button.text || button.label || button.render_data?.label || "按钮"
    const clickedText = button.clicked_text || button.pressed_text || button.render_data?.visited_label || text
    const action = Number(button.action)
    const input = button.input || (action === 2 ? button.data : "")
    const callback = button.callback || (action === 1 || action === -1 ? button.data : "")
    const link = button.link || (action === 0 ? button.data : "")
    const msg = {
        text,
        clicked_text: clickedText,
        style: button.style,
        ...button.GSUIDCore,
    }

    if (input) {
        msg.input = input
    } else if (callback) {
        msg.callback = callback
        msg.toCallback = true
    } else if (link) {
        msg.link = link
    } else if (button.data) {
        msg.input = button.data
    } else {
        return null
    }

    const permission = normalizeButtonPermission(button)
    if (permission !== undefined) msg.permission = permission
    return msg
}

export function toYunzaiButtons(data) {
    const rows = []
    for (const row of normalizeButtonRows(data)) {
        const buttons = []
        for (const button of Array.isArray(row) ? row : []) {
            const msg = toYunzaiButton(button)
            if (msg) buttons.push(msg)
        }
        if (buttons.length) rows.push(buttons)
    }
    return rows.length ? { type: "button", data: rows } : null
}

function getForwardNodeIdentity(config = {}) {
    const selfId = stringifyId(config.selfId)
    const bot = globalThis.Bot?.[selfId]
    return {
        user_id: selfId,
        nickname: stringifyId(bot?.nickname || bot?.name || selfId || "早柚核心"),
    }
}

export async function toYunzaiMessage(content, config) {
    const result = []
    const replyId = (Array.isArray(content) ? content : []).find(seg => seg?.type === "reply_id")?.data
    let replyAdded = false
    for (const seg of Array.isArray(content) ? content : []) {
        if (!seg || seg.data === undefined || seg.data === null) continue
        switch (seg.type) {
            case "text":
                result.push(String(seg.data))
                break
            case "image":
                result.push(segment.image(normalizeMedia(seg.data)))
                break
            case "record":
                result.push(segment.record(normalizeMedia(seg.data)))
                break
            case "video":
                result.push(segment.video ? segment.video(normalizeMedia(seg.data)) : segment.file(normalizeMedia(seg.data)))
                break
            case "file": {
                const [name, file] = String(seg.data).split(/\|(.+)/)
                result.push(segment.file(normalizeMedia(file || seg.data), name || undefined))
                break
            }
            case "at":
                result.push(segment.at(seg.data))
                break
            case "reply":
                if (replyId !== undefined || replyAdded) break
                result.unshift(segment.reply(seg.data))
                replyAdded = true
                break
            case "reply_id":
                if (!replyAdded) {
                    result.unshift(segment.reply(seg.data))
                    replyAdded = true
                }
                break
            case "markdown":
                result.push(String(seg.data))
                break
            case "buttons": {
                const buttons = toYunzaiButtons(seg.data)
                if (buttons) result.push(buttons)
                break
            }
            case "node": {
                if (!Array.isArray(seg.data)) break
                const identity = getForwardNodeIdentity(config)
                const forward = []
                for (const nodeSeg of seg.data) {
                    const message = await toYunzaiMessage([nodeSeg], config)
                    if (message.length) forward.push({ ...identity, message })
                }
                if (forward.length) result.push(globalThis.Bot?.makeForwardMsg?.(forward) || { type: "node", data: forward })
                break
            }
        }
    }
    return result
}