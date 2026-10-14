import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logger } from '../log'
import type { AppPreferences } from '../../shared/ipc-types'

// 配置持久化边界：只存 UI 偏好。
// 目录 %LOCALAPPDATA%\GigaCenter\config，preferences.json 独立文件。
// 不存原始数据、不存查询结果、不存用户文件名、不存临时路径。

const DEFAULT_SHORTCUTS: Record<string, string> = {
  runQuery: 'Ctrl+Enter',
  runSelected: 'Ctrl+Shift+Enter',
  formatSql: 'Ctrl+Shift+F',
  exportResult: 'Ctrl+S',
  openFile: 'Ctrl+O',
  openSettings: 'Ctrl+,',
  cancel: 'Esc'
}

const DEFAULTS: AppPreferences = {
  theme: 'system',
  tableDensity: 'normal',
  fontSize: 14,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  lastOpenDirectory: '',
  lastExportDirectory: '',
  allowModifyTempDb: false,
  longPathSupport: false,
  notificationsEnabled: true
}

export class ConfigStore {
  readonly configDir: string
  private readonly prefsPath: string
  private prefs: AppPreferences = { ...DEFAULTS }

  constructor() {
    this.configDir = path.join(app.getPath('userData'), 'config')
    this.prefsPath = path.join(this.configDir, 'preferences.json')
  }

  init(): void {
    fs.mkdirSync(this.configDir, { recursive: true })
    this.prefs = { ...DEFAULTS, ...this.readJson<Partial<AppPreferences>>(this.prefsPath, {}) }
  }

  getPreferences(): AppPreferences {
    return { ...this.prefs }
  }

  setPreferences(patch: Partial<AppPreferences>): AppPreferences {
    this.prefs = { ...this.prefs, ...patch }
    this.writeJson(this.prefsPath, this.prefs)
    return this.getPreferences()
  }

  /** 清除偏好：删 preferences.json，重置为默认 */
  clearPreferences(): void {
    this.prefs = { ...DEFAULTS }
    this.removeFile(this.prefsPath)
  }

  configDirSize(): number {
    return this.dirSize(this.configDir)
  }

  private readJson<T>(p: string, fallback: T): T {
    try {
      if (!fs.existsSync(p)) return fallback
      return (JSON.parse(fs.readFileSync(p, 'utf-8')) as T) ?? fallback
    } catch (err) {
      logger.warn('config read failed', { path: p, error: String(err) })
      return fallback
    }
  }

  private writeJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmp, p)
    } catch (err) {
      logger.error('config write failed', { path: p, error: String(err) })
    }
  }

  private removeFile(p: string): void {
    try {
      if (fs.existsSync(p)) fs.rmSync(p)
    } catch (err) {
      logger.warn('config clear failed', { path: p, error: String(err) })
    }
  }

  private dirSize(p: string): number {
    try {
      if (!fs.existsSync(p)) return 0
      let total = 0
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) total += fs.statSync(full).size
        }
      }
      walk(p)
      return total
    } catch {
      return 0
    }
  }
}
