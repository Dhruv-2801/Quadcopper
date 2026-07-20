#!/usr/bin/env python3
"""
send_hex.py (v2)
Sends a RARS-generated imem.hex file to the FPGA over the JTAG UART IP.

Fixes vs v1:
  - stdin is properly CLOSED after writing, which flushes the pipe and lets
    nios2-terminal drain everything to the FPGA (v1 terminated the process
    0.5 s after write; large programs could be cut off mid-stream).
  - Drain wait scales with program size instead of a fixed 0.5 s.
  - Prints per-step diagnostics and a board-side checklist.

Usage:
    python3 send_hex.py imem.hex

Board-side expectations (v2 wrapper):
  - While loading: LEDR shows the word count climbing, LEDG3 off
  - When done:     LEDG3 ON, CPU starts ~5 us later, HEX shows ALU result
  - KEY0: re-run the same program.  KEY3: wipe loader, then re-send.
"""

import subprocess
import struct
import sys
import os
import time
import shutil

END_SENTINEL = 0xDEADBEEF

# Adjust to your Quartus install, or leave as-is if it's on PATH
NIOS2_TERMINAL = "/usr/local/quartus/25.1/quartus/bin/nios2-terminal"


def find_terminal():
    if os.path.isfile(NIOS2_TERMINAL):
        return NIOS2_TERMINAL
    on_path = shutil.which("nios2-terminal")
    if on_path:
        return on_path
    print(f"Error: nios2-terminal not found at {NIOS2_TERMINAL} or on PATH.")
    print("Fix the NIOS2_TERMINAL constant at the top of this script.")
    sys.exit(1)


def read_hex_file(hex_path):
    words = []
    with open(hex_path, "r") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("//"):
                continue
            if line.lower().startswith("v2"):
                continue
            try:
                words.append(int(line, 16))
            except ValueError:
                print(f"Warning: skipping line {lineno}: {line!r}")
    return words


def send_program(hex_path):
    if not os.path.isfile(hex_path):
        print(f"Error: file not found: {hex_path}")
        sys.exit(1)

    terminal = find_terminal()

    # The JTAG UART allows ONE connection at a time. A leftover
    # nios2-terminal (or an open Quartus Programmer) causes instant
    # disconnection -> BrokenPipeError. Check before we start.
    check = subprocess.run(["pgrep", "-f", "nios2-terminal"],
                           capture_output=True, text=True)
    others = [p for p in check.stdout.split() if p and int(p) != os.getpid()]
    if others:
        print("Error: another nios2-terminal is already running "
              f"(PID {', '.join(others)}).")
        print("Close it (or run: kill " + " ".join(others) + ") and retry.")
        print("Also make sure the Quartus Programmer window is closed.")
        sys.exit(1)
    words = read_hex_file(hex_path)
    if not words:
        print("Error: no instructions found in hex file.")
        sys.exit(1)

    if END_SENTINEL in words:
        print("Error: program contains 0xDEADBEEF, which collides with the")
        print("end-of-load sentinel. Change the sentinel in both this script")
        print("and uart_loader.vhd.")
        sys.exit(1)

    # Big-endian words: loader assembles MSB first
    byte_stream = b"".join(struct.pack(">I", w) for w in words)
    byte_stream += struct.pack(">I", END_SENTINEL)

    print(f"Loaded {len(words)} instructions from {hex_path}")
    print(f"Sending {len(byte_stream)} bytes over JTAG UART...")

    proc = subprocess.Popen(
        [terminal],
        stdin=subprocess.PIPE,
        stdout=None,   # inherit terminal: show nios2-terminal's messages
        stderr=None,
    )
    try:
        time.sleep(1.5)                    # let it attach to the JTAG chain
        if proc.poll() is not None:
            print("Error: nios2-terminal exited immediately "
                  f"(code {proc.returncode}). Its message is printed above.")
            print("Usual causes: JTAG held by Programmer/another terminal, "
                  "or board not programmed.")
            sys.exit(1)
        try:
            proc.stdin.write(byte_stream)
            proc.stdin.flush()
            proc.stdin.close()             # signals EOF -> pipe fully drained
        except BrokenPipeError:
            print("Error: nios2-terminal dropped the connection mid-send.")
            print("Its own message above says why. Kill stale JTAG users "
                  "and retry.")
            sys.exit(1)
        # JTAG UART sustains at least a few KB/s; scale the wait with size
        time.sleep(max(1.0, len(byte_stream) / 2000.0))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("Done. Now check the board:")
    print(f"  1. LEDR should have counted up to {len(words)} during the send")
    print("  2. LEDG3 should now be ON (program loaded)")
    print("  3. HEX displays show the ALU result (SW16 up = hold last value)")
    print("  4. KEY0 = re-run program;  KEY3 = wipe loader, then re-send")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 send_hex.py <imem.hex>")
        print("  RARS: File -> Dump Memory -> .text, Hexadecimal Text -> imem.hex")
        sys.exit(1)
    send_program(sys.argv[1])
