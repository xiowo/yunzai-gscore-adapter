export function stringifyId(value) {
    if (value === undefined || value === null) return ""
    return String(value)
}

export function normalizeBool(value, fallback) {
    return typeof value === "boolean" ? value : fallback
}

export function maskBase64(value) {
    const text = Bot?.String ? Bot.String(value) : JSON.stringify(value)
    return text.replace(/base64:\/\/.*?(,|\]|"|$)/g, "base64://...$1")
}

export function getPrimarySelfId() {
    const uin = Bot?.uin?.find?.(Boolean)
    if (uin) return stringifyId(uin)

    for (const key of Object.keys(Bot || {})) {
        if (/^\d+$/.test(key)) return key
    }

    return "0"
}

export function resolveRouteBotId(routeBotId, selfId = getPrimarySelfId()) {
    const template = stringifyId(routeBotId || "Yunzai-{qq号}")
    return template
        .replace(/\{qq号\}/g, selfId)
        .replace(/\{qq\}/gi, selfId)
        .replace(/\{self_id\}/gi, selfId)
}

export function getOnlineBotIds() {
    return [...new Set((Bot?.uin || []).map(stringifyId).filter(Boolean))]
}

export function normalizeMedia(data) {
    const value = stringifyId(data)
    if (value.startsWith("link://")) return value.slice(7)
    if (/^data:[^;]+;base64,/i.test(value)) return `base64://${value.split(",", 2)[1] || ""}`
    if (value.startsWith("base64://")) return value
    if (/^(https?:|file:|ftp:|data:)/i.test(value)) return value
    if (/^(\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)[A-Za-z0-9+/=\r\n]+$/.test(value)) {
        return `base64://${value.replace(/\s+/g, "")}`
    }
    return value
}