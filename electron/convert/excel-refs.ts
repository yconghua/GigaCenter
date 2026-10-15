/** Excel A1 样式单元格引用与共享公式解析：列号换算、公式按行列偏移平移 */

/** 列字母转列号（A=1, K=11） */
export function colToNum(col: string): number {
  let n = 0
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** 列号转列字母（1=A, 11=K） */
export function numToCol(n: number): string {
  let s = ''
  while (n > 0) {
    n--
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

/** 公式中恰好"3字母+数字"的函数名（LOG10），避免把函数名当单元格引用平移 */
const FN_WITH_DIGITS = new Set(['LOG'])

/**
 * 把公式文本中的相对单元格引用按行列偏移平移（绝对 $ 引用不动）。
 * 示例：master="I4*J4" 平移到下一行 => "I5*J5"；"$I4" => "$I5"；"I$4" 行不变。
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (full, colAbs: string, col: string, rowAbs: string, row: string) => {
    const upper = col.toUpperCase()
    if (FN_WITH_DIGITS.has(upper)) return full
    let newCol = col
    let newRow = row
    if (!colAbs) {
      const n = colToNum(upper) + dCol
      if (n >= 1 && n <= 16384) {
        newCol = numToCol(n)
        if (col !== upper) newCol = newCol.toLowerCase()
      }
    }
    if (!rowAbs) {
      const n = Number(row) + dRow
      if (n >= 1) newRow = String(n)
    }
    return `${colAbs}${newCol}${rowAbs}${newRow}`
  })
}

/** 最小工作表接口（exceljs Worksheet 兼容） */
export interface CellLookup {
  getCell(row: number, col: number): { value?: unknown }
}

/**
 * 共享公式从属单元格（{ sharedFormula: 'K4', result }）恢复为带平移后公式文本的对象；
 * 非共享公式形态原样返回。
 */
export function resolveSharedFormula(
  ws: CellLookup,
  row: number,
  col: number,
  value: unknown
): unknown {
  if (value === null || typeof value !== 'object') return value
  const sf = (value as { sharedFormula?: unknown }).sharedFormula
  if (typeof sf !== 'string') return value
  const m = /^([A-Z]+)(\d+)$/.exec(sf)
  if (!m) return value
  const masterRow = Number(m[2])
  const masterCol = colToNum(m[1])
  const masterVal = ws.getCell(masterRow, masterCol).value
  if (masterVal === null || typeof masterVal !== 'object') return value
  const formula = (masterVal as { formula?: unknown }).formula
  if (typeof formula !== 'string') return value
  return {
    formula: shiftFormula(formula, row - masterRow, col - masterCol),
    result: (value as { result?: unknown }).result
  }
}
