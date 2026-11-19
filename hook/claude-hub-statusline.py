#!/usr/bin/env python3
"""Tap de statusline do Claude Hub: captura o uso do plano (5 h e semana) sem ler credenciais.

O Claude Code manda ao comando de statusline, pelo stdin, um JSON com `rate_limits`
({five_hour: {used_percentage, resets_at}, seven_day: {...}}; resets_at em segundos).
Este script fica "na frente" do statusline que você já tinha:

    python3 claude-hub-statusline.py --cmd '<comando original>'

1. lê o stdin inteiro;
2. se houver rate_limits, grava ~/.claude-hub/usage.json só com {fetchedAt, five_hour, seven_day};
3. roda o comando original com o MESMO stdin, repassa o que ele imprime e sai com o código dele.
   Sem comando original, não imprime nada.

Qualquer falha na captura é engolida: o statusline nunca quebra nem fica lento por causa do hub.
A ideia vem do Habblaud (https://github.com/marmottajr/habblaud, MIT, (c) Marcio Junior).
"""
import json
import os
import subprocess
import sys
import time


def hub_dir():
    return os.environ.get("CLAUDE_HUB_DIR") or os.path.join(os.path.expanduser("~"), ".claude-hub")


def window(w):
    if not isinstance(w, dict):
        return None
    raw = w.get("used_percentage", w.get("utilization", w.get("used_percent")))
    try:
        pct = float(raw)
    except (TypeError, ValueError):
        return None
    if pct != pct:  # NaN
        return None
    out = {"used_percentage": min(100.0, max(0.0, pct))}
    r = w.get("resets_at")
    if isinstance(r, (int, float)) and not isinstance(r, bool):
        out["resets_at"] = r
    elif isinstance(r, str) and r.strip():
        out["resets_at"] = r.strip()
    return out


def capture(data):
    rl = data.get("rate_limits") if isinstance(data, dict) else None
    if not isinstance(rl, dict):
        return
    five, week = window(rl.get("five_hour")), window(rl.get("seven_day"))
    if not five and not week:
        return
    rec = {"fetchedAt": int(time.time() * 1000)}
    if five:
        rec["five_hour"] = five
    if week:
        rec["seven_day"] = week
    d = hub_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    f = os.path.join(d, "usage.json")
    try:
        with open(f, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
        same = (prev.get("five_hour"), prev.get("seven_day")) == (rec.get("five_hour"), rec.get("seven_day"))
        if same and 0 <= rec["fetchedAt"] - int(prev.get("fetchedAt", 0)) < 10_000:
            return
    except Exception:
        pass
    tmp = "%s.%d.tmp" % (f, os.getpid())
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
    os.replace(tmp, f)


def main():
    raw = sys.stdin.buffer.read()
    try:
        capture(json.loads(raw.decode("utf-8", "replace") or "null"))
    except Exception:
        pass
    args = sys.argv[1:]
    cmd = ""
    if "--cmd" in args:
        i = args.index("--cmd")
        cmd = args[i + 1] if i + 1 < len(args) else ""
    if not cmd.strip():
        return 0
    try:
        p = subprocess.run(cmd, shell=True, input=raw)
        return p.returncode
    except Exception:
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
