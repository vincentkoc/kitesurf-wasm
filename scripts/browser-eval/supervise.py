"""Linux-only per-trial subreaper. Never signal processes outside our descendants."""
import ctypes
import json
import os
import re
import select
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
    args = sys.argv[1:]
    control = args[:1] == ['--capture-control']
    if control:
        args = args[1:]
        os.set_blocking(0, False)
    stdout = subprocess.DEVNULL
    if args[:1] == ['--stdout-fd']:
        # Node owns and drains this dedicated pipe; fd 1 stays JSON control only.
        stdout = int(args[1])
        args = args[2:]
    controller_pid = os.getppid()
    def allow_controller_ptracer():
        # This one diagnostic target grants only its existing controller and
        # that controller's descendants; never PR_SET_PTRACER_ANY or a sysctl.
        if libc.prctl(0x59616d61, controller_pid, 0, 0, 0) != 0:  # PR_SET_PTRACER
            raise OSError(ctypes.get_errno(), 'Task-local PR_SET_PTRACER failed')
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                             stdout=stdout, start_new_session=True,
                             **({'preexec_fn': allow_controller_ptracer} if control else {}))
    print(json.dumps({"rootPid": child.pid}), flush=True)
    # Native diagnostic mode alone enables this small control channel. The child
    # is never reaped while a hold is active, even if it exits during attachment.
    hold = None
    incoming = b''
    control_open = True
    output_open = True
    def reply(message):
        nonlocal output_open
        if output_open:
            try:
                print(json.dumps(message), flush=True)
            except BrokenPipeError:
                output_open = False  # Lost observer must not release target custody.
    def controls():
        nonlocal hold, incoming, control_open
        global stopping
        if not control_open or not select.select([0], [], [], 0)[0]:
            return
        chunk = os.read(0, 4096)
        if not chunk:
            stopping = True  # Kill a live engine, but retain any unconfirmed attach PID.
            control_open = False
            return
        incoming += chunk
        if len(incoming) > 4096:
            stopping = True
            return
        while b'\n' in incoming:
            line, incoming = incoming.split(b'\n', 1)
            request = None
            try:
                request = json.loads(line)
                token = request['id']
                if not isinstance(token, str) or not re.fullmatch('[a-f0-9]{32}', token):
                    raise ValueError('Invalid capture token')
                if request['capture'] == 'release' and token == hold:
                    hold = None
                    reply({'capture': 'released', 'id': token})
                elif request['capture'] == 'hold' and not hold and not stopping:
                    with open(f'/proc/{child.pid}/stat', encoding='ascii') as source:
                        fields = source.read().rsplit(')', 1)[1].split()
                    if fields[0] == 'Z' or int(fields[1]) != os.getpid():
                        raise ValueError('Owned direct child is no longer live')
                    info = os.stat(f'/proc/{child.pid}/exe')
                    target = {
                        'pid': child.pid, 'ppid': os.getpid(), 'start': fields[19],
                        'uid': os.stat(f'/proc/{child.pid}').st_uid,
                        'exe': os.readlink(f'/proc/{child.pid}/exe'),
                        'dev': info.st_dev, 'ino': info.st_ino,
                    }
                    hold = token
                    reply({'capture': 'held', 'id': token, 'target': target})
                else:
                    raise ValueError('Capture unavailable or token mismatch')
            except (KeyError, TypeError, ValueError, OSError) as error:
                reply({'capture': 'denied', 'id': request.get('id') if isinstance(request, dict) else None,
                       'error': str(error)})
    # Do not reap while the workload runs: retain the root's identity until cleanup.
    while not stopping:
        if control:
            controls()
            if stopping:
                break  # Cancellation always overrides a capture hold.
        with open(f"/proc/{child.pid}/stat", encoding="ascii") as source:
            state = source.read().rsplit(")", 1)[1].split()[0]
        if state == "Z" and not hold:
            break
        time.sleep(0.05)
    requested = stopping
    if control and hold:
        # Cancellation overrides the hold's live-child lifetime immediately.
        # The capture deadline is not proof of debugger exit. Keep its unreaped
        # PID until the owner explicitly verifies exit and releases it. Never
        # expire custody, including after controller loss.
        try:
            os.kill(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        controls()
        if hold:
            reply({'cleanup': 'incomplete', 'reason': 'native debugger exit unconfirmed; target identity retained',
                   'captureId': hold, 'rootPid': child.pid})
        while hold:
            # Reparented descendants must stop too; defer reaping only to pin PID.
            for pid in children():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            controls()
            time.sleep(0.01)
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
