#!/usr/bin/env python3
"""
Lightweight Python 3 PTY bridge for Split Workbench.
Spawns an interactive login shell in a pseudo-terminal and exchanges
newline-delimited JSON frames over stdin/stdout with the Node sidecar.
"""

import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, cols: int, rows: int) -> None:
    cols = max(10, min(500, int(cols)))
    rows = max(4, min(200, int(rows)))
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def emit(obj: dict) -> None:
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.path.expanduser("~"))
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--shell", default=os.environ.get("SHELL") or "/bin/zsh")
    args = parser.parse_args()

    cwd = args.cwd if os.path.isdir(args.cwd) else os.path.expanduser("~")
    shell = args.shell if os.path.exists(args.shell) else "/bin/sh"

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process
        try:
            os.chdir(cwd)
        except OSError:
            os.chdir(os.path.expanduser("~"))
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env.setdefault("LANG", "en_US.UTF-8")
        # Clear sidecar internal tokens from child interactive shell
        for k in (
            "ANTIGRAVITY_SIDECAR_UI_TOKEN",
            "ANTIGRAVITY_SIDECAR_WEB_PORT",
        ):
            env.pop(k, None)
        shell_name = os.path.basename(shell)
        argv = [f"-{shell_name}"] if shell_name in ("zsh", "bash", "sh") else [shell_name]
        try:
            os.execvpe(shell, argv, env)
        except OSError:
            os.execvpe("/bin/sh", ["-sh"], env)
        os._exit(127)

    # Parent process
    set_winsize(master_fd, args.cols, args.rows)

    def cleanup_child() -> None:
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    def handle_term(_signum, _frame):
        cleanup_child()
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    stdin_fd = sys.stdin.fileno()
    # Set stdin and master_fd non-blocking
    for fd in (master_fd, stdin_fd):
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    emit({"type": "ready", "pid": pid, "cwd": cwd, "shell": shell})

    stdin_buf = b""
    stdin_open = True
    exit_code = 0

    try:
        while True:
            read_fds = [master_fd]
            if stdin_open:
                read_fds.append(stdin_fd)
            try:
                rlist, _, _ = select.select(read_fds, [], [], 0.25)
            except (InterruptedError, OSError):
                break

            if master_fd in rlist:
                try:
                    chunk = os.read(master_fd, 16384)
                except OSError as e:
                    if e.errno in (errno.EIO, errno.EBADF):
                        chunk = b""
                    elif e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        chunk = None
                    else:
                        chunk = b""
                if chunk == b"":
                    break
                if chunk:
                    emit({
                        "type": "data",
                        "b64": base64.b64encode(chunk).decode("ascii"),
                    })

            if stdin_open and stdin_fd in rlist:
                try:
                    in_chunk = os.read(stdin_fd, 16384)
                except OSError as e:
                    if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        in_chunk = None
                    else:
                        in_chunk = b""
                if in_chunk == b"":
                    stdin_open = False
                    cleanup_child()
                    break
                if in_chunk:
                    stdin_buf += in_chunk
                    while b"\n" in stdin_buf:
                        line, stdin_buf = stdin_buf.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8"))
                        except Exception:
                            continue
                        mtype = msg.get("type")
                        if mtype == "input":
                            raw = None
                            if "b64" in msg:
                                raw = base64.b64decode(msg["b64"])
                            elif "data" in msg:
                                raw = str(msg["data"]).encode("utf-8")
                            if raw:
                                try:
                                    os.write(master_fd, raw)
                                except OSError:
                                    pass
                        elif mtype == "resize":
                            set_winsize(master_fd, msg.get("cols", 80), msg.get("rows", 24))
                        elif mtype == "kill":
                            cleanup_child()
                            return 0

            # Check if child has exited
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    if os.WIFEXITED(status):
                        exit_code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        exit_code = 128 + os.WTERMSIG(status)
                    # Drain any remaining buffered output from master_fd
                    while True:
                        try:
                            rem = os.read(master_fd, 16384)
                            if not rem:
                                break
                            emit({
                                "type": "data",
                                "b64": base64.b64encode(rem).decode("ascii"),
                            })
                        except OSError:
                            break
                    break
            except ChildProcessError:
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == 0:
                cleanup_child()
        except ChildProcessError:
            pass

    emit({"type": "exit", "code": exit_code})
    return 0


if __name__ == "__main__":
    sys.exit(main())
