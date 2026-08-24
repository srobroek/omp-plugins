# Authoring steps, vars, and fields

## Step fields that survive cook

All of these reach the poured bead. Using them is the difference between a molecule you can query and
one you have to read.

| field | carries | why |
|---|---|---|
| `id` | the override key and gate-bead suffix | A contract. Kebab-case, chosen deliberately |
| `needs` | ordering | The only field `bd ready` enforces; everything else is advisory |
| `type` | `task` `bug` `feature` `epic` `chore` | **Never `epic` inside a molecule** -- pour rejects epic-to-task blocking deps. Plain tasks parent children fine |
| `condition` | whether the step exists this run | See `conditions.md` |
| `[steps.gate]` | a blocking decision | See `gates.md` |
| `labels` | classification for filtering | A 22-step molecule is unreadable without them |
| `metadata` | routing hints | The dispatcher primitive |
| `priority` | what to surface first | Gates and irreversible steps above routine ones |
| `assignee` | who owns it | Also `bd mol pour --assignee` for the root |
| `description` | what to do, and its acceptance | Read by the claiming agent |
| `notes` | **persistent** per-step information | Durable. Ephemeral chatter belongs on a wisp |

Dropped silently at cook, because they are not in the schema: `optional`, `when`, `enabled`, `estimate`,
`design`. A step carrying `optional = true` is created anyway.

## Variable substitution reaches three fields only

**`{{var}}` is substituted in `title`, `description` and `notes` -- nowhere else.** Probed:

| field | declared | after pour |
|---|---|---|
| `title` | `step for {{mod}}` | `step for widget` |
| `description` | `desc mentions {{mod}}` | `desc mentions widget` |
| `notes` | `notes mention {{mod}}` | `notes mention widget` |
| `assignee` | `agent-{{mod}}` | `agent-{{mod}}` -- **literal** |
| `labels` | `["mod:{{mod}}"]` | `["mod:{{mod}}"]` -- **literal** |
| `metadata` | `{target_module = "{{mod}}"}` | `{"target_module": "{{mod}}"}` -- **literal** |

This kills the obvious first design for a parameterised process: carrying a per-run value in `metadata`,
or building a dynamic label from a var. Both store the brace text.

Consequences:

- **Labels must be static.** For per-unit classification, pour one molecule per unit and label the root,
  or patch labels after pour.
- **Metadata must be static.** Routing hints are fine because they are constants; a per-run value is not.
- **`notes` is the only durable field that takes a variable**, which makes it the carrier for per-run
  persistent context.

## Labels

Two per optional step: a family label every optional step shares, plus a specific one.

```toml
labels = ["speckit:ext", "ext:qa"]
```

That lets you ask both "every extension step" (`bd list --label "speckit:ext"`) and "this extension's
steps" (`bd list --label "ext:qa"`) without a naming convention on titles. Verified on poured beads.

Labels are **not** locks and not gate substitutes -- gate beads plus `bd gate check` own blocking waits.

## Metadata -- check the vocabulary before inventing

`bd` documents a five-key convention:

| key | documented values |
|---|---|
| `execution_agent_type` | `explorer` `worker` `mixed` |
| `execution_suggested_model` | -- |
| `execution_reasoning_effort` | `low` `medium` `high` `xhigh` |
| `execution_mode` | `local` `delegated` `staged` |
| `execution_parallel_group` | -- |

Query with `bd list --has-metadata-key <k>` and `bd ready --metadata-field k=v`. That is the dispatcher
primitive: select ready work by route without parsing prose.

**There is no dispatcher.** The docs state these keys are advisory and that a parent or orchestrator must
consume them before spawning; the engine stores and returns the JSON verbatim.

`metadata` is the sanctioned extension point, so a private key is legitimate -- but make the deviation
deliberate. Namespace it, or document it in the package that reads it. The `bd:` and `_` prefixes are
reserved.

## Variables

| key | status |
|---|---|
| `required` | **Enforced** -- at pour only, not cook |
| `default` | **Works** -- substitutes with no `--var` passed |
| `pattern` | **Parsed and never enforced** |
| `enum` | **Parsed and never enforced** |
| `description` | Metadata |

`--var feature=BAD_SLUG_NOT_MATCHING` poured cleanly against `^[0-9]{3}-[a-z0-9-]+$`. **Validate input in
the skill**; a `pattern` documents intent and stops nothing.

Vars inherit through `extends`. There are no per-step vars and no computed vars.

`bd cook --mode=compile` (the default) keeps `{{placeholders}}` for modelling and estimation; passing any
`--var` implies `--mode=runtime` and substitutes.

## Phases -- the authoring decision

| phase | command | declare when |
|---|---|---|
| solid | `bd cook` | Never in the file -- cook is a verification step, not a phase choice |
| liquid | `bd mol pour` | Default. Work spanning sessions, where the audit trail is the point |
| vapor | `bd mol wisp` | `phase = "vapor"` at top level, for one-time work whose trace does not matter |

A `phase = "vapor"` formula still pours, with a warning
(`recommends vapor phase … Consider using: bd mol wisp`). Assert that warning.

Disposition of a finished molecule -- `promote`, `squash`, `burn` -- is steering, not authoring; see
`beads.composition.context.md`. The one authoring-relevant trap: `bd mol squash` **deletes children** by
default, so a formula whose per-step trail must survive cannot rely on squash to preserve it.

## Persistent versus ephemeral

Not this skill's subject. The carrier doctrine (bead comment vs `decision` bead vs message wisp vs
artifact), the promotion rule, and the wisp TTL classes are steering, and they apply to all beads work
rather than to formula authoring:

- `beads.orchestration-doctrine.context.md` -- wisps, links, labels, gates
- `beads.composition.context.md` -- the execution-shape table and promote/squash/burn dispositions

(The carrier doctrine itself ships in the `orchestrate` package, which is the wrong layer --
`beads` is usable without `orchestrate` but not the reverse. See `ACTIONS.md` 6b.2.)

The one formula-authoring consequence: **`notes` is durable, so ephemeral chatter does not belong in a
step's `notes`.** Put it on a wisp. `notes` is also the only durable field that accepts `{{var}}`, which
makes it the right carrier for per-run persistent context.

## Shipping

Search order, earlier shadows later:

1. resolved beads dir
2. `<checkout-root>/.beads/formulas/`
3. `~/.beads/formulas/`
4. `$GT_ROOT/.beads/formulas/`

That order is what makes package-ships / repo-overrides work. **Formulas resolve by filename stem, not by
the `formula` key inside the file** -- a file `zzz.formula.toml` declaring `formula = "renamed-inner"` is
listed as `renamed-inner` but resolves only as `zzz`.

`--search-path` is **broken** for formula names: it forces path-mode interpretation and fails. `GT_ROOT`
works. Copying files into `.beads/formulas/` is the reliable install.

There is no documented versioning or migration story; `version = 1` is accepted with no described effect.
