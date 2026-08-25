---
name: delivery-landing-proof
description: Prove work landed from the PR record (state, headRefOid, mergeCommit), never from ancestry or path history.
condition: ["\\bgh\\s+pr\\s+merge\\b", "\\bgit\\s+merge(?![-\\w])"]
scope: "tool:bash"
interruptMode: never
---
Running the merge is not proof that the reviewed work landed. Prove it from the
PR record:

```
gh pr view <n> --json state,baseRefName,headRefOid,mergeCommit
```

`MERGED` proves that the recorded `headRefOid` reached `baseRefName`. Compare the
branch tip with `headRefOid`: anything after it is still unlanded. A merge into
an intermediate branch needs its own proof that the intermediate reached the
final destination.

Without a PR, `git cherry` or a stable patch id can prove one commit has an
equivalent patch downstream. Neither proves equivalence for a multi-commit
squash. Accept by inspecting the recorded merge commit, or the exact expected
hunks.

NOT ancestry, merge-tree output, path existence, or non-empty path history as
sole landing proof. Path history only names the commits worth inspecting.

Full policy including branching and beads linkage: `rule://delivery-git-workflow`.
