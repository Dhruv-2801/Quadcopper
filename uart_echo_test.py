#!/usr/bin/env python3
"""
uart_echo_test.py
Loopback test for the JTAG UART link (pairs with the echo-test wrapper).

Sends a known pattern to the FPGA; the echo wrapper sends every byte back;
this script captures the returned bytes and verifies them. This proves the
PC -> JTAG -> FIFO -> Avalon -> FIFO -> JTAG -> PC path in BOTH directions,
with no processor involved.

Usage:
    python3 uart_echo_test.py

Board must be programmed with the ECHO wrapper build first.
While it runs, also watch the board:
    LEDG0 toggles per byte, LEDR[17:10] counts bytes,
    LEDR[7:0] shows the last byte (last char of the pattern = '9' = 0x39).
"""

import subprocess
import sys
import time
import threading
import shutil
import os

NIOS2_TERMINAL = "/usr/local/quartus/25.1/quartus/bin/nios2-terminal"
PATTERN = b"CLAUDE-ECHO-TEST-0123456789"


def find_terminal():
    if os.path.isfile(NIOS2_TERMINAL):
        return NIOS2_TERMINAL
    p = shutil.which("nios2-terminal")
    if p:
        return p
    print(f"Error: nios2-terminal not found at {NIOS2_TERMINAL} or on PATH.")
    sys.exit(1)


def main():
    terminal = find_terminal()

    # refuse to run if another nios2-terminal owns the JTAG
    chk = subprocess.run(["pgrep", "-f", "nios2-terminal"],
                         capture_output=True, text=True)
    others = [p for p in chk.stdout.split() if p]
    if others:
        print(f"Error: nios2-terminal already running (PID {', '.join(others)}).")
        print("Kill it and close the Quartus Programmer, then retry.")
        sys.exit(1)

    print(f"Sending {len(PATTERN)} bytes: {PATTERN.decode()}")

    proc = subprocess.Popen(
        [terminal],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,     # capture the echoed bytes
        stderr=subprocess.STDOUT,
    )

    received = bytearray()
    def reader():
        while True:
            chunk = proc.stdout.read(1)
            if not chunk:
                break
            received.extend(chunk)

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    try:
        time.sleep(1.5)                     # let it attach
        if proc.poll() is not None:
            print("Error: nios2-terminal exited immediately:")
            print(bytes(received).decode(errors="replace"))
            sys.exit(1)
        proc.stdin.write(PATTERN)
        proc.stdin.flush()
        time.sleep(2.0)                     # allow echo to return
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.2)

    data = bytes(received)
    print("\n--- raw capture (banner lines + echoed data) ---")
    print(data.decode(errors="replace"))
    print("------------------------------------------------")

    if PATTERN in data:
        print("PASS: full pattern echoed back. UART link verified both ways.")
        print("Next: restore the loader wrapper, recompile, send a program.")
    else:
        # partial-match diagnosis
        best = 0
        for n in range(len(PATTERN), 0, -1):
            if PATTERN[:n] in data:
                best = n
                break
        if best:
            print(f"PARTIAL: first {best}/{len(PATTERN)} bytes came back.")
            print("Link works but data is being cut off - report this number.")
        else:
            print("FAIL: nothing echoed back.")
            print("If LEDG0/LEDR moved on the board: FPGA received bytes but")
            print("  the write-back path failed (report LED states).")
            print("If LEDs did NOT move: bytes never reached the Avalon side.")


if __name__ == "__main__":
    main()
