export async function copyRich(html, text) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html || text], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      })
      await navigator.clipboard.write([item])
      return true
    } catch {
      // fall through
    }
  }
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    return true
  } catch {
    return false
  }
}
