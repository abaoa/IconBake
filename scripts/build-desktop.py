#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建桌面端发布版（Tauri release 可执行文件）。

用法：
    python scripts/build-desktop.py            # 先构建前端，再编译 exe
    python scripts/build-desktop.py --skip-web # 只编译 exe（前端产物已是最新时）

为什么要用这个脚本编译：
    Rust 会把源码文件的绝对路径以字符串形式编进二进制（panic 位置、`file!()` 等），
    于是 `~/.cargo/registry/src/<mirror>/<crate>/src/*.rs` 这类路径会带上构建机的
    用户名和目录结构，出现在最终分发的 exe 里。
    本脚本在调用 cargo 时注入 `--remap-path-prefix`，把这些路径统一替换为与机器
    无关的占位路径（/build/...），既消除隐私泄露，也让不同机器编译出的产物更接近。
    路径全部在运行时从环境推导，脚本本身不含任何本机绝对路径。

编译完成后会自检：在产物里搜索本机家目录/项目根，若有命中则以非 0 退出。
"""

import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TAURI_DIR = ROOT / "src-tauri"
HOME = pathlib.Path.home()

PLACEHOLDER_HOME = "/build/.cargo-home"
PLACEHOLDER_PROJECT = "/build/src"


def variants(p: pathlib.Path):
    """返回同一个路径的两种分隔符写法（rustc 的 remap 按字面前缀匹配）。

    顺序固定为「平台原生写法在前、正斜杠写法在后」，这样不同机器、不同次编译
    生成的命令行完全一致，产物可复现。
    """
    s = str(p)
    alt = s.replace("\\", "/")
    return [s] if alt == s else [s, alt]


def main() -> int:
    args = set(sys.argv[1:])

    if "--skip-web" not in args:
        print("==> 构建前端 (vite build)")
        npm = "npm.cmd" if os.name == "nt" else "npm"
        subprocess.run([npm, "run", "build"], cwd=ROOT, check=True)

    flags = []
    for v in variants(HOME):
        flags.append("--remap-path-prefix=%s=%s" % (v, PLACEHOLDER_HOME))
    for v in variants(ROOT):
        flags.append("--remap-path-prefix=%s=%s" % (v, PLACEHOLDER_PROJECT))

    env = dict(os.environ)
    env["RUSTFLAGS"] = " ".join(flags)

    cargo = os.environ.get("CARGO") or "cargo"
    print("==> 编译 release 可执行文件 (cargo build --release)")
    subprocess.run([cargo, "build", "--release"], cwd=TAURI_DIR, env=env, check=True)

    exe = TAURI_DIR / "target" / "release" / "iconbake.exe"
    if not exe.exists():
        exe = TAURI_DIR / "target" / "release" / "iconbake"
    if not exe.exists():
        print("x 未找到编译产物，请检查上面的输出。")
        return 1

    data = exe.read_bytes()
    print("==> 自检：%s (%d 字节)" % (exe, len(data)))
    bad = 0
    for v in variants(HOME) + variants(ROOT):
        n = len(re.findall(re.escape(v.encode()), data))
        if n:
            bad += n
            print("   x 发现本机路径残留 %d 处：%s" % (n, v))
    if bad:
        print("x 产物仍包含本机路径，请检查 remap 参数是否生效。")
        return 1
    print("   √ 未发现本机绝对路径")
    return 0


if __name__ == "__main__":
    sys.exit(main())
