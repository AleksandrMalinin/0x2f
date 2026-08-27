#!/usr/bin/env python3
"""PTY relay for the 0x2F TUI dogfood tests.

Spawns a command on a REAL pseudo-terminal (a controlling terminal, real
raw-mode input, real SIGWINCH on resize) and relays it to a Node test over
pipes, so the TUI is driven through exactly the bytes a user's terminal
would exchange with it — never through mocked streams.

Channel map (Node `spawn` stdio):

  fd 0  stdin   -> pty master   (keystrokes, pastes, control bytes)
  fd 1  stdout  <- pty master   (the TUI's full ANSI output)
  fd 2  stderr  passthrough     (diagnostics; the TUI rarely writes here)
  fd 3  ctrl-in  Node -> relay  one control line at a time:
                                    RESIZE <rows> <cols>
                                    SIGTERM | SIGINT | SIGHUP | KILL
  fd 4  ctrl-out relay -> Node  JSON lines: {"pid": <pid>} at start,
                                    {"exit": <code>, "signal": <signum>} at end

Exit status: the child's exit code when it exited normally, 1 otherwise.
"""

import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios

CTRL_IN_FD = 3
CTRL_OUT_FD = 4

# Initial terminal size, before the child even execs, so the TUI's very
# first frame is drawn at a known size (no 0x0 winsize race).
INITIAL_ROWS = int(os.environ.get("PTY_ROWS", "36"))
INITIAL_COLS = int(os.environ.get("PTY_COLS", "120"))


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def report(obj):
    try:
        os.write(CTRL_OUT_FD, (json.dumps(obj) + "\n").encode())
    except OSError:
        pass


def main():
    command = sys.argv[1:]
    if not command:
        sys.stderr.write("pty-relay: missing command\n")
        return 2

    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    master, slave = os.openpty()
    set_winsize(master, INITIAL_ROWS, INITIAL_COLS)

    pid = os.fork()
    if pid == 0:
        # Child: make the pty slave our controlling terminal, wire stdio,
        # and exec the command. This is exactly what a real terminal does.
        try:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.close(master)
            os.execvp(command[0], command)
        except Exception as error:  # noqa: BLE001 - report, don't traceback
            os.write(2, ("pty-relay: exec failed: %s\n" % error).encode())
            os._exit(127)
    os.close(slave)

    report({"pid": pid})

    # Control-in reader: lines of up to 128 bytes on fd 3.
    ctrl_buf = b""

    exit_code = 1
    try:
        while True:
            readable, _, _ = select.select([0, master, CTRL_IN_FD], [], [], 0.2)
            if CTRL_IN_FD in readable:
                chunk = os.read(CTRL_IN_FD, 256)
                if not chunk:
                    break  # control channel closed - test is done with us
                ctrl_buf += chunk
                while b"\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                    parts = line.decode("utf-8", "replace").split()
                    if not parts:
                        continue
                    if parts[0] == "RESIZE" and len(parts) >= 3:
                        try:
                            set_winsize(master, int(parts[1]), int(parts[2]))
                        except (ValueError, OSError):
                            pass
                        # The kernel sends SIGWINCH to the pty's foreground
                        # process group automatically; a belt-and-braces
                        # direct signal covers the case where the child is
                        # not yet the foreground pgrp.
                        try:
                            os.kill(pid, signal.SIGWINCH)
                        except OSError:
                            pass
                    elif parts[0] in ("SIGTERM", "SIGINT", "SIGHUP", "KILL"):
                        signum = getattr(signal, parts[0], signal.SIGTERM)
                        try:
                            os.kill(pid, signum)
                        except OSError:
                            pass
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break  # EIO - the child's side of the pty is gone
                if not data:
                    break
                os.write(1, data)
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    break
                os.write(master, data)

        # Child went away: reap it and report how it ended.
        try:
            waited, status = os.waitpid(pid, 0)
        except ChildProcessError:
            waited, status = pid, 0
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
            report({"exit": exit_code, "signal": None})
        else:
            exit_code = 1
            report({"exit": None, "signal": os.WTERMSIG(status)})
    except KeyboardInterrupt:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
