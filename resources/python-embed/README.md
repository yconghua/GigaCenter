# Python 精简运行时（离线捆绑基线）

本目录为 electron-builder `extraResources` 的打包来源，构建安装包前需在此放置可用的精简 Python：

1. 下载官方 Windows embeddable 包（python.org → Windows embeddable package，64 位）；
2. 解压到本目录（目录内含 `python.exe`）；
3. 启用 `python._pth` 中的 `import site`，并把本目录加入 `site-packages` 搜索路径；
4. 用该解释器安装依赖：`python -m pip install pandas numpy matplotlib openpyxl xlrd autopep8 --target .`（全部装入本目录）；
5. 删除 `tkinter`、`test`、`__pycache__` 等非运行资产（体积瘦身，勿删功能）；
6. 将 `electron/python/giga_exec.py` 复制到本目录。

构建安装包时 electron-builder 会将其复制到安装目录 `resources/python-embed`，
应用首次使用 Python 分析时再复制到用户数据目录（离线初始化，可卸载）。
