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
"""

import json
import os
import shutil
import sys
import time

MODEL = "global.anthropic.claude-haiku-5-5"


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


def main() -> int:
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
    emit("Nothing to do.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
