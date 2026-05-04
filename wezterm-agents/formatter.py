#!/usr/bin/env python3
"""
Formats pi JSON-mode event stream into human-readable terminal output.
Usage: formatter.py <output_file> <agent_name> <model> <task_preview>

Catppuccin Mocha colours via 24-bit ANSI (WezTerm supports truecolor).
"""

import json
import os
import sys
import time

# ── Catppuccin Mocha palette ───────────────────────────────────────────────
def fg(r, g, b): return f"\033[38;2;{r};{g};{b}m"
def bg(r, g, b): return f"\033[48;2;{r};{g};{b}m"

RESET    = "\033[0m"
BOLD     = "\033[1m"
DIM      = "\033[2m"
PEACH    = fg(250, 179, 135)   # tool names
SUBTEXT  = fg(166, 173, 200)   # tool args / dim info
OVERLAY  = fg(108, 112, 134)   # separators, usage
GREEN    = fg(166, 227, 161)   # done
RED      = fg(243, 139, 168)   # error
BLUE     = fg(137, 180, 250)   # headers
TEXT     = fg(205, 214, 244)   # body text

SEP      = OVERLAY + "─" * 72 + RESET
HEAVY    = OVERLAY + "━" * 72 + RESET

# ── Argument parsing ───────────────────────────────────────────────────────
output_file  = sys.argv[1] if len(sys.argv) > 1 else "/dev/stdin"
agent_name   = sys.argv[2] if len(sys.argv) > 2 else "agent"
model_id     = sys.argv[3] if len(sys.argv) > 3 else ""
task_preview = sys.argv[4] if len(sys.argv) > 4 else ""

# ── Header ─────────────────────────────────────────────────────────────────
print(HEAVY)
header = f"🤖  {BOLD}{BLUE}{agent_name}{RESET}"
if model_id:
    header += f"  {OVERLAY}·{RESET}  {SUBTEXT}{model_id}{RESET}"
print(header)
if task_preview:
    # Wrap at 68 chars
    words = task_preview.split()
    line, lines = "", []
    for w in words:
        if len(line) + len(w) + 1 > 68:
            lines.append(line)
            line = w
        else:
            line = (line + " " + w).strip()
    if line:
        lines.append(line)
    for l in lines:
        print(f"    {SUBTEXT}{l}{RESET}")
print(HEAVY)
print()
sys.stdout.flush()

# ── Tool call formatter ────────────────────────────────────────────────────
def shorten(s, n=60):
    s = s.replace("\n", "↵ ")
    return s if len(s) <= n else s[:n-1] + "…"

def format_tool(name, args):
    col = PEACH + BOLD + f"{name:<8}" + RESET
    if name == "bash":
        cmd = args.get("command", "…")
        detail = SUBTEXT + shorten(cmd) + RESET
    elif name in ("read", "write", "edit"):
        p = args.get("path", args.get("file_path", "…"))
        detail = SUBTEXT + shorten(p) + RESET
        if name == "read":
            off = args.get("offset")
            lim = args.get("limit")
            if off or lim:
                start = off or 1
                end   = (start + lim - 1) if lim else "…"
                detail += OVERLAY + f"  :{start}–{end}" + RESET
    elif name in ("grep", "find"):
        pat  = args.get("pattern", "…")
        path = args.get("path", ".")
        detail = SUBTEXT + shorten(f"/{pat}/  {path}") + RESET
    elif name == "ls":
        detail = SUBTEXT + shorten(args.get("path", ".")) + RESET
    else:
        s = "  ".join(f"{k}={json.dumps(v)}" for k, v in list(args.items())[:3])
        detail = SUBTEXT + shorten(s) + RESET
    return f"  {OVERLAY}→{RESET}  {col}  {detail}"

# ── Main event loop ────────────────────────────────────────────────────────
start_time     = time.time()
in_text        = False   # currently streaming assistant text
last_provider  = ""
last_model     = ""
total_input    = 0
total_output   = 0
empty_reads    = 0
MAX_EMPTY      = 60      # give up after ~30 s of no data

# Wait for the output file to appear
while not os.path.exists(output_file):
    time.sleep(0.15)

with open(output_file, "r", encoding="utf-8", errors="replace") as f:
    while True:
        line = f.readline()
        if not line:
            empty_reads += 1
            if empty_reads > MAX_EMPTY:
                # File hasn't grown in a while — assume crash
                if in_text:
                    print(RESET)
                print()
                print(SEP)
                print(f"  {RED}✗  timed out waiting for agent{RESET}")
                print(SEP)
                sys.stdout.flush()
                break
            time.sleep(0.5)
            continue
        empty_reads = 0

        line = line.strip()
        if not line:
            continue

        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        t = ev.get("type", "")

        # ── Tool execution start ───────────────────────────────────────────
        if t == "tool_execution_start":
            if in_text:
                print(RESET)            # end streaming text line
                print()
                in_text = False
            name = ev.get("toolName", "?")
            args = ev.get("args", {})
            print(format_tool(name, args))
            sys.stdout.flush()

        # ── Streaming assistant text ───────────────────────────────────────
        elif t == "message_update":
            ae = ev.get("assistantMessageEvent", {})
            if ae.get("type") == "text_delta":
                delta = ae.get("delta", "")
                if delta:
                    if not in_text:
                        print()         # blank line before first text
                        in_text = True
                    print(TEXT + delta + RESET, end="", flush=True)

        # ── Assistant message done ─────────────────────────────────────────
        elif t == "message_end":
            msg = ev.get("message", {})
            if msg.get("role") == "assistant":
                if in_text:
                    print(RESET)
                    in_text = False
                usage = msg.get("usage") or {}
                total_input  += usage.get("input", 0)
                total_output += usage.get("output", 0)
                provider = msg.get("provider", "")
                model    = msg.get("model", "")
                if provider: last_provider = provider
                if model:    last_model    = model

        # ── Completion markers ─────────────────────────────────────────────
        elif t in ("agent_end", "wezterm_agent_done"):
            elapsed = time.time() - start_time
            exit_code = ev.get("exitCode", 0) if t == "wezterm_agent_done" else 0
            is_err    = exit_code != 0

            if in_text:
                print(RESET)
                in_text = False
            print()
            print(SEP)

            icon   = RED + "✗" if is_err else GREEN + "✓"
            label  = "error" if is_err else "done"
            parts  = [f"{icon}  {label}{RESET}"]
            if total_input or total_output:
                parts.append(f"{OVERLAY}↑{total_input} ↓{total_output}{RESET}")
            if elapsed >= 1:
                parts.append(f"{OVERLAY}{elapsed:.1f}s{RESET}")

            print("  " + f"  {OVERLAY}·{RESET}  ".join(parts))
            print(SEP)
            sys.stdout.flush()
            break

sys.stdout.flush()
