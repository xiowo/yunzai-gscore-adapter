import fs from "node:fs"
import path from "node:path"

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function markdownImagePathList(content) {
    return [...String(content || "").matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
}

export function isLocalMarkdownImagePath(value) {
    if (!value || /^(https?:|mqqapi:|link:|base64:|data:|file:)/i.test(value)) return false
    return /^([/\\]|[A-Za-z]:[\\/])/.test(value)
}

export function resolveLocalMarkdownImagePath(rawPath, config = {}) {
    const normalized = safeDecodeURIComponent(String(rawPath || "")).replace(/\\/g, "/")
    const candidates = [normalized]

    if (normalized.startsWith("/gsuid_core/")) {
        const relativePath = normalized.slice("/gsuid_core/".length)
        if (config.gsuidCoreRoot) candidates.push(path.join(config.gsuidCoreRoot, relativePath))
        candidates.push(path.join(process.cwd(), "gsuid_core", relativePath))
        candidates.push(path.join(process.cwd(), relativePath))
    }
    if (normalized.startsWith("/")) candidates.push(path.join(process.cwd(), normalized.slice(1)))

    return candidates.find(candidate => fs.existsSync(candidate)) || null
}

export async function uploadLocalMarkdownImages(data, config = {}) {
    if (config.uploadLocalMarkdownImages !== true) return data

    const content = typeof data === "string" ? data : data?.content
    if (typeof content !== "string") return data
    const matches = markdownImagePathList(content).filter(match => isLocalMarkdownImagePath(String(match[2] || "").trim()))
    if (!matches.length) return data
    if (typeof globalThis.Bot?.imageToUrl !== "function") {
        logger.warn("[Gscore-Adapter] 未找到 Bot.imageToUrl，Markdown 本地图片无法上传")
        return data
    }

    const cache = new Map()
    let result = content
    for (const match of matches) {
        const rawPath = String(match[2] || "").trim()
        if (!cache.has(rawPath)) {
            const filePath = resolveLocalMarkdownImagePath(rawPath, config)
            if (!filePath) {
                logger.warn(`[Gscore-Adapter] Markdown 本地图片不存在，跳过上传: ${rawPath}`)
                cache.set(rawPath, null)
            } else {
                try {
                    cache.set(rawPath, await globalThis.Bot.imageToUrl(filePath, { name: path.basename(filePath) }))
                } catch (error) {
                    logger.warn(`[Gscore-Adapter] Markdown 本地图片上传失败: ${rawPath}`)
                    logger.warn(error)
                    cache.set(rawPath, null)
                }
            }
        }
        const uploadedUrl = cache.get(rawPath)
        if (uploadedUrl) result = result.replaceAll(match[0], `![${match[1]}](${uploadedUrl})`)
    }

    return typeof data === "string" ? result : { ...data, content: result }
}

export function getMarkdownContent(data) {
    return typeof data === "string" ? data : String(data?.content || "")
}