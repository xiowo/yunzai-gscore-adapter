import { getUserPm, makeSender, resolvePlatformBotId } from "./message.js"
import { stringifyId } from "./utils.js"

export function convertMeta(e) {
    const notice = e.notice_type ? `${e.notice_type}_${e.sub_type || ""}` : ""
    if (["group_increase_approve", "group_increase_invite"].includes(notice) || e.notice_type === "group_increase") {
        return {
            name: "user_join_group",
            data: {
                user_id: stringifyId(e.user_id),
                group_id: stringifyId(e.group_id),
                operator_id: stringifyId(e.operator_id || e.invitor_id || ""),
            },
        }
    }
    if (e.notice_type === "group_decrease") {
        return {
            name: "user_exit_group",
            data: {
                user_id: stringifyId(e.user_id),
                group_id: stringifyId(e.group_id),
                operator_id: stringifyId(e.operator_id || ""),
            },
        }
    }
    if (e.notice_type === "notify" && e.sub_type === "poke") {
        const data = {
            user_id: stringifyId(e.user_id || e.operator_id),
            target_id: stringifyId(e.target_id || e.self_id),
        }
        if (e.group_id) data.group_id = stringifyId(e.group_id)
        return { name: "poke", data }
    }
    return null
}

export function makeMetaPacket(e, config) {
    if (!config.reportMeta || !e || e.adapter_id === "GSUIDCore") return null
    const meta = convertMeta(e)
    if (!meta) return null

    return {
        bot_id: resolvePlatformBotId(e),
        bot_self_id: stringifyId(e.self_id),
        msg_id: stringifyId(e.message_id || e.notice_id || Date.now()),
        user_type: meta.data.group_id ? "group" : "direct",
        group_id: meta.data.group_id || null,
        user_id: meta.data.user_id || meta.data.target_id || "",
        sender: makeSender(e),
        user_pm: getUserPm(e),
        content: [{ type: `meta-${meta.name}`, data: meta.data }],
    }
}