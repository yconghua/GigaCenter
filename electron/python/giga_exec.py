# GigaCenter Python 执行器：JSON over stdio 与主进程通信。
# 指令（stdin 每行一个 JSON）：{op: run|register|reset|ping}
#    run      {op:"run", code:"..."}                     执行用户代码
#    register {op:"register", name, filePath, kind, headerRow}  导入文件预读并注册 DataFrame 变量
#    reset    清空会话变量与注册表
#    ping     心跳
# 帧（stdout 每行一个 JSON）：
#    {"t":"stream","c":"out|err","text":"..."}   用户输出流式回传（print 实时可见）
#    {"t":"block",...}                            结果块（text/table/image）
#    {"t":"done","ok":true,"elapsed":ms,"status":"ok","blocks":[...]}
#    {"t":"error","status":"blocked|error|timeout","message":"..."}
# 安全边界：执行前 ast 静态拦截危险模块导入与系统调用，配合主进程的
# 进程隔离/无网络/会话目录边界/超时强杀，构成多层限制。

import sys
import json
import io
import time
import base64
import os
import ast
import traceback

# ---------- 安全静态检查 ----------

BLOCKED_MODULES = {
    "subprocess", "socket", "ctypes", "winreg", "urllib", "http", "ftplib",
    "smtplib", "requests", "multiprocessing", "webbrowser", "tkinter"
}
# 前缀匹配：os.system / os.popen / os.spawn* / subprocess.* / ctypes.* / socket.* 等
BLOCKED_CALL_PREFIXES = ("os.system", "os.popen", "os.spawn", "os.startfile", "os.kill",
                         "subprocess.", "ctypes.", "socket.")
# 可内嵌代码绕过静态检查的动态执行入口
BLOCKED_NAME_CALLS = {"eval", "exec", "compile", "__import__"}


class BlockedError(Exception):
    pass


def check_code(code):
    """AST 静态检查：拦截危险模块导入与系统调用，命中即拒绝执行。"""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise BlockedError(f"语法错误：{e}") from None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                mod = (a.name or "").split(".")[0]
                if mod in BLOCKED_MODULES:
                    raise BlockedError(f"禁止导入模块：{mod}")
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if mod in BLOCKED_MODULES:
                raise BlockedError(f"禁止导入模块：{mod}")
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute):
                parts = []
                cur = f
                while isinstance(cur, ast.Attribute):
                    parts.append(cur.attr)
                    cur = cur.value
                if isinstance(cur, ast.Name) and parts:
                    full = cur.id + "." + ".".join(reversed(parts))
                    if any(full.startswith(p) for p in BLOCKED_CALL_PREFIXES):
                        raise BlockedError(f"禁止的系统调用：{full}")
            elif isinstance(f, ast.Name) and f.id in BLOCKED_NAME_CALLS:
                raise BlockedError(f"禁止的动态执行：{f.id}")


# ---------- 输出流代理：用户 print 实时转为 stream 帧 ----------

def _emit(payload):
    sys.__stdout__.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


class _StreamProxy:
    def __init__(self, kind):
        self.kind = kind
        self.buf = ""

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line:
                _emit({"t": "stream", "c": self.kind, "text": line})

    def flush(self):
        pass


# ---------- 导入文件注册表与会话变量 ----------

_REGISTERED = {}
_GIGA_GLOBALS = {"__name__": "__main__"}


def _read_table(path, kind, header):
    import pandas as pd
    if kind in ("csv", "txt"):
        return pd.read_csv(path, header=header)
    if kind in ("xlsx", "xls"):
        return pd.read_excel(path, header=header)
    if kind == "json":
        return pd.read_json(path)
    if kind == "sqlite":
        import sqlite3
        con = sqlite3.connect(path)
        try:
            tables = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").fetchall()]
            if not tables:
                raise ValueError("SQLite 文件中没有可读表")
            return pd.read_sql(f"SELECT * FROM \"{tables[0]}\"", con)
        finally:
            con.close()
    raise ValueError(f"不支持的文件类型：{kind}")


def _load_registered():
    """注册表内未成功载入的文件补载（导入时预读失败，首次执行时重试）。"""
    for name, info in list(_REGISTERED.items()):
        if name in _GIGA_GLOBALS:
            continue
        path, kind, header = info
        try:
            _GIGA_GLOBALS[name] = _read_table(path, kind, header)
        except Exception:
            pass


_PREAMBLE = """
import io
import base64
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
_giga_blocks = []
_giga_last_table = globals().get("_giga_last_table", None)
def giga_table(df, max_rows=10000):
    import pandas as _pd
    df = _pd.DataFrame(df)
    n = min(len(df), max_rows)
    head = df.head(n)
    cols = [str(c) for c in head.columns]
    def _safe(v):
        if v is None: return None
        if isinstance(v, float) and v != v: return None
        if hasattr(v, 'item'): return _safe(v.item())
        if isinstance(v, (list, tuple)):
            return [_safe(x) for x in v]
        return v
    rows = [[_safe(v) for v in r] for r in head.values.tolist()]
    _giga_blocks.append({"kind": "table", "columns": cols, "rows": rows, "total": len(df)})
    globals()["_giga_last_table"] = df
def _giga_collect_figures():
    import matplotlib.pyplot as _plt
    for n in _plt.get_fignums():
        fig = _plt.figure(n)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=120)
        b64 = base64.b64encode(buf.getvalue()).decode('ascii')
        _giga_blocks.append({"kind": "image", "mime": "image/png", "data": b64})
        _plt.close(fig)
plt.show = lambda *a, **k: _giga_collect_figures()
"""


# ---------- 指令处理 ----------

def _handle_register(req):
    name = req.get("name")
    path = req.get("filePath")
    kind = req.get("kind", "csv")
    header = req.get("headerRow", 0)
    _REGISTERED[name] = (path, kind, header)
    try:
        df = _read_table(path, kind, header)
        _GIGA_GLOBALS[name] = df
        _emit({"t": "ack", "op": "register", "name": name, "ready": True})
    except Exception as e:
        _emit({"t": "ack", "op": "register", "name": name, "ready": False, "message": str(e)})


def _handle_run(req):
    code = req.get("code", "")
    t0 = time.time()
    try:
        check_code(code)
    except BlockedError as e:
        _emit({"t": "error", "status": "blocked", "message": str(e)})
        return
    out_proxy = _StreamProxy("out")
    err_proxy = _StreamProxy("err")
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out_proxy, err_proxy
    try:
        exec(_PREAMBLE, _GIGA_GLOBALS)
        _load_registered()
        exec(code, _GIGA_GLOBALS)
        _GIGA_GLOBALS["_giga_collect_figures"]()
        for proxy in (out_proxy, err_proxy):
            if proxy.buf:
                _emit({"t": "stream", "c": proxy.kind, "text": proxy.buf})
                proxy.buf = ""
        blocks = list(_GIGA_GLOBALS.get("_giga_blocks", []))
        _emit({"t": "done", "ok": True, "elapsed": int((time.time() - t0) * 1000),
               "status": "ok", "blocks": blocks})
    except BaseException:
        sys.stdout, sys.stderr = old_out, old_err
        # 先把用户已产生的输出（print 等）flush 回前端，避免异常时中间输出丢失
        for proxy in (out_proxy, err_proxy):
            if proxy.buf:
                _emit({"t": "stream", "c": proxy.kind, "text": proxy.buf})
                proxy.buf = ""
        # 完整 traceback 作为 err 流发出（输出区实时可见），error 帧只带简短标题
        tb = traceback.format_exc(limit=12)
        _emit({"t": "stream", "c": "err", "text": tb.rstrip()})
        _emit({"t": "error", "status": "error", "message": "执行出错（详见下方输出区）"})
    finally:
        sys.stdout, sys.stderr = old_out, old_err


def _handle_format(req):
    """autopep8 格式化：只返回格式化后的代码，不执行。"""
    try:
        import autopep8
        formatted = autopep8.fix_code(req.get("code", ""))
        _emit({"t": "format", "ok": True, "code": formatted})
    except Exception as e:
        _emit({"t": "format", "ok": False, "message": str(e)})


def _handle_export(req):
    """导出最近一次 giga_table 展示的 DataFrame：Worker 直写会话目录临时文件。"""
    df = _GIGA_GLOBALS.get("_giga_last_table")
    if df is None:
        _emit({"t": "export", "ok": False, "message": "没有可导出的表格结果（请先运行代码并用 giga_table(df) 展示）"})
        return
    kind = req.get("kind")
    target = req.get("target")
    if not target:
        _emit({"t": "export", "ok": False, "message": "缺少导出目标路径"})
        return
    try:
        if kind == "csv":
            df.to_csv(target, index=False)
        elif kind == "excel":
            df.to_excel(target, index=False)
        elif kind == "json":
            df.to_json(target, orient="records", force_ascii=False)
        elif kind == "sqlite":
            import sqlite3
            con = sqlite3.connect(target)
            try:
                df.to_sql("result", con, index=False)
            finally:
                con.close()
        else:
            _emit({"t": "export", "ok": False, "message": "不支持的导出格式：" + str(kind)})
            return
        _emit({"t": "export", "ok": True, "path": target})
    except Exception as e:
        _emit({"t": "export", "ok": False, "message": str(e)})


def _handle_reset():
    _REGISTERED.clear()
    _GIGA_GLOBALS.clear()
    _GIGA_GLOBALS["__name__"] = "__main__"
    _emit({"t": "done", "ok": True, "elapsed": 0, "status": "ok", "blocks": []})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        op = req.get("op")
        if op == "ping":
            _emit({"t": "pong"})
        elif op == "register":
            _handle_register(req)
        elif op == "run":
            _handle_run(req)
        elif op == "format":
            _handle_format(req)
        elif op == "export":
            _handle_export(req)
        elif op == "reset":
            _handle_reset()


if __name__ == "__main__":
    main()
