import { fetchWithTimeout } from './net.mjs'

const COVER_HOSTS = new Set([
  'i0.hdslb.com',
  'i1.hdslb.com',
  'i2.hdslb.com',
  'pic.bstarstatic.com',
])

export function isAllowedCoverUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && COVER_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Proxy Bilibili covers through the host so the browser does not need to
 * contact a remote image host directly (and does not leak the user's IP/referrer).
 * The metadata response is external input, so its image URL stays on an
 * explicit allowlist and cannot turn this endpoint into an open proxy.
 */
export function createCoverService({ fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createCoverService requires fetchImpl()')

  const coverFor = async (bvid) => {
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid))) return null
    try {
      const response = await fetchWithTimeout(fetchImpl, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        redirect: 'error',
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      }, 8000)
      if (!response.ok) return null
      const payload = await response.json()
      const imageUrl = String(payload?.data?.pic || '')
      if (!isAllowedCoverUrl(imageUrl)) {
        log('取封面失败：接口返回了非 B 站图片地址')
        return null
      }
      const image = await fetchWithTimeout(fetchImpl, imageUrl, {
        redirect: 'error',
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      }, 10000)
      if (!image.ok) return null
      return {
        buf: Buffer.from(await image.arrayBuffer()),
        type: image.headers.get('content-type') || 'image/jpeg',
      }
    } catch (error) {
      log('取封面失败：' + String(error?.message ?? error))
      return null
    }
  }

  return { coverFor }
}
