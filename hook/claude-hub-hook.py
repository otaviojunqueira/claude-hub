#!/usr/bin/env python3
"""Hook do Claude Hub.

Recebe o JSON do evento do Claude Code no stdin, guarda só o que o hub precisa
(sem o conteúdo das respostas das ferramentas) e acrescenta uma linha em
~/.claude-hub/events.jsonl.

Regras de segurança deste script:
  - nunca imprime nada no stdout (o Claude Code interpreta o stdout);
  - nunca falha: qualquer erro é engolido e o código de saída é sempre 0,
    então o hub fechado ou quebrado jamais atrapalha o seu Claude Code.
"""
import json
import os
import sys
import time

KEEP = (
    "hook_event_name", "session_id", "transcript_path", "cwd",
    "agent_id", "agent_type", "tool_name", "tool_use_id",
    "permission_mode", "model", "source", "notification_type",
    "from_model", "to_model", "is_interrupt",
)
TOOL_INPUT_KEYS = (
    "command", "file_path", "path", "pattern", "url", "query",
    "description", "prompt", "subagent_type", "skill",
)
TEXT_KEYS = (
    "prompt", "message", "last_assistant_message", "error", "reason", "title",
)


def trunc(value, limit):
    if not isinstance(value, str):
        value = str(value)
    value = value.replace("\r", " ")
    return value if len(value) <= limit else value[:limit] + "…"


def main():
    data = json.loads(sys.stdin.read())
    if not isinstance(data, dict):
        return

    out = {k: data[k] for k in KEEP if k in data}

    tool_input = data.get("tool_input")
    if isinstance(tool_input, dict):
        out["tool_input"] = {
            k: trunc(tool_input[k], 300) for k in TOOL_INPUT_KEYS if k in tool_input
        }

    for key in TEXT_KEYS:
        if key in data and data[key] is not None:
            out[key] = trunc(data[key], 500)

    out["ts"] = int(time.time() * 1000)

    hub_dir = os.environ.get("CLAUDE_HUB_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude-hub"
    )
    os.makedirs(hub_dir, exist_ok=True)
    line = json.dumps(out, ensure_ascii=False) + "\n"
    with open(os.path.join(hub_dir, "events.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(line)


try:
    main()
except Exception:
    pass
sys.exit(0)
