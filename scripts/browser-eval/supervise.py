"""Linux-only per-trial subreaper. Never signal processes outside our descendants."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import time

stopping = False


def stop(_signal, _frame):
    global stopping
    stopping = True


def children():
    with open(f"/proc/self/task/{os.getpid()}/children", encoding="ascii") as source:
        return [int(pid) for pid in source.read().split()]


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return False
        except ChildProcessError:
            return True  # ECHILD: no live or zombie descendants remain.


def main():
    # Adopt double-forked/setsid descendants instead of leaving them with PID 1.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, start_new_session=True)
    print(json.dumps({"rootPid": child.pid}), flush=True)
    # Do not reap while the workload runs: retain the root's identity until cleanup.
    while not stopping:
        with open(f"/proc/{child.pid}/stat", encoding="ascii") as source:
            state = source.read().rsplit(")", 1)[1].split()[0]
        if state == "Z":
            break
        time.sleep(0.05)
    requested = stopping
    deadline = time.monotonic() + 5
    while True:
        # Kill only direct children, without PID-reuse races: they remain ours until
        # waitpid reaps them. Reparented descendants are picked up on the next turn.
        for pid in children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if reap():
            print(json.dumps({"cleanup": "empty", "verification": "waitpid ECHILD"}), flush=True)
            return 0 if requested else 1
        if time.monotonic() >= deadline:
            print(json.dumps({"cleanup": "failed", "remaining": children()}), flush=True)
            return 2
        time.sleep(0.01)


if __name__ == "__main__":
    sys.exit(main())
