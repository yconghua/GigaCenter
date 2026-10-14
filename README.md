# GigaCenter 千兆宇宙中心

本地数据格式转换与数据分析工具（Electron 桌面版）。数据不出本机，原始文件只读打开，所有中间产物（临时 SQLite、解析缓存）放在系统临时目录并按实例隔离，关闭程序即自动清除。

## 功能总览

| 页面 | 说明 |
| --- | --- |
| 首页 | 产品介绍、使用流程、快捷键一览、数据安全说明 |
| 格式转换 | 导入 CSV / TXT / Excel，预览并命名表名与列名，导出多种目标格式 |
| 数据分析 | 导入多个数据文件到临时 SQLite，编写 SQL 跨表查询，导出查询结果 |
| 系统设置 | 主题 / 字号 / 快捷键 / 高级开关 / 目录查看 / 诊断包 |

### 格式转换

- 导入：点击选择或拖拽文件（CSV / TXT / XLSX / XLS），自动探测编码与结构
- 预览：每个工作表前 50 行预览，可设置表头行、公式取值（计算值/公式文本）、合并单元格（填充首值/留空）、逐列类型
- 导出：CSV（UTF-8，公式注入防护）/ SQLite（.db）/ MySQL / PostgreSQL / SQL Server（.sql）/ MongoDB（.ndjson），可勾选多个工作表、设置表名前缀
- 会话：页面内「重置」开启新会话，旧会话的解析缓存即被清除

### 数据分析

- 导入：多文件选择（SQLite / CSV / TXT / JSON / Excel / SQL dump / BSON），导入前弹「确认表名与列名」模态，确认后一次落库
- 查询：SQL 编辑器（语法高亮、格式化、运行选中片段），支持同一会话内跨表 `SELECT`；查询结果支持列拖动调整宽度
- 对象：左侧展示表 / 视图 / 索引 / 触发器两级树，可查看表结构
- 导出：查询结果导出 CSV / JSON / SQL，原子写入
- 会话：页面内「重置」开启新会话并删除旧会话数据

### 系统设置

- 外观：主题三档（跟随系统 / 亮色 / 暗色）、界面字号滑杆（12–18px）
- 快捷键：运行查询、运行选中 SQL、格式化 SQL、导出结果、打开文件、打开设置、取消任务，均可自定义
- 高级：允许修改临时库（打开后执行非 SELECT 前需确认，修改只影响临时库）、启用长路径支持（路径超 260 字符时使用 `\\?\` 前缀，改动即时生效）、系统通知开关
- 目录：配置目录 / 日志目录 / 临时根目录查看与「打开目录」，当前实例 ID
- 维护：导出诊断包（脱敏 JSON）、清除本地偏好（重置全部设置）

## 技术栈

- Electron 主进程（Node.js + TypeScript，重任务用 worker_threads 隔离，取消 = terminate）
- Vue 3 + Vite + TS + Pinia（渲染进程，仅做壳和交互）
- better-sqlite3（SQLite，N-API 预编译，worker 内使用）
- electron-log（统一日志 + 路径脱敏）、electron-builder（NSIS 打包）、Tailwind CSS

## 目录结构

```
GigaCenter/
├── .github/workflows/   # GitHub Actions 自动发布（打 tag + 打包 + Release）
├── electron/            # 主进程（Node.js + TS）
│   ├── main.ts          # 入口：单实例、窗口、主题、图标、退出确认
│   ├── preload.ts       # contextBridge 白名单 API
│   ├── ipc/             # IPC handlers
│   ├── workers/         # worker_threads 入口（解析/查询/导出/导入）
│   ├── log/             # 统一日志（路径脱敏）
│   ├── core/            # 原子写、路径工具、SQL 预检
│   ├── temp/ task/ config/ security/  # 临时目录、任务、配置、白名单
│   └── parsers/ exporters/ analyze/ convert/ inference/
├── shared/
│   └── ipc-types.ts     # IPC 通道与 payload 类型（三端共用）
├── src/                 # 渲染进程（Vue 3）
│   ├── pages/           # Home / convert / analyze / Settings
│   ├── components/      # 自研弹窗体系、SQL 编辑器、结果表等
│   ├── store/ router/ i18n/ api/ theme.ts
│   └── styles/          # 布局样式（主题 token 在 public/theme.css）
├── public/              # 静态资源：theme.css（主题 token）、icon.png、tray.png
├── build/               # 打包资源（icon.ico 等，仅打包配置用）
├── dist/ dist-electron/ # 构建产物（git 忽略）
├── release/             # 打包产物（git 忽略）
├── electron-builder.yml
└── package.json
```

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite dev server |
| `npm run dev:app` | 编译主进程并以 dev server 启动 Electron |
| `npm run build` | 构建渲染进程（含 vue-tsc 类型检查） |
| `npm run build:main` | 编译主进程到 dist-electron |
| `npm run start` | 编译主进程并加载构建产物启动 |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run dist` | 构建并打包 NSIS 安装包（无需本机 VS 工具链） |

## 安装与运行

- 打包产物：`release\GigaCenter Setup <版本>.exe`（NSIS 安装包，Windows x64）。
- 安装包支持自定义安装目录，创建桌面与开始菜单快捷方式；卸载时清理快捷方式。
- 绿色运行：`release\win-unpacked\GigaCenter.exe` 可直接双击运行，无需安装。
- 单实例：重复启动只会聚焦已有窗口。
- 关闭窗口时若有进行中的任务 / 已导入数据 / 编辑中的 SQL，会弹出确认，防止误关导致数据丢失。

## 数据目录与数据安全

| 目录 | 用途 | 清理 |
| --- | --- | --- |
| `%LOCALAPPDATA%\GigaCenter\config` | UI 偏好 `preferences.json` | 设置页「清除本地偏好」 |
| `%LOCALAPPDATA%\GigaCenter\logs` | 滚动日志（全量操作事件，路径脱敏） | 自动滚动 |
| `%LOCALAPPDATA%\GigaCenter\diagnostics` | 手动导出的诊断包 | 手动删除 |
| `%TEMP%\GigaCenter\<instanceId>` | 会话/任务中间产物（临时 SQLite、解析缓存） | 退出清理 + 启动扫描兜底 |

- 每个运行实例独立 ID，临时目录按实例隔离；关闭程序即清空本次实例数据
- 日志只记录操作事件（导入文件、文件名、文件大小、任务状态等），不记录文件内容与 SQL 全文
- 配置只存 UI 偏好，不存原始数据、查询结果与完整路径

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

## 打包与自动发布

本地打包：`npm run dist`（产出到 `release/`）。

推送到 GitHub 后，`.github/workflows/release.yml` 会自动：
1. 读取 `package.json` 的 `version`，若 `v<版本>` 的 tag 不存在则自动打 tag；
2. 在 Windows runner 上构建前端 + 编译主进程 + electron-builder 打包；
3. 将安装包上传为 GitHub Release（版本号未变化时自动跳过）。

## 安全基线

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、严格 CSP
- preload 只暴露 `window.gigacenter = { invoke, on }`，通道白名单校验
- 渲染进程无 Node.js API 访问能力
- 弹窗全部自研组件，禁用浏览器 alert/confirm/prompt 与 Electron dialog 消息框
