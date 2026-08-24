# Common Contradictions in License Selection

When the user's stated goals conflict, surface the contradiction explicitly
rather than silently compromising. Present it as "you want X and Y, but they
pull in opposite directions -- which matters more?"

## 1. "I want reciprocity" + "I want zero adoption friction"

**The conflict:** copyleft IS friction. Even MPL's mild friction (one `deny.toml`
line) is nonzero. The question is whether the friction converts to lost users
(depends on substitutability) or is absorbed.

**Resolution question:** "Are there drop-in alternatives to your project?" If no
→ MPL friction is effectively zero. If yes → friction costs real adoption, and
you must choose which you value more.

## 2. "Not too strong copyleft" + "forks should stay open"

**The conflict:** file-level copyleft (MPL) has a new-file loophole -- forks can
add closed features alongside your open files. Only strong copyleft (GPL/AGPL)
prevents this. "Not too strong" and "forks stay open" are incompatible demands.

**Resolution question:** "Would it bother you if someone forked your app, added
features in new files, and kept those files closed? Or is it enough that your
original code stays open?" First answer → GPL. Second answer → MPL.

## 3. "I want contributions back" + "no CLA friction"

**The conflict:** a CLA is the only mechanism that preserves dual-licensing after
external contributions. Without it, the first PR makes dual-licensing impossible.
But CLAs add contributor friction.

**Resolution question:** "Is dual commercial licensing a real future possibility,
or purely hypothetical?" If hypothetical → drop CLA, accept the door closing.
If real → CLA friction is the price of keeping the option.

## 4. "I want AGPL protection" + "corporate devs should use this"

**The conflict:** many corporations blanket-ban AGPL, even for tools they just
run (not modify, not distribute). AGPL deters the exact audience.

**Resolution question:** "Is the tool something corporate devs would use AT
WORK (employer policy applies), or at home (irrelevant)?" If at-work → GPL is
the better tradeoff (running GPL binaries has no obligations). If at-home only
→ AGPL is free.

## 5. "I want to match ecosystem norms" + "I want copyleft"

**The conflict:** most ecosystems (Rust, npm, Go) are >90% MIT/Apache. Copyleft
is tolerated but non-standard. "Match norms" = permissive.

**Resolution question:** "Is blending in more important than your reciprocity
principle? Norms optimize for consumers; copyleft optimizes for maintainers.
Which role are you optimizing for?"

## 6. "Apache should be sufficient" + previously stated reciprocity values

**The conflict:** Apache provides zero reciprocity. If the user previously said
they value reciprocity, "Apache should be sufficient" contradicts that.

**Resolution:** push back directly -- "sufficient for what? You said X bothers
you, and Apache permits exactly X. Either the principle is softer than stated,
or the license doesn't match your values. Which is it?" Force the user to
resolve the ambiguity rather than leaving it vague.
