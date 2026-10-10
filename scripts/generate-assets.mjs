/**
 * Generator aset PWA.
 *
 * Membuat ikon PNG tanpa dependensi gambar eksternal: SVG dirender menjadi
 * raster memakai `sharp` bila tersedia, jika tidak memakai kanvas Puppeteer
 * yang sudah terpasang untuk smoke test.
 *
 * Jalankan: node scripts/generate-assets.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PUBLIC_DIR = 'public'

const BRAND = '#4f46e5'
const BG = '#0f172a'

/** SVG ikon: nomor antrian + garis kertas thermal. */
function ticketSvg(size, { maskable = false } = {}) {
  const s = size
  const pad = maskable ? s * 0.14 : 0
  const inner = s - pad * 2
  const r = s * 0.22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="${BG}"/>
  <g transform="translate(${pad}, ${pad})">
    <rect x="0" y="0" width="${inner}" height="${inner}" rx="${r}" fill="${BRAND}"/>
    <text x="${inner / 2}" y="${inner * 0.44}" font-family="Segoe UI, Arial, sans-serif"
          font-size="${inner * 0.36}" font-weight="700" fill="#ffffff"
          text-anchor="middle" dominant-baseline="middle">A</text>
    <g stroke="#ffffff" stroke-width="${inner * 0.045}" stroke-linecap="round" opacity="0.92">
      <line x1="${inner * 0.28}" y1="${inner * 0.64}" x2="${inner * 0.72}" y2="${inner * 0.64}"/>
      <line x1="${inner * 0.28}" y1="${inner * 0.75}" x2="${inner * 0.60}" y2="${inner * 0.75}"/>
    </g>
    <text x="${inner / 2}" y="${inner * 0.88}" font-family="Segoe UI, Arial, sans-serif"
          font-size="${inner * 0.1}" fill="#ffffff" fill-opacity="0.8"
          text-anchor="middle" dominant-baseline="middle">ANTRIAN</text>
  </g>
</svg>`
}

async function svgToPng(svg, size) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-gpu', '--disable-extensions'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    await page.setContent(
      `<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">
         <img src="${dataUrl}" width="${size}" height="${size}" style="display:block">
       </body></html>`,
      { waitUntil: 'networkidle0' },
    )
    await page.waitForFunction(() => {
      const img = document.querySelector('img')
      return img && img.complete && img.naturalWidth > 0
    })
    return await page.screenshot({ type: 'png', omitBackground: false })
  } finally {
    await browser.close()
  }
}

mkdirSync(PUBLIC_DIR, { recursive: true })

const targets = [
  { file: 'pwa-192x192.png', size: 192, maskable: false },
  { file: 'pwa-512x512.png', size: 512, maskable: false },
  { file: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
  { file: 'favicon.ico', size: 64, maskable: false },
]

for (const t of targets) {
  const png = await svgToPng(ticketSvg(t.size, { maskable: t.maskable }), t.size)
  writeFileSync(`${PUBLIC_DIR}/${t.file}`, png)
  console.log(`  ${t.file.padEnd(26)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} KB`)
}

// robots.txt
writeFileSync(
  `${PUBLIC_DIR}/robots.txt`,
  ['User-agent: *', 'Allow: /', 'Disallow: /dev/', ''].join('\n'),
)
console.log('  robots.txt')

// Favicon SVG untuk browsers modern
writeFileSync(`${PUBLIC_DIR}/favicon.svg`, ticketSvg(64))
console.log('  favicon.svg')

for (const t of targets) {
  if (!existsSync(`${PUBLIC_DIR}/${t.file}`)) throw new Error(`gagal membuat ${t.file}`)
}
console.log('\nAset PWA selesai dibuat.')