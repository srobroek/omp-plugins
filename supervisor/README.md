# supervisor

Keep orchestrating sessions moving after dispatching background task work.

## Task supervision

`task-batch-supervisor` keeps an orchestrating session moving after it dispatches background `task` work. Each session, top-level or a subagent that spawns its own children, gets its own copy with its own state. Each copy listens only to its session's `pi.events` bus. That bus carries the session's direct children, so one child's events never reach another session.

| Signal | When | Delivery |
|---|---|---|
| `task-child-settled` | Direct children end (completed, failed, aborted). Each settle restarts a 3 s quiet timer, and everything buffered goes out as one message once settles stop. A steady trickle is released at most 20 s after the first buffered child. A child is left out when the parent already has its result: a `wait` returned it, or its native delivery finished and a turn started after it settled | Parent streaming: `aside` (next step boundary). Idle with that child's native delivery pending: `nextTurn` (rides in that delivery's turn). Idle with nothing pending: follow-up turn, because idle with work left is exactly when the parent must act |
| `task-batch-wake` | A whole batch settled, 20 s passed, native delivery not pending, no turn started since, parent idle. Busy parents are re-checked 3 times, then left alone | Follow-up turn |
| `task-child-stalled` | A running child shows no tool activity for 5 min (skipped while it retries) | Follow-up turn, once per child |
| `task-job-stale` | A child ended but its job is still listed as running 60 s later | Follow-up turn, once per child |
| Stop reminder | The top-level session tries to stop with children settled since its last `task` dispatch | One `session_stop` continuation per set of settled children; it also drops any still-buffered nudge for those children |

The directive is one fixed sentence, the same for every tracker: review each result, check for available and unblocked work, and dispatch every ready independent item now in one task call, never holding ready work back to group it with work that is still running. It names no specific tracker, since the parent already knows whether it works from an issue ledger, a tasks file, or its todo list. Because the text never changes, it doesn't disturb the prompt cache.

OMP does not fire `session_stop` in subagent sessions, so nested orchestrators get the directive, wake, stall, and stale-job signals, but no stop reminder.
