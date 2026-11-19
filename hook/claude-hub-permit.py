#!/usr/bin/env python3
"""Hook de permissão do Claude Hub (só age com o Modo celular ligado).

Quando um agente pede permissão e o Modo celular está ligado, este script publica o
pedido para o hub e espera, por alguns segundos, a resposta do celular (aprovar ou negar).

Segurança e comportamento:
  - Modo celular desligado, vencido ou hub fechado: sai na hora, sem imprimir nada.
    O Claude Code então mostra o diálogo normal de permissão, como sempre.
  - Sem resposta dentro do prazo: sai sem imprimir nada, e o diálogo normal aparece.
  - Só imprime uma decisão quando o celular pareado respondeu.
  - Qualquer erro é engolido e o código de saída é sempre 0.
"""
import json
import os
import sys
import time
import uuid

TOOL_INPUT_KEYS = (
    "command", "file_path", "path", "pattern", "url", "query",
    "description", "prompt", "subagent_type", "skill",
)


def trunc(value, limit):
    if not isinstance(value, str):
        value = str(value)
    value = value.replace("\r", " ")
    return value if len(value) <= limit else value[:limit] + "…"


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def phone_config(hub_dir):
    try:
        with open(os.path.join(hub_dir, "phone.json"), "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return None
    if not isinstance(cfg, dict) or not cfg.get("active"):
        return None
    if int(cfg.get("until", 0)) < int(time.time() * 1000):
        return None
    if not cfg.get("paired"):
        return None  # sem celular pareado, ninguém pode responder: não segura o diálogo
    if not pid_alive(cfg.get("pid", 0)):
        return None
    return cfg


def main():
    data = json.loads(sys.stdin.read())
    if not isinstance(data, dict):
        return
    hub_dir = os.environ.get("CLAUDE_HUB_DIR") or os.path.join(os.path.expanduser("~"), ".claude-hub")
    cfg = phone_config(hub_dir)
    if not cfg:
        return

    wait = max(5, min(int(cfg.get("waitSeconds", 45)), 300))
    permits = os.path.join(hub_dir, "permits")
    os.makedirs(permits, exist_ok=True)
    pid = uuid.uuid4().hex
    req = os.path.join(permits, pid + ".json")
    dec = os.path.join(permits, pid + ".decision")

    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    payload = {
        "id": pid,
        "ts": int(time.time() * 1000),
        "waitSeconds": wait,
        "session_id": data.get("session_id"),
        "agent_id": data.get("agent_id"),
        "agent_type": data.get("agent_type"),
        "cwd": data.get("cwd"),
        "tool_name": data.get("tool_name"),
        "tool_input": {k: trunc(tool_input[k], 600) for k in TOOL_INPUT_KEYS if k in tool_input},
    }
    tmp = req + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, req)

    answer = None
    try:
        deadline = time.time() + wait
        while time.time() < deadline:
            if os.path.exists(dec):
                try:
                    with open(dec, "r", encoding="utf-8") as fh:
                        answer = json.load(fh)
                except Exception:
                    answer = None
                break
            if phone_config(hub_dir) is None:
                break  # modo celular acabou: libera o diálogo normal
            time.sleep(0.25)
    finally:
        for f in (req, dec, tmp):
            try:
                os.remove(f)
            except Exception:
                pass

    if isinstance(answer, dict) and answer.get("behavior") in ("allow", "deny"):
        decision = {"behavior": answer["behavior"]}
        if answer["behavior"] == "deny":
            decision["message"] = "Negado pelo celular (Claude Hub)."
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}
        }))


try:
    main()
except Exception:
    pass
sys.exit(0)
