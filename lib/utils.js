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

/**
 * 判断 debug 级别是否真的会输出。
 *
 * 唯一目的：别为「打不出来的日志」白付一次整包序列化。
 * 模板字符串的实参在调用前就求值了，log4js 自己的级别检查救不了它，
 * 所以这里先问一次级别，再决定要不要构造那个字符串。
 *
 * 探测路径是确定的：Yunzai 在 lib/config/log.js:60-61 把 log4js 实例挂在
 * logger.logger.defaultLogger 上（全局 logger 是 chalk 实例，自身不带级别信息）。
 * log4js 6 的 Logger#isLevelEnabled 接受字符串，内部会先转成 Level 再比数字。
 *
 * 不做缓存：这只是一次数字比较，而缓存会让 log_level 的改动延迟生效。
 * 探测不到时按「不输出」处理 —— 丢一行 debug 日志，好过丢性能。
 */
export function isDebugLogEnabled() {
    try {
        return logger?.logger?.defaultLogger?.isLevelEnabled?.("debug") === true
    } catch {
        return false
    }
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
    if (value.startsWith("base64://")) return value
    return `base64://${value}`
}