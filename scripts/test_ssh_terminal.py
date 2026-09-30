#!/usr/bin/env python3
"""Exercise the fictional demo in a PTY with SSH-like terminal capabilities.

Requires pyte==0.8.2 in the invoking Python environment. Only fictional output
is processed, in memory. No SSH server or running worker service is needed.
"""

import argparse
import codecs
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time

import pyte


def check(binary, profile, cols, rows):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ, TERM=profile, SSH_CONNECTION="192.0.2.1 1234 192.0.2.2 22")
    for key in ("COLORTERM", "NO_COLOR", "CLICOLOR_FORCE"):
        env.pop(key, None)
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")()
    process = subprocess.Popen(
        [binary, "--demo", "--no-mouse"],
        stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
    )
    os.close(slave)

    def drain(duration=0.3):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select([master], [], [], max(0, end - time.monotonic()))
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                stream.feed(decoder.decode(data))

    def assert_screen(expected):
        text = "\n".join(screen.display)
        assert "TMATRIX" in screen.display[0], "lost header"
        assert text.count("[w] Work") == 1, "duplicated navigation"
        assert expected in text, f"missing {expected}"
        assert all(line[-1] == " " for line in screen.display), "right margin occupied"

    try:
        drain(1.4)
        assert_screen("Message")
        for key, expected in [
            (b"s", "Settings"), (b"\x1b", "Message"),
            (b"?", "Keyboard guide"), (b"\x1b", "Message"),
            (b"\r", "Send"), (b"\x0c", "Send"), (b"\x1b", "Message"),
        ]:
            os.write(master, key)
            drain()
            assert_screen(expected)
        for width, height in [(61, 20), (120, 40), (cols, rows)]:
            screen.resize(height, width)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)
            drain(0.4)
            assert_screen("Message")
        drain(1.2)
        assert_screen("Message")
        os.write(master, b"q")
        drain()
        process.wait(timeout=3)
        assert process.returncode == 0
        print(f"PASS {profile} {cols}x{rows}: refresh, navigation, compose, redraw, resize, detach")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", help="Path to the compiled tmatrix executable")
    binary = os.path.abspath(parser.parse_args().binary)
    for profile in ("xterm", "xterm-256color"):
        for size in ((160, 54), (80, 24), (41, 16)):
            check(binary, profile, *size)


if __name__ == "__main__":
    main()
