---
name: coexistence-branch-advisory
description: A branch switch you did not perform is another agent's work; never switch back, take an isolated checkout instead.
condition: ["\\bgit\\s+(?:switch|checkout)\\s+(?!-[bBcC]\\b|--orphan\\b|--(?:\\s|$))"]
scope: "tool:bash"
interruptMode: never
---

Switching deliberately, in a checkout only you touch, is fine -- carry on.

If you are switching because the branch moved underneath you, stop. A branch
switch you did not perform is usually two agents fighting over one checkout, and
switching back only plays branch ping-pong with the other actor.

Take your own checkout instead. Agents create a fresh isolated task checkout
(`isolated: true`); humans and parallel human checkouts stay on Worktrunk
(`wt switch --create <branch> --base <base>`). Cherry-pick your commits onto it,
stash-and-apply any uncommitted work, and continue there. Leave the contested
checkout to the other actor.
