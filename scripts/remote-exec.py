#!/usr/bin/env python3
"""
远程命令执行器（一次性运维辅助工具）。

用途
    在非交互环境里通过 SSH 在远程主机上执行**单条** shell 命令，并把
    stdout / stderr / exit code 原样带回本地终端。
    存在的理由：本机没有 sshpass / plink，而 `ssh` 的密码提示无法在
    非交互管线里喂入。paramiko 可以。

输入
    位置参数  argv[1]       要执行的远程命令（单条字符串，交给远程 /bin/sh -c）
    环境变量  SSH_HOST      主机（IP 或域名）
              SSH_USER      用户名
              SSH_PASSWORD  密码   ← 只从环境读，**绝不写入磁盘**（P1 教训）
    可选      SSH_PORT      默认 22
              SSH_TIMEOUT   连接/命令超时秒数，默认 30

输出
    远程命令的 stdout → 本进程 stdout
    远程命令的 stderr → 本进程 stderr
    退出码            → 本进程退出码（远程非 0 时本进程也非 0；连接失败为 2）

副作用
    仅在被执行的**远程命令本身**。本脚本自己不写、不读任何本地文件，
    不落盘任何凭据，不改远程状态。

安全
    - host key 采用 AutoAddPolicy（首次连接不校验指纹）。对临时运维可接受，
      但它意味着无法察觉中间人。仅用于本次临时联调。
    - 密码只存在于进程环境与内存中，不打印、不落盘。
"""

import os
import sys

try:
    import paramiko
except ImportError:
    sys.stderr.write("需要 paramiko：python -m pip install paramiko\n")
    sys.exit(2)


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("用法: SSH_PASSWORD=... SSH_HOST=... SSH_USER=... \\\n")
        sys.stderr.write("      python remote-exec.py '<远程命令>'\n")
        return 2

    host = os.environ.get("SSH_HOST", "")
    user = os.environ.get("SSH_USER", "")
    password = os.environ.get("SSH_PASSWORD", "")
    port = int(os.environ.get("SSH_PORT", "22"))
    timeout = float(os.environ.get("SSH_TIMEOUT", "30"))

    missing = [k for k, v in
               (("SSH_HOST", host), ("SSH_USER", user), ("SSH_PASSWORD", password))
               if not v]
    if missing:
        sys.stderr.write("缺少环境变量: %s\n" % ", ".join(missing))
        return 2

    command = sys.argv[1]

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            hostname=host,
            port=port,
            username=user,
            password=password,
            timeout=timeout,
            banner_timeout=timeout,
            auth_timeout=timeout,
            allow_agent=False,
            look_for_keys=False,
        )
    except Exception as exc:  # noqa: BLE001 — 连接失败要原样报给使用者
        sys.stderr.write("SSH 连接失败: %s: %s\n" % (type(exc).__name__, exc))
        return 2

    try:
        # get_pty=True 让远程命令拿到 tty，sudo/交互式工具与彩色输出行为更接近手敲。
        # 代价是 stdout/stderr 会合流 —— 这些命令都是只读诊断，可接受。
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=True)
        stdin.close()

        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()

        if out:
            sys.stdout.write(out)
            if not out.endswith("\n"):
                sys.stdout.write("\n")
        if err:
            sys.stderr.write(err)
            if not err.endswith("\n"):
                sys.stderr.write("\n")

        sys.stderr.write("--- exit=%d ---\n" % code)
        return code
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
