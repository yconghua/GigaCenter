import jschardet from 'jschardet'

/** 编码检测：BOM 优先，其次 jschardet 统计，结果归一化为 iconv-lite 可用的编码名 */
export interface EncodingResult {
  encoding: string
  confidence: number | null
}

const BOM_RULES: Array<{ bytes: number[]; encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf8' },
  { bytes: [0xff, 0xfe], encoding: 'utf16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf16be' }
]

export function detectEncoding(buf: Buffer): EncodingResult {
  for (const rule of BOM_RULES) {
    if (buf.length >= rule.bytes.length && rule.bytes.every((b, i) => buf[i] === b)) {
      return { encoding: rule.encoding, confidence: 1 }
    }
  }
  const sample = buf.subarray(0, Math.min(buf.length, 1 << 20))
  try {
    const detected = jschardet.detect(sample)
    const confidence = typeof detected.confidence === 'number' ? detected.confidence : null
    return { encoding: normalizeEncoding(detected.encoding ?? ''), confidence }
  } catch {
    return { encoding: 'utf8', confidence: null }
  }
}

function normalizeEncoding(name: string): string {
  const n = (name ?? '').toLowerCase()
  if (n === 'gb2312' || n === 'gbk' || n === 'gb18030') return 'gb18030'
  if (n === 'big5') return 'big5'
  if (n.includes('utf') && n.includes('16')) return 'utf16le'
  return 'utf8'
}
