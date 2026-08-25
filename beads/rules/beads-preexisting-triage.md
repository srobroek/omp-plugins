---
name: beads-preexisting-triage
description: Fix simple pre-existing problems you run into; file a bug bead for complex ones.
condition: ["(?i)\\b(?:not|neither|none of (?:them|these)|isn'?t|aren'?t|wasn'?t)\\b[^\\n]{0,40}\\b(?:mine|ours|my (?:doing|change|fault|code|problem)|our (?:doing|change|fault|code|problem))\\b","(?i)\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression)\\b[^\\n]{0,60}\\b(?:not|neither)\\b[^\\n]{0,20}\\b(?:mine|ours)\\b","(?i)pre-?existing[^\\n]{0,80}\\b(?:not (?:mine|ours|my|our)|out of scope|left (?:alone|as-is|untouched)|not touching|leaving (?:it|them|those))\\b","(?i)\\b(?:out of scope|not (?:mine|ours))\\b[^\\n]{0,80}pre-?existing","(?i)\\b(?:unrelated to|not related to|no relation to|not caused by|predates?)\\b[^\\n]{0,40}\\b(?:this|my|our)\\b[^\\n]{0,20}\\b(?:change|changes|pr|work|commit|edit|branch|task)\\b","(?i)\\balready (?:broken|failing|red)\\b[^\\n]{0,60}\\b(?:before|not (?:mine|ours|caused))\\b","(?i)\\b(?:someone|somebody|something) else'?s\\b[^\\n]{0,40}\\b(?:bug|issue|problem|code|change|failure|mess)\\b","(?i)\\b(?:another|a different|the other)\\s+(?:agent|team|session|worker|plugin|package)'?s?\\b[^\\n]{0,40}\\b(?:bug|issue|problem|code|change|failure|work)\\b","(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:upstream|vendored?|third-?party)\\b[^\\n]{0,30}\\b(?:bug|issue|problem|failure|breakage)\\b","(?i)\\b(?:did ?n[o']?t|have ?n[o']?t|never)\\s+(?:introduce|cause|touch|modify|break)\\b","(?i)\\bnot (?:introduced|caused|triggered) by\\b","(?i)\\b(?:fails?|failing|broken|red)\\b[^\\n]{0,30}\\bon (?:main|master|trunk)\\b[^\\n]{0,20}\\b(?:too|already|as well|before)\\b","(?i)\\b(?:was|were)\\s+already\\s+(?:there|failing|broken|like that)\\b","(?i)\\bleft ?over (?:from|by)\\b|\\bleftovers? from\\b","(?i)\\b(?:outside|beyond|out ?of|not in)\\s+(?:(?:the|my|our|its|their|this)\\s+)?scope\\b|\\borthogonal to\\b[^\\n]{0,40}\\b(?:this|my|our)\\b","(?i)\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression)\\b[^\\n]{0,70}\\b(?:follow-?up|separate (?:pr|change|commit|branch)|another time|out of band|handled separately|deal with (?:it|that) later|wo ?n[o']?t fix|not going to fix|leave (?:it|that|them) (?:to|for|alone))\\b","(?i)\\bnot my (?:concern|remit|problem|job|responsibility|call)\\b|\\bout of my hands\\b","(?i)\\b(?:no ?one|nobody) (?:owns|owned)\\b|\\bunowned\\b[^\\n]{0,30}\\b(?:bug|issue|failure|code)\\b","(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:harness|environment(?:al)?|settings|infra(?:structure)?|ci)\\b[^\\n]{0,30}\\b(?:noise|flake|flaky|glitch)\\b","(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:noise|flaky|flake|cosmetic|not actionable|nothing actionable)\\b[^\\n]{0,50}\\b(?:ignore|ignoring|moving on|no action|skip(?:ping)?)\\b"]
scope: "text"
interruptMode: never
---
You just disclaimed a problem you ran into. Whose fault it is does not decide what
happens to it, and neither does how hard it looks. What decides is whether the fix
lands inside the work you are already doing.

**Already in your scope** -- you already edit that file, and the fix is small: fix it
now and say you did. It arrives in a diff a reviewer already reads.

**Outside your scope** -- any other file, however small the fix: record it, do not fix
it. A one-character change in another territory is still another diff, and it arrives
with:

- no bead,
- no acceptance criteria,
- no reviewer expecting it.

Under isolation the scope gate blocks that write, so "it was easy" is not a reason. It
is a failed tool call.

NOT judging this by difficulty. You judge it worst: you sit mid-task and want to move
on. A one-token fix routinely carries consequences nobody measured.

Recording it:

- Where the repository has beads (a `.beads/` directory exists): file a bug bead as
  you hit it, with what you observed and where. Leave it unassigned. Do not block
  your own bead on it -- the problem is incidental, so blocking stalls unrelated
  work.
- Under an orchestrated run, that bead needs a routing envelope or no queue can see
  it. Follow the run's own steering for parenting and routing labels.
- Where the repository has no beads: say so in your summary, naming the file and the
  symptom, so it survives this session.

What is not acceptable is a third option: naming a problem, disclaiming it, and
leaving no trace. If you already fixed it or already filed it, carry on.
