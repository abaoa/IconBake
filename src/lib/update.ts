import { RELEASES_API } from '../config'

export interface ReleaseInfo {
  version: string
  htmlUrl: string
  publishedAt: string
  body: string
}

function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

export function isNewer(current: string, latest: string): boolean {
  const a = parseSemver(current)
  const b = parseSemver(latest)
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i]
  }
  return false
}

export async function checkLatestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) {
    throw new Error(`GitHub API 返回 ${res.status}`)
  }
  const data = await res.json()
  return {
    version: (data.tag_name || '').replace(/^v/, ''),
    htmlUrl: data.html_url || '',
    publishedAt: data.published_at || '',
    body: data.body || '',
  }
}
