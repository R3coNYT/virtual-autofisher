// Generates the app icons with Node built-ins only (zlib for PNG, hand-written ICO container).
// Usage: node scripts/make-icons.mjs   -> resources/icon.png, resources/icon-alert.png, build/icon.ico
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const SIZE = 256
const SS = 3 // supersampling per axis

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const BG = hex('#0a1628')

/** Fish facing right, hook line above: all shapes in a 256x256 space. Returns an RGB colour or null. */
function shade(x, y, accent) {
  // rounded-square background
  const r = 48
  const cx = Math.min(Math.max(x, r), SIZE - r)
  const cy = Math.min(Math.max(y, r), SIZE - r)
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null

  let c = BG
  // fishing line + hook (top-right)
  const lineX = 168
  if (Math.abs(x - lineX) < 2.5 && y < 70) c = accent
  const hx = x - lineX
  const hy = y - 70
  const d = Math.hypot(hx + 0, hy - 14)
  if (hy > -2 && Math.abs(d - 14) < 2.5 && hx > -16 && hy > 0 && !(hx < 0 && hy < 14)) c = accent

  // body: ellipse centred (118, 150)
  const bx = (x - 118) / 74
  const by = (y - 150) / 40
  const inBody = bx * bx + by * by <= 1
  // tail: triangle (60,150) -> (22,112) / (22,188)
  const inTail = x >= 20 && x <= 62 && Math.abs(y - 150) <= (x - 20) * (38 / 42) * 0 + (62 - x) * 0.9 + 0 && x < 62
  // dorsal fin
  const inFin = y < 150 && y > 100 && x > 96 && x < 140 && y > 150 - 40 * Math.sqrt(Math.max(0, 1 - ((x - 118) / 74) ** 2)) - 22 * (1 - Math.abs(x - 118) / 22)
  if (inBody || inTail || inFin) c = accent
  // eye
  if ((x - 168) ** 2 + (y - 140) ** 2 <= 36) c = BG
  // gill
  if (inBody && Math.abs(Math.hypot(x - 150, y - 150) - 30) < 2.5 && x < 150) c = BG
  return c
}

/** Renders the 256-unit design at `size` px (supersampled; more samples for small sizes). */
function render(accent, size = SIZE) {
  const k = SIZE / size
  const ss = Math.max(SS, Math.ceil(SS * k / 2))
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) * k, (y + (sy + 0.5) / ss) * k, accent)
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++ }
        }
      }
      const o = (y * size + x) * 4
      if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a) }
      px[o + 3] = Math.round((a / (ss * ss)) * 255)
    }
  }
  return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(rgba, size = SIZE) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO container with one PNG-compressed image per size (Windows picks the closest: crisp taskbar/shortcut). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    head[e] = size >= 256 ? 0 : size // 0 means 256
    head[e + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bpp
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((im) => im.data)])
}

mkdirSync('resources', { recursive: true })
mkdirSync('build', { recursive: true })
const normal = png(render(hex('#22d3ee')))
const alert = png(render(hex('#ef4444')))
writeFileSync('resources/icon.png', normal)
writeFileSync('resources/icon-alert.png', alert)
const cyan = hex('#22d3ee')
writeFileSync('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(render(cyan, size), size) }))))
console.log('icons written')
