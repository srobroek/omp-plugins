---
name: beads-preexisting-triage
description: Record incidental pre-existing problems without expanding the current task.
condition: ["(?i)\\b(?:not|neither|none of (?:them|these)|isn'?t|aren'?t|wasn'?t)\\b[^\\n]{0,40}\\b(?:mine|ours|my (?:doing|change|fault|code|problem)|our (?:doing|change|fault|code|problem))\\b", "(?i)\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression)\\b[^\\n]{0,60}\\b(?:not|neither)\\b[^\\n]{0,20}\\b(?:mine|ours)\\b", "(?i)pre-?existing[^\\n]{0,80}\\b(?:not (?:mine|ours|my|our)|out of scope|left (?:alone|as-is|untouched)|not touching|leaving (?:it|them|those))\\b", "(?i)\\b(?:out of scope|not (?:mine|ours))\\b[^\\n]{0,80}pre-?existing", "(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised|recorded|tracked)\\b[^\\n]{0,60})(?:\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression|problem|problems|defect|defects|flake|crash|crashes)\\b[^\\n]{0,60}(?<![\"'\\x60])\\b(?:unrelated to|not related to|no relation to|not caused by|predates?)\\b[^\\n]{0,40}\\b(?:this|my|our)\\b[^\\n]{0,20}\\b(?:change|changes|pr|work|commit|edit|branch|task)\\b|(?<![\"'\\x60])\\b(?:unrelated to|not related to|no relation to|not caused by|predates?)\\b[^\\n]{0,40}\\b(?:this|my|our)\\b[^\\n]{0,20}\\b(?:change|changes|pr|work|commit|edit|branch|task)\\b[^\\n]{0,60}\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression|problem|problems|defect|defects|flake|crash|crashes)\\b)", "(?i)\\balready (?:broken|failing|red)\\b[^\\n]{0,60}\\b(?:before|not (?:mine|ours|caused))\\b", "(?i)\\b(?:someone|somebody|something) else'?s\\b[^\\n]{0,40}\\b(?:bug|issue|problem|code|change|failure|mess)\\b", "(?i)\\b(?:another|a different|the other)\\s+(?:agent|team|session|worker|plugin|package)'?s?\\b[^\\n]{0,40}\\b(?:bug|issue|problem|code|change|failure|work)\\b", "(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:upstream|vendored?|third-?party)\\b[^\\n]{0,30}\\b(?:bug|issue|problem|failure|breakage)\\b", "(?i)\\b(?:did ?n[o']?t|have ?n[o']?t|never)\\s+(?:introduce|cause|touch|modify|break)\\b", "(?i)\\bnot (?:introduced|caused|triggered) by\\b", "(?i)\\b(?:fails?|failing|broken|red)\\b[^\\n]{0,30}\\bon (?:main|master|trunk)\\b[^\\n]{0,20}\\b(?:too|already|as well|before)\\b", "(?i)\\b(?:was|were)\\s+already\\s+(?:there|failing|broken|like that)\\b", "(?i)\\bleft ?over (?:from|by)\\b|\\bleftovers? from\\b", "(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised|recorded|tracked)\\b[^\\n]{0,60})(?:\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression|problem|problems|defect|defects|flake|crash|crashes)\\b[^\\n]{0,60}(?:(?<![\"'\\x60])\\b(?:outside|beyond|out ?of|not in)\\s+(?:(?:the|my|our|its|their|this)\\s+)?scope\\b|(?<![\"'\\x60])\\borthogonal to\\b[^\\n]{0,40}\\b(?:this|my|our)\\b)|(?:(?<![\"'\\x60])\\b(?:outside|beyond|out ?of|not in)\\s+(?:(?:the|my|our|its|their|this)\\s+)?scope\\b|(?<![\"'\\x60])\\borthogonal to\\b[^\\n]{0,40}\\b(?:this|my|our)\\b)[^\\n]{0,60}\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression|problem|problems|defect|defects|flake|crash|crashes)\\b)", "(?i)\\b(?:failure|failures|error|errors|test|tests|issue|issues|bug|bugs|warning|warnings|lint|breakage|regression)\\b[^\\n]{0,70}\\b(?:follow-?up|separate (?:pr|change|commit|branch)|another time|out of band|handled separately|deal with (?:it|that) later|wo ?n[o']?t fix|not going to fix|leave (?:it|that|them) (?:to|for|alone))\\b", "(?i)\\bnot my (?:concern|remit|problem|job|responsibility|call)\\b|\\bout of my hands\\b", "(?i)\\b(?:no ?one|nobody) (?:owns|owned)\\b|\\bunowned\\b[^\\n]{0,30}\\b(?:bug|issue|failure|code)\\b", "(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:harness|environment(?:al)?|settings|infra(?:structure)?|ci)\\b[^\\n]{0,30}\\b(?:noise|flake|flaky|glitch)\\b", "(?i)(?<!\\b(?:fix|fixes|fixed|fixing|file|filed|filing|opened|raised)\\b[^\\n]{0,60})\\b(?:noise|flaky|flake|cosmetic|not actionable|nothing actionable)\\b[^\\n]{0,50}\\b(?:ignore|ignoring|moving on|no action|skip(?:ping)?)\\b"]
scope: "text"
interruptMode: never
---
You just disclaimed a problem you encountered. Decide whether the current request
requires the repair before editing it.

Keep the repair in the current task only when the current change caused the problem
or the requested result requires the repair. Update affected tests and prose when
their contract changed.

Location and size do not add work to the task. A second problem remains incidental
when it is in the same file, needs a small diff, or appears during a broad check.

Leave incidental artifacts untouched. Record the problem separately instead of
absorbing cleanup, refactoring, stale prose, formatting, or unrelated failures into
the current diff.

Before editing, ask whether omitting the repair would make the requested result
incorrect or unverified. If not, record it and continue the current task.

Recording it:

- Where the repository has Beads, run `bd info --json` and read
  `config.issue_prefix`. The maintenance root ID is `"<prefix>-maintenance"`.
- If that ID is absent, run:
  `bd create "Maintenance intake" --id "<prefix>-maintenance" --force --type epic --labels maintenance-intake --description "Standing queue for incidental work. Keep this epic open and release it after each bounded drain." --json`
  A concurrent creator may win. In every case, re-read the root and continue only
  when it is an open, parentless epic labeled `maintenance-intake`. Stop if it has
  any other shape.
- File the incidental issue with:
  `bd create "<symptom> in <path>" --type task --parent "<prefix>-maintenance" --deps "discovered-from:<source-id>" --metadata '{"tier":"basic"}' --description "<observation and location>" --acceptance "<observable result and check>" --json`
  Leave it unassigned. Do not block the source bead on incidental work.
- Keep work required by the current epic under that epic instead. The maintenance
  root is only for unrelated work.
- Where the repository has no Beads, name the file and symptom in your summary so
  the finding survives this session.

What is not acceptable is a third option: naming a problem, disclaiming it, and
leaving no trace. If you already fixed it or already filed it, carry on.
