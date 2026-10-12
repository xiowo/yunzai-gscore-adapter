import { normalizeBool, stringifyId } from "./utils.js"

export function cloneMessageEvent(e = {}) {
    return {
        ...e,
        message: Array.isArray(e.message)
            ? e.message.map(seg => (seg && typeof seg === "object" ? { ...seg } : seg))
            : e.message,
    }
}

export function getMessageText(e = {}) {
    const text = Array.isArray(e.message) ? e.message.find(seg => seg?.type === "text")?.text : ""
    return stringifyId(text || e.raw_message || e.msg || "")
}

export function isMatchCustomCommand(text = "", commands = []) {
    if (!Array.isArray(commands) || !commands.length) return false
    const command = stringifyId(text).replace(/^\s*\/*\s*/, "")
    return commands.some(item => {
        const custom = stringifyId(item).trim()
        return custom === "*" || (Boolean(custom) && command.startsWith(custom))
    })
}

export function getBotScopedRule(rules = [], selfId = "") {
    if (!Array.isArray(rules)) return null
    const globalRule = rules.find(rule => rule?.global === true)
    if (globalRule) return globalRule
    const botId = stringifyId(selfId)
    return rules.find(rule => Array.isArray(rule?.botIds) && rule.botIds.some(item => stringifyId(item) === botId)) || null
}

export function hasEggCheckPrefix(text = "") {
    return /^\s*(?:\/\s*)*(?:精灵蛋|查蛋)/.test(stringifyId(text))
}

export function isEggSizeWeightText(text = "") {
    const number = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)"
    const separator = "(?:\\s+|[/,，、;；|｜\\\\~～:：]+)"
    const delimiter = `(?:\\s*m\\s*(?:${separator})?|${separator})`
    const option = "(?:炫彩|同乘)"
    const options = `(?:${option}(?:\\s*${separator}\\s*${option})*)`
    const pattern = new RegExp(`^\\s*(?:${options}\\s*)?${number}${delimiter}${number}\\s*(?:kg)?(?:\\s*${options})?\\s*$`, "i")
    return pattern.test(stringifyId(text))
}

export function addQuickEggCheckPrefix(e, config = {}) {
    if (!config.quickEggCheck || !Array.isArray(e?.message)) return false
    const selfId = stringifyId(e.self_id)
    const appliesToBot = config.quickEggCheckGlobal === true
        || (Array.isArray(config.quickEggCheckBots) && config.quickEggCheckBots.some(item => stringifyId(item) === selfId))
    if (!appliesToBot) return false

    const textSegment = e.message.find(seg => seg?.type === "text")
    if (!textSegment) return false
    const text = stringifyId(textSegment.text)
    if (hasEggCheckPrefix(text) || !isEggSizeWeightText(text)) return false

    textSegment.text = `精灵蛋${text.trim()}`
    return true
}

export function addGscoreBotPrefix(e, config = {}) {
    const rule = getBotScopedRule(config.gsuidBotPrefix, e?.self_id)
    if (!rule || !Array.isArray(e?.message)) return false

    const prefix = stringifyId(rule.prefix)
    if (!prefix) return false
    const rawText = stringifyId(e.message.find(seg => seg?.type === "text")?.text || "")
    const commandMode = rule.prefixMode === "commands"
    if (commandMode && !isMatchCustomCommand(rawText, rule.commands)) return false
    const textSegment = e.message.find(seg => seg?.type === "text")
    if (!textSegment) {
        e.message.unshift({ type: "text", text: prefix })
        return true
    }

    if (!commandMode) {
        if (isMatchCustomCommand(rawText, rule.noPrefixCommands)) return false
        const forceAdd = isMatchCustomCommand(rawText, rule.forceAddPrefix)
        const skipIfHasPrefix = normalizeBool(rule.skipIfHasPrefix, true)
        if (!forceAdd && skipIfHasPrefix && /^[A-Za-z0-9]/.test(rawText.replace(/^\s*\/*\s*/, ""))) return false
    }

    textSegment.text = `${prefix}${rawText.replace(/^\s*\/*\s*/, "")}`
    return true
}

export function getDisconnectMaintenanceReply(e, config = {}, disconnected = false) {
    if (!disconnected) return null
    const rule = getBotScopedRule(config.gsuidDisconnectReply, e?.self_id)
    if (!rule || rule.enable === false) return null
    if (!isMatchCustomCommand(getMessageText(e), rule.commands)) return null
    return stringifyId(rule.message).trim() || "机器人维护中~\n正在更新框架(꒪⌓꒪)"
}

export function getCommandMaintenanceReply(e, config = {}) {
    const rule = getBotScopedRule(config.gsuidCommandMaintenanceReply, e?.self_id)
    if (!rule || rule.enable === false) return null
    if (!isMatchCustomCommand(getMessageText(e), rule.commands)) return null
    return stringifyId(rule.message).trim() || "功能正在调整中..."
}