// 主题与字号应用：在 <html> 上设置 data-theme 属性驱动 CSS token 换肤，--font-scale 驱动 root 字号缩放。
// fontSize 语义为界面基准字号（px），默认 14；按 14px 归一化为 root 缩放比例（14 -> 1），并限制在 0.7～1.4 区间。

export type ResolvedTheme = 'light' | 'dark'

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
}

export function applyFontScale(fontSizePx: number): void {
  const scale = Math.min(1.4, Math.max(0.7, (fontSizePx || 14) / 14))
  document.documentElement.style.setProperty('--font-scale', String(scale))
}
