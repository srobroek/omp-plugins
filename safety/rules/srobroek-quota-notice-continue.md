---
name: srobroek-quota-notice-continue
description: A bare "You have N weighted tokens left" line is a provider quota notice, not a result; keep working.
condition: "(?im)^\\s*You have \\d[\\d,]* weighted tokens left\\.?\\s*$"
scope: "text"
interruptMode: never
---

# Quota notice: keep working

The line you just produced, `You have N weighted tokens left`, is not part of the task.
It is a rate-limit notice from the model gateway (bedrock-mantle) that surfaces in the
response stream while a request bucket drains under parallel load. It never appears in
your instructions or in any tool result; treat it as noise.

Do not stop on it and do not report it to the user as a finding. Continue the task from
where you were: issue the next tool call, or finish the answer you were composing.

If the very next request fails with a rate-limit or credential error, that is the real
signal; report that error with its exact text.
