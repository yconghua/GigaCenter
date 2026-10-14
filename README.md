# GigaCenter 千兆宇宙中心

本地数据格式转换与数据分析工具（Electron 版）。数据不出本机，原始文件只读打开，所有中间产物放系统临时目录并按任务隔离。

## 技术栈

- Electron 主进程（Node.js + TypeScript，重任务用 worker_threads 隔离，取消 = terminate）
- Vue 3 + Vite + TS + Pinia（渲染进程，仅做壳和交互）
- better-sqlite3（SQLite，同步 API，worker 内使用；WAL 模式）
- electron-log（滚动日志 + 脱敏）、electron-builder（NSIS 打包）、Tailwind CSS

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite dev server |
| `npm run dev:app` | 编译主进程并以 dev server 启动 Electron |
| `npm run build` | 构建渲染进程（含 vue-tsc 类型检查） |
| `npm run build:main` | 编译主进程到 dist-electron |
| `npm run start` | 编译主进程并加载构建产物启动 |
| `npm run rebuild` | 重建 better-sqlite3 匹配 Electron ABI |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run dist` | 打包 NSIS 安装包 |

## 目录结构

```
GigaCenter/
├── electron/          # 主进程（Node.js + TS）
│   ├── main.ts        # 入口：单实例、窗口、CSP
│   ├── preload.ts     # contextBridge 白名单 API
│   ├── ipc/           # IPC handlers
│   ├── workers/       # worker_threads 入口
│   ├── log/           # 统一日志宏（脱敏）
│   └── ...            # core/sql/temp/task/config/security 等后续阶段填充
├── shared/
│   └── ipc-types.ts   # IPC 通道与 payload 类型（三端共用）
├── src/               # 渲染进程（Vue 3）
│   ├── router/        # hash 路由 + 404
│   ├── i18n/          # $t() 文案，初期中文
│   ├── store/         # Pinia
│   ├── pages/         # 数据工作台 / 系统设置
│   └── components/    # 自研弹窗体系（阶段 1 填充）
├── build/             # 打包资源（icon.ico 等）
└── electron-builder.yml
```

## 安装与运行

- 打包产物：`release\GigaCenter Setup 0.1.0.exe`（NSIS 安装包，Win10 1903+ x64）。
- 安装包支持自定义安装目录，创建桌面与开始菜单快捷方式；卸载时清理快捷方式。
- 绿色运行：`release\win-unpacked\GigaCenter.exe` 可直接双击运行，无需安装。
- 单实例：重复启动只会聚焦已有窗口。

## 数据目录

| 目录 | 用途 | 清理 |
| --- | --- | --- |
| `%LOCALAPPDATA%\GigaCenter\config` | UI 偏好 `preferences.json`、收藏 `favorites.json` | 设置页两个"清除"按钮独立生效 |
| `%LOCALAPPDATA%\GigaCenter\logs` | 滚动日志（默认 INFO，7 天 / 单文件 20MB / 总量 200MB） | 自动滚动 |
| `%LOCALAPPDATA%\GigaCenter\diagnostics` | 手动导出的诊断包 | 手动删除 |
| `%TEMP%\GigaCenter\<instanceId>` | 会话/任务中间产物（临时 SQLite、解析缓存） | 退出清理 + 启动扫描兜底 |

配置只存 UI 偏好与收藏，不存原始数据、查询结果、文件名与临时路径。

## 快捷键（系统设置可改）

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Enter` | 执行查询 |
| `Ctrl+Shift+Enter` | 执行选中 SQL |
| `Ctrl+Shift+F` | 格式化 SQL |
| `Ctrl+S` | 导出当前结果 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+,` | 打开系统设置 |
| `Esc` | 取消当前弹窗 / 取消任务 |

## 诊断包

设置页"导出诊断包"生成脱敏 JSON：应用版本、Electron/Node 版本、系统信息、实例 ID、临时目录占用、最近 80 行日志。不含原始数据、SQL 全文、完整路径与用户文件名。

## 安全基线

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、严格 CSP
- preload 只暴露 `window.gigacenter = { invoke, on }`，通道白名单校验
- 渲染进程无 Node.js API 访问能力
- 弹窗全部自研组件，禁用浏览器 alert/confirm/prompt 与 Electron dialog 消息框
