import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, Tray } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { IPC_CHANNELS } from '../shared/ipc-types'
import { initLogger, logger } from './log'
import { getInstanceId, registerIpcHandlers, cancelAllActiveTasks } from './ipc/handlers'
import { closeAllSessions as closeAllPythonSessions } from './python/session'
import { TempManager } from './temp/temp-manager'
import { TaskManager } from './task/task-manager'
import { ConfigStore } from './config/store'
import { PathWhitelist } from './security/path-whitelist'

// 单实例锁：拿不到锁说明已有实例在运行，直接退出；聚焦已有窗口由 second-instance 回调处理。
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  // 用户数据目录统一到 %LOCALAPPDATA%\GigaCenter（配置/日志等子目录分开，见文档）。
  // 目录名用英文，中文只用于界面展示（窗口标题/托盘/logo）。
  if (process.env.LOCALAPPDATA) {
    const legacyDir = path.join(process.env.LOCALAPPDATA, '千兆宇宙中心')
    const newDir = path.join(process.env.LOCALAPPDATA, 'GigaCenter')
    // 一次性迁移：旧中文目录存在且新目录不存在时整体改名，保留既有配置与日志。
    try {
      if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
        fs.renameSync(legacyDir, newDir)
      }
    } catch (err) {
      // 迁移失败不阻断启动：继续按新目录运行，旧中文目录保留待手动处理。
      console.error('user data dir migration failed', err)
    }
    app.setPath('userData', newDir)
  }
  // 不设 AppUserModelId：Windows 找不到 AUMID 注册时会回退默认图标/名称（Electron）。
  // 不设置时任务栏按钮/系统通知直接采用 exe 图标与名称（GigaCenter），符合预期。
  initLogger()

  // 运行时图标：public → dist 复制后随包携带（开发/打包路径一致）；build/ 仅打包配置使用。
  const APP_ICON = path.join(__dirname, '../../dist/icon.png')
  const TRAY_ICON = path.join(__dirname, '../../dist/tray.png')

  const temp = new TempManager(getInstanceId())
  const config = new ConfigStore()
  const whitelist = new PathWhitelist()
  const tasks = new TaskManager((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.eventTask, event)
    }
    // 系统通知：仅长任务完成/失败时弹出，可在设置里关闭。
    if (
      (event.type === 'task-done' || event.type === 'task-error') &&
      config.getPreferences().notificationsEnabled
    ) {
      const title = event.type === 'task-done' ? '任务完成' : '任务失败'
      const body =
        typeof event.payload === 'object' && event.payload && 'message' in event.payload
          ? String((event.payload as { message: string }).message)
          : '查看数据工作台'
      // 通知显式指定图标：运行时图标随 dist 打包（public → dist），不依赖 build/ 目录。
      new Notification({ title, body, icon: nativeImage.createFromPath(APP_ICON), silent: false }).show()
    }
  })

  let tray: Tray | null = null

  logger.info('app starting', {
    instanceId: getInstanceId(),
    electron: process.versions.electron,
    node: process.versions.node
  })

  // 移除窗口自带的 File/Edit/View/Window 原生菜单栏；托盘菜单独立设置，不受影响。
  Menu.setApplicationMenu(null)

  // 按持久化偏好设置主题来源（system 跟随操作系统，dark/light 强制指定）。
  nativeTheme.themeSource = config.getPreferences().theme

  function createWindow(): void {
    const isDark = nativeTheme.shouldUseDarkColors
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      title: '千兆宇宙中心',
      // 窗口创建底色与当前主题一致，避免暗色主题下启动白闪。
      backgroundColor: isDark ? '#1b1b20' : '#f5f5f7',
      autoHideMenuBar: true,
      icon: nativeImage.createFromPath(APP_ICON),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })

    // 关闭窗口拦截：一律询问渲染进程。前端判断是否有任务运行/已导入数据/SQL 内容，
    // 有则弹自研确认框，确认后调 confirmClose 销毁；渲染进程不可用时超时强制关闭。
    win.on('close', (e) => {
      e.preventDefault()
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(IPC_CHANNELS.eventTask, {
        seq: 0,
        type: 'task-progress',
        taskId: '',
        phase: 'app',
        payload: { appCloseRequested: true },
        at: Date.now()
      })
      setTimeout(() => {
        if (win.isDestroyed()) return
        if (win.webContents.isCrashed() || win.webContents.isDestroyed()) win.destroy()
      }, 5000)
    })

    // 任务运行中最小化时隐藏到托盘（点击托盘或任务栏图标可恢复）。
    win.on('minimize', () => {
      if (tasks.isPageBusy('convert') || tasks.isPageBusy('analyze') && tray) {
        win.hide()
        new Notification({ title: '千兆宇宙中心', body: '任务运行中，已最小化到托盘', icon: nativeImage.createFromPath(APP_ICON), silent: true }).show()
      }
    })

    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    if (devServerUrl) {
      void win.loadURL(devServerUrl)
    } else {
      void win.loadFile(path.join(__dirname, '../../dist/index.html'))
    }

    // 事件推送探针：验证主进程到渲染进程的 webContents.send 通道可用。
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(IPC_CHANNELS.eventProbe, {
        from: 'main',
        at: Date.now(),
        instanceId: getInstanceId()
      })
    })
  }

  app.whenReady().then(() => {
    temp.init()
    config.init()
    registerIpcHandlers({ temp, config, tasks, whitelist })
    createWindow()

    // 托盘：常驻系统托盘，任务运行中最小化到托盘；点击恢复主窗口。
    // 用专用 16x16 透明 PNG（不经 ico/resize，避免托盘显示白块）。
    try {
      let img = nativeImage.createFromPath(TRAY_ICON)
      if (img.isEmpty()) img = nativeImage.createFromPath(APP_ICON)
      tray = new Tray(img)
      tray.setToolTip('千兆宇宙中心')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示主窗口', click: () => showMainWindow() },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() }
        ])
      )
      tray.on('click', () => showMainWindow())
    } catch (err) {
      logger.warn('tray init failed', { error: String(err) })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 正常退出时清理本实例临时根；强杀进程不经过此流程，由启动扫描兜底。
  app.on('before-quit', () => {
    logger.info('[event=app-quit]', { reason: 'normal' })
    // 先终止全部 worker 并终结任务，再关闭会话、清理临时目录。
    cancelAllActiveTasks()
    closeAllPythonSessions()
    temp.dispose()
  })
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
