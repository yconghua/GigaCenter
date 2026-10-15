# GigaCenter 千兆宇宙中心

本地数据格式转换与数据分析工具（Electron 桌面版）。数据不出本机：原始文件只读打开，所有中间产物（临时 SQLite 库、解析缓存）放在系统临时目录并按运行实例隔离，关闭程序即自动清除。

## 功能总览

| 页面 | 说明 |
| --- | --- |
| 首页 | 产品介绍、使用流程、快捷键一览、数据安全说明 |
| 格式转换 | 导入 CSV / TXT / Excel，预览并编辑表名与列名，导出多种目标格式 |
| 数据分析 | 导入多个数据文件到临时 SQLite，编写 SQL 跨表查询，导出查询结果 |
| 系统设置 | 主题 / 表格密度 / 字号 / 快捷键自定义 / 高级开关 / 目录查看 / 诊断包 |

### 首页

- 产品介绍：定位为纯本地工具，说明数据不出本机、临时数据随退出清除
- 使用流程：分步骤引导（选择文件 → 预览确认 → 导出/查询）
- 快捷键一览：从当前偏好中实时读取展示（可在系统设置中修改）
- 数据安全说明：本地处理、日志脱敏、实例隔离等隐私基线

### 格式转换

- **导入**：点击选择或拖拽文件，支持 CSV / TXT / XLSX（旧版 .xls 会明确报错并引导另存）；自动探测编码（jschardet + iconv-lite）与表结构
- **预览**：每个工作表前 50 行预览；可设置表头行位置、逐列重命名列名、修改表名（自动去重与标识符清洗）；预览表格列宽支持拖拽调整
- **导出目标**：
  - SQL 脚本（.sql）：MySQL / PostgreSQL / SQL Server，按方言生成标识符引用、列类型映射、自增列与批量插入事务
  - SQLite（.db）
  - MongoDB（.ndjson）
  - CSV（UTF-8，含公式注入防护）
  - 可勾选多个工作表、设置表名前缀
- **导出预览与冲突策略**：导出前弹确认页，展示一致性检查结果（列名冲突 / 类型不兼容等）与待生成文件清单；目标文件已存在时可选「自动重命名加序号」或「覆盖现有文件」
- **会话**：页面内「重置」开启新会话，旧会话的解析缓存即被清除

### 数据分析

- **导入**：多文件选择，支持 SQLite / CSV / TXT / JSON（数组 / NDJSON / 单对象）/ Excel / SQL dump / BSON；先做只读结构探测（采样不落库），导入前弹「确认表名与列名」模态，可勾选工作表、设置表头行，确认后一次落库到会话临时 SQLite（WAL 模式）
- **查询**：SQL 编辑器（CodeMirror 语法高亮、sql-formatter 格式化、运行选中片段），支持同一会话内跨表 `SELECT`；左侧对象树展示表 / 视图 / 索引 / 触发器两级结构，可查看表结构
- **结果表**：点击表头排序、单元格 / 全部可见行复制、列宽拖拽、列显隐，虚拟滚动支持大结果集
- **导出**：查询结果导出 CSV / JSON / SQL，worker 内流式直写文件，原子写入不经过渲染进程中转
- **会话**：页面内「重置」开启新会话并删除旧会话数据

### 系统设置

- **外观**：主题三档（跟随系统 / 亮色 / 暗色）、表格密度（紧凑 / 标准 / 宽松）、界面字号滑杆（即时生效）
- **快捷键**：运行查询、运行选中 SQL、格式化 SQL、导出结果、打开文件、打开设置、取消任务，均可自定义
- **高级**：允许修改临时库（开启后执行非 SELECT 前需确认，修改只影响临时库）、启用长路径支持（路径超 260 字符时使用 `\\?\` 前缀，改动随下次创建 worker 即时生效）、系统通知开关（仅长任务完成 / 失败时弹出）
- **目录**：配置目录 / 日志目录 / 临时根目录查看与「打开目录」，展示当前实例 ID 与本实例临时占用空间
- **维护**：导出诊断包（脱敏 JSON：版本、系统、实例 ID、最近日志；不含原始数据与 SQL 全文）、清除本地偏好（重置全部设置）

### 会话与数据隔离

- 每个运行实例独立 ID，临时目录为 `%TEMP%\GigaCenter\<instanceId>`，实例之间互不影响
- 页面内「重置」开启新会话并清除旧会话数据；程序关闭即清空本实例全部临时数据，启动时另有兜底扫描清理残留
- 单实例锁：重复启动只聚焦已有窗口；关闭窗口时若有进行中任务 / 已导入数据 / 编辑中的 SQL，弹自研确认框防止误关

## 技术栈

- Electron 主进程（Node.js + TypeScript，重任务用 worker_threads 隔离：解析 / 探测 / 导入 / 查询 / 导出均在 worker 内执行，取消即 terminate）
- Vue 3 + Vite + TypeScript + Pinia（渲染进程，仅做壳和交互）
- better-sqlite3（SQLite，N-API 预编译，仅在 worker 内使用）
- CodeMirror 6（SQL 编辑器）、sql-formatter、@tanstack/vue-virtual（结果表虚拟滚动）
- exceljs（Excel 解析）、csv-parse、iconv-lite / jschardet（编码探测）、bson（BSON 解析）
- electron-log（统一日志 + 路径脱敏）、electron-builder（NSIS 打包）、Tailwind CSS

## 目录结构

```
GigaCenter/
├── .github/workflows/   # GitHub Actions 自动发布（打 tag + 打包 + Release）
├── electron/            # 主进程（Node.js + TS）
│   ├── main.ts          # 入口：单实例、窗口、主题、托盘、退出确认、数据目录
│   ├── preload.ts       # contextBridge 白名单 API（仅暴露 invoke / on）
│   ├── ipc/handlers.ts  # IPC handlers 注册与任务编排
│   ├── workers/         # worker_threads 入口（parse / probe / convert / query / import / export / analyze-probe）
│   ├── parsers/         # csv-parser、excel-parser、encoding（编码探测）
│   ├── exporters/       # csv / sql / ndjson 导出与方言配置（dialect.ts）
│   ├── convert/         # 格式转换链路编排、预览内容、源文件流式读取
│   ├── analyze/         # 分析端会话、导入器、查询与结果导出核心
│   ├── inference/       # 列类型推断
│   ├── core/            # 原子写、路径工具（标识符清洗 / 长路径）
│   ├── security/        # 路径白名单、SQL 预检
│   ├── temp/ task/ config/ log/   # 临时目录管理、任务状态机、配置存储、统一日志
├── shared/
│   └── ipc-types.ts     # IPC 通道与 payload 类型（三端共用）
├── src/                  # 渲染进程（Vue 3）
│   ├── pages/           # Home / Settings / convert/FormatConvert / analyze/AnalyzeWorkbench
│   ├── components/      # convert（导出预览/导出内容）、analyze（SQL 编辑器/结果表/导入导出弹窗）、feedback（自研弹窗体系）
│   ├── store/ router/ api/ i18n/ theme.ts
│   └── styles/          # 布局样式（主题 token 在 public/theme.css）
├── public/               # 静态资源：theme.css（主题 token）、icon.png、tray.png
├── build/                # 打包资源（icon.ico 等，仅打包配置用）
├── dist/ dist-electron/  # 构建产物（git 忽略）
├── release/              # 打包产物（git 忽略）
├── electron-builder.yml
└── package.json
```

## 开发与构建

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite dev server |
| `npm run dev:app` | 编译主进程并以 dev server 启动 Electron |
| `npm run build` | 构建渲染进程（含 vue-tsc 类型检查） |
| `npm run build:main` | 编译主进程到 dist-electron |
| `npm run rebuild` | electron-rebuild 重编 better-sqlite3 原生模块 |
| `npm run start` | 编译主进程并加载构建产物启动 |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run dist` | 构建 + 编译主进程 + electron-builder 打包 NSIS 安装包（无需本机 VS 工具链） |

## 安装与运行

- 打包产物：`release\GigaCenter Setup <版本>.exe`（NSIS 安装包，Windows x64）
- 安装包支持自定义安装目录，创建桌面与开始菜单快捷方式；卸载时清理快捷方式
- 绿色运行：`release\win-unpacked\GigaCenter.exe` 可直接双击运行，无需安装
- 用户数据目录统一为 `%LOCALAPPDATA%\GigaCenter`（配置 / 日志 / 诊断包子目录分开）

## 数据目录与数据安全

| 目录 | 用途 | 清理 |
| --- | --- | --- |
| `%LOCALAPPDATA%\GigaCenter\config` | UI 偏好 `preferences.json` | 设置页「清除本地偏好」 |
| `%LOCALAPPDATA%\GigaCenter\logs` | 滚动日志（全量操作事件，路径脱敏） | 自动滚动 |
| `%LOCALAPPDATA%\GigaCenter\diagnostics` | 手动导出的诊断包 | 手动删除 |
| `%TEMP%\GigaCenter\<instanceId>` | 会话 / 任务中间产物（临时 SQLite、解析缓存） | 退出清理 + 启动扫描兜底 |

- 日志只记录操作事件（导入文件名、文件大小、任务状态等），不记录文件内容与 SQL 全文
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

推送到 `main` 分支（或在 Actions 页面手动触发）后，`.github/workflows/release.yml` 自动执行三阶段流水线（同一时间只允许一条发布流水线运行）：

1. **prepare**（ubuntu-latest）：读取 `package.json` 的 `version`，检查 `v<版本>` tag 是否已存在；不存在则自动创建并推送 tag，版本未变化时整条流水线跳过
2. **build**（windows-latest）：`npm ci` 安装依赖 → `npm run build` 构建前端 → `npm run build:main` 编译主进程 → `npx electron-builder --publish never` 打包（未配置代码签名，自动跳过签名），并上传安装包为构建产物
3. **release**（ubuntu-latest）：下载全部产物，通过 softprops/action-gh-release 发布到 GitHub Release，自动生成变更说明

用法：修改 `package.json` 的 `version` 后推送 `main` 分支即可，无需手动打 tag。

## 安全与隐私基线

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，index.html 配置严格 CSP
- preload 只暴露 `window.gigacenter = { invoke, on }`，通道白名单校验；渲染进程无 Node.js API 访问能力
- 弹窗全部自研组件体系（Dialog / Toast / Banner），禁用浏览器 alert/confirm/prompt 与原生消息框
- 全链路本地处理：原始文件只读，导入解析与查询导出均在本机完成，无任何网络上报
- 日志与诊断包均做路径脱敏，不含文件内容与 SQL 全文；配置只存 UI 偏好，不存原始数据
