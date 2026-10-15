import type { ColumnType } from '../../shared/ipc-types'

/** 类型推断：对一列采样值按正则归类为 integer/real/date/boolean，空值不计入分母；最佳类型占比低于 0.95 时提示人工确认。 */

export interface InferResult {
  type: ColumnType
  confidence: number
  needsConfirm: boolean
  warnings: string[]
}

const INTEGER_RE = /^[+-]?\d+$/
const REAL_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/
const BOOLEAN_RE = /^(true|false)$/i
const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?$/
const LONG_NUMBER_LIMIT = 18

// 类型判定优先级：integer > real > date > boolean，计数并列时排在前者胜出
const ORDER: ColumnType[] = ['integer', 'real', 'date', 'boolean']

export function inferColumn(values: (string | null)[]): InferResult {
  const nonEmpty = values.filter((v): v is string => v !== null && v !== '')
  if (nonEmpty.length === 0) {
    return { type: 'text', confidence: 1, needsConfirm: false, warnings: [] }
  }

  const count: Record<ColumnType, number> = { text: 0, integer: 0, real: 0, date: 0, boolean: 0 }
  const warnings = new Set<string>()
  let leadingZeroSeen = false

  for (const v of nonEmpty) {
    if (v.length > 1 && /^0\d+$/.test(v)) leadingZeroSeen = true  // 出现前导零（如 007），后续强制按文本保留
    if (BOOLEAN_RE.test(v)) {
      count.boolean++
      continue
    }
    if (INTEGER_RE.test(v)) {
      if (v.replace(/^[+-]/, '').length > LONG_NUMBER_LIMIT) {
        count.text++
        warnings.add('长数字保持为文本，避免精度丢失')
      } else {
        count.integer++
      }
      continue
    }
    if (REAL_RE.test(v)) {
      count.real++
      continue
    }
    if (DATE_RE.test(v)) {
      count.date++
      continue
    }
    count.text++
  }

  let best: ColumnType = 'text'
  let bestCount = count.text
  for (const c of ORDER) {
    if (count[c] > bestCount) {
      best = c
      bestCount = count[c]
    }
  }
  if (leadingZeroSeen && best === 'integer') {
    best = 'text'
    bestCount = count.text
    warnings.add('检测到前导零，已按文本处理')
  }
  // 纯数字列混入极少量文本时仍按数字处理（置信度会降低），不强制 text
  const confidence = bestCount / nonEmpty.length
  const needsConfirm = confidence < 0.95 && best !== 'text'
  if (needsConfirm) {
    warnings.add(`类型置信度 ${Math.round(confidence * 100)}%，建议确认`)
  }
  return {
    type: best,
    confidence: Math.round(confidence * 1000) / 1000,
    needsConfirm,
    warnings: [...warnings]
  }
}
