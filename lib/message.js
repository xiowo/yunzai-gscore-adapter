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
    return {
        ...(e.sender || {}),
        user_id: stringifyId(e.user_id),
        nickname: e.sender?.nickname || e.sender?.card || e.nickname || stringifyId(e.user_id),
        card: e.sender?.card,
        avatar: e.sender?.avatar || e.friend?.avatar || e.member?.avatar,
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

function getRawMsgElements(e) {
    return e?.msg_elements || e?.raw?.msg_elements || e?.raw_event?.d?.msg_elements || []
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

export function toGscoreContent(e) {
    const content = []
    const seenImages = new Set()
    for (const seg of Array.isArray(e.message) ? e.message : []) {
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
                content.push({ type: "reply", data: stringifyId(seg.id) })
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

    appendMsgElementImages(content, seenImages, e)

    if (!content.length && e.raw_message) content.push({ type: "text", data: String(e.raw_message) })
    return content
}

export function makeReceivePacket(e, config) {
    const content = toGscoreContent(e)
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

    if (button.permission !== undefined) msg.permission = button.permission
    if (button.permisson !== undefined) msg.permission = button.permisson
    if (button.specify_user_ids?.length) msg.permission = button.specify_user_ids
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

export async function toYunzaiMessage(content, config) {
    const result = []
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
                result.unshift(segment.reply(seg.data))
                break
            case "markdown":
                result.push(String(seg.data))
                break
            case "buttons": {
                const buttons = toYunzaiButtons(seg.data)
                if (buttons) result.push(buttons)
                break
            }
            case "node":
                if (config.splitNode && Array.isArray(seg.data)) {
                    for (const nodeSeg of seg.data) result.push(...(await toYunzaiMessage([nodeSeg], config)))
                }
                break
        }
    }
    return result
}