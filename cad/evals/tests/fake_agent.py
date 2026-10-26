#!/usr/bin/env python3
"""Stand-in harness binary for runner tests. Speaks OMP's `--mode json` stream.

FAKE_AGENT_MODE selects the behaviour:
  fail        exit 1 with a non-transient stderr message
  throttle    exit 1 with a throttling message (transient)
  sleep       sleep past any test ceiling
  mismatch    answer as a different served model
  ask-then:D  first turn asks for approval; on --continue copy directory D into cwd
  copy:D      copy directory D into cwd and answer
  quiet       answer without producing files
  leak        answer with the exported AWS secret and session token, the cwd and FAKE_AGENT_ECHO
  leak-fail   write the same to stderr and exit 1
  linger      answer, leaving a child in its process group and a detached one naming the cwd;
              both PIDs are appended to FAKE_AGENT_PIDS

FAKE_AGENT_VERSION sets the `--version` answer (default: the declared OMP baseline).
"""

import json
import os
import shutil
import subprocess
import sys
import time

MODEL = "global.anthropic.claude-haiku-5-5"


def leaked() -> str:
    env = os.environ
    return (f"key={env.get('AWS_SECRET_ACCESS_KEY')} token={env.get('AWS_SESSION_TOKEN')}"
            f" cwd={os.getcwd()} echo={env.get('FAKE_AGENT_ECHO')}")


def linger() -> None:
    """One child stays in the harness's process group; the other detaches into its own
    session, as the cad-viewer host does, and only its command line names the trial."""
    sleep = [sys.executable, "-c", "import time; time.sleep(120)"]
    quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    children = [subprocess.Popen(sleep, **quiet), subprocess.Popen([*sleep, os.getcwd()], start_new_session=True, **quiet)]
    with open(os.environ["FAKE_AGENT_PIDS"], "a", encoding="utf-8") as fh:
        fh.write("".join(f"{child.pid}\n" for child in children))


def emit(text: str, model: str = MODEL) -> None:
    prompt = sys.argv[-1]
    events = [
        {"type": "session", "id": "fake-session"},
        {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}},
        {"type": "message_end", "message": {
            "role": "assistant", "model": model, "stopReason": "stop",
            "content": [{"type": "toolCall", "name": "write", "arguments": {"path": "x"}}],
            "usage": {"input": 100, "output": 10, "cacheRead": 5, "cacheWrite": 0, "cost": {"total": 0.001}},
        }},
        {"type": "message_end", "message": {"role": "toolResult", "toolName": "write", "content": [{"type": "text", "text": "ok"}]}},
        {"type": "message_end", "message": {
            "role": "assistant", "model": model, "stopReason": "stop",
            "content": [{"type": "text", "text": text}],
            "usage": {"input": 120, "output": 20, "cacheRead": 0, "cacheWrite": 0},
        }},
        {"type": "agent_end", "messages": []},
    ]
    for event in events:
        print(json.dumps(event))


def rpc_inventory() -> int:
    """Answer the OMP inventory probe (`--mode rpc`): get_state and get_available_commands.
    FAKE_AGENT_PROBE=leaky adds a user skill and a user rule, as an unisolated OMP would."""
    leaky = os.environ.get("FAKE_AGENT_PROBE") == "leaky"
    skills = "<skills>\n- cad-flow: Leads mechanical CAD.\n" + ("- user-skill: Something of the user's.\n" if leaky else "") + "</skills>"
    rules = "\n<domain-rules>\n- user-rule (): A rule of the user's.\n</domain-rules>" if leaky else ""
    print(json.dumps({"type": "ready"}))
    for line in sys.stdin:
        request = json.loads(line)
        if request["type"] == "get_state":
            data = {"systemPrompt": [skills + rules + "\n<project-context>\n<workstation>\n- OS: x\n</workstation>\n</project-context>"],
                    "dumpTools": [{"name": "task", "description": "# Available Agents\n- `scout`: bundled\n- `cad-mech-reviewer`: cad"}]}
        else:
            data = {"commands": [{"name": "skill:cad-flow", "source": "skill"}, {"name": "model", "source": "builtin"}]}
        print(json.dumps({"type": "response", "id": request["id"], "success": True, "data": data}))
    return 0


def main() -> int:
    if "--version" in sys.argv:
        print(f"omp/{os.environ.get('FAKE_AGENT_VERSION', '18.12.3')}")
        return 0
    if "rpc" in sys.argv:
        return rpc_inventory()
    mode = os.environ.get("FAKE_AGENT_MODE", "quiet")
    resumed = "--continue" in sys.argv
    if mode == "fail":
        print("fatal: invalid configuration", file=sys.stderr)
        return 1
    if mode == "throttle":
        print("ThrottlingException: Too many requests, rate limit exceeded", file=sys.stderr)
        return 1
    if mode == "sleep":
        time.sleep(60)
        return 0
    if mode == "mismatch":
        emit("Done.", model="global.anthropic.claude-sonnet-4-6")
        return 0
    if mode.startswith("ask-then:"):
        if not resumed:
            emit("The part is drafted. Shall I proceed to export the STEP?")
            return 0
        mode = "copy:" + mode.split(":", 1)[1]
    if mode.startswith("copy:"):
        shutil.copytree(mode.split(":", 1)[1], os.getcwd(), dirs_exist_ok=True)
        emit("Exported the STEP file.")
        return 0
    if mode == "leak":
        emit(leaked())
        return 0
    if mode == "leak-fail":
        print(leaked(), file=sys.stderr)
        return 1
    if mode == "linger":
        linger()
        emit("Started the viewer.")
        return 0
    emit("Nothing to do.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
