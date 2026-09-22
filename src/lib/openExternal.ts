export async function openExternal(url: string) {
  try {
    // In Tauri, use the shell API so links open in the system browser.
    const { open } = await import('@tauri-apps/api/shell')
    await open(url)
  } catch {
    // Fallback for the web build or if Tauri is not available.
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
