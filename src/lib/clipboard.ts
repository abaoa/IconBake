// clipboard.ts
// Copying PUA icon characters is the usual next step after previewing them.
// `navigator.clipboard` needs a secure context / permission that a Tauri webview
// does not always grant, so fall back to the legacy selection trick.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    ta.remove()
    return ok
  } catch {
    return false
  }
}
