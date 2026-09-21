import { useEffect, useRef } from 'react'
import { proxiedImageUrl, formatExamlyCodeBlocks } from '../lib/helpers'

export default function RichHtml({ html, className = '' }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Question HTML comes from the portal's editor, where it's authored against a WHITE
    // background — so it often carries inline `color: #333`/`rgb(0,0,0)` (or legacy <font
    // color>) that turns near-invisible on our dark theme. Strip any author-set text and
    // background colours so everything inherits the app's own theme colour instead. Bold /
    // italic / lists / spacing are all left alone; only colour is neutralised.
    el.querySelectorAll('[style]').forEach(node => {
      node.style.removeProperty('color')
      node.style.removeProperty('background-color')
      node.style.removeProperty('background')
      if (!node.getAttribute('style')) node.removeAttribute('style')
    })
    el.querySelectorAll('font[color]').forEach(node => node.removeAttribute('color'))

    const imgs = el.querySelectorAll('img')
    imgs.forEach(img => {
      const original = img.getAttribute('src') || ''
      if (!original) return
      // Route through our backend so the browser never talks to S3 directly (see proxiedImageUrl).
      img.src = proxiedImageUrl(original)
      img.addEventListener('error', () => {
        const chip = document.createElement('span')
        chip.className = 'inline-flex items-center gap-1 rounded-full bg-red-500/10 text-red-300 text-[11px] px-2 py-0.5 cursor-pointer'
        chip.title = `${original}\n(couldn't load even via the proxy — click to try the original URL)`
        chip.textContent = '🖼️🚫 blocked'
        chip.addEventListener('click', () => window.open(original, '_blank'))
        img.replaceWith(chip)
      }, { once: true })
    })
  }, [html])

  return <div ref={ref} className={`rich-html ${className}`} dangerouslySetInnerHTML={{ __html: formatExamlyCodeBlocks(html) }} />
}

export function ImageThumbs({ urls, size = 64 }) {
  if (!urls?.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {urls.map((u, i) => (
        <Thumb key={i} url={u} size={size} />
      ))}
    </div>
  )
}

function Thumb({ url, size }) {
  return (
    <img
      src={proxiedImageUrl(url)}
      loading="lazy"
      style={{ maxWidth: size, maxHeight: size }}
      className="rounded-md border border-theme object-cover cursor-pointer"
      title="Click to view full size"
      onClick={(e) => { e.stopPropagation(); window.open(proxiedImageUrl(url), '_blank') }}
      onError={(e) => {
        const el = e.currentTarget
        const chip = document.createElement('span')
        chip.className = 'inline-flex items-center gap-1 rounded-full bg-red-500/10 text-red-300 text-[11px] px-2 py-0.5 cursor-pointer'
        chip.title = "Couldn't load even via the proxy — click to try the original URL"
        chip.textContent = '🖼️🚫 blocked'
        chip.addEventListener('click', (ev) => { ev.stopPropagation(); window.open(url, '_blank') })
        el.replaceWith(chip)
      }}
    />
  )
}
