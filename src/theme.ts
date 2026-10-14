// 主题与字号应用：html[data-theme] 驱动 token 换肤，--font-scale 驱动字号缩放。
// fontSize 语义为界面基准字号（px），默认 14；换算为 root 缩放比例（14 -> 1）。

export type ResolvedTheme = 'light' | 'dark'

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
}

export function applyFontScale(fontSizePx: number): void {
  const scale = Math.min(1.4, Math.max(0.7, (fontSizePx || 14) / 14))
  document.documentElement.style.setProperty('--font-scale', String(scale))
}
