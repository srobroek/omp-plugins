# Refactoring Catalog (refactoring.guru index)

A baked index of the refactoring.guru catalog: every code smell (with its own
page URL) mapped to its recommended refactorings, plus the full catalog of
refactoring techniques grouped by intent, **each technique with its own page
URL**. Use this as the **router** in step 5.

All slugs below were verified against `refactoring.guru/sitemap.xml`. Note the
two URL shapes the site actually uses:

- **Smell pages** are nested: `https://refactoring.guru/smells/<slug>`
- **Smell category pages**: `https://refactoring.guru/refactoring/smells/<category>`
- **Technique pages** are flat: `https://refactoring.guru/<slug>`
- **Technique group pages**: `https://refactoring.guru/refactoring/techniques/<group>`

**Hybrid index + fetch:** this file is the index. When a finding needs the full
step-by-step mechanics (numbered steps, before/after), fetch the specific
technique's page URL with native `read` on the URL. Do **not** fetch on every
finding -- the index is enough to name and justify most fixes. Do not paste large
verbatim copies of the site's prose into reports; cite the URL.

Top-level index pages:
- Smells: `https://refactoring.guru/refactoring/smells`
- Techniques: `https://refactoring.guru/refactoring/techniques`
- Catalog: `https://refactoring.guru/refactoring/catalog`
- What is refactoring: `https://refactoring.guru/refactoring/what-is-refactoring`
- Technical debt: `https://refactoring.guru/refactoring/technical-debt`

---

## Code smells → recommended refactorings

23 smells across 6 categories. Each smell links to its own page; the
"recommended refactorings" name techniques from the technique reference below.

### Bloaters -- `/refactoring/smells/bloaters`
Code, methods, and classes that have grown to unmanageable size.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Long Method | `/smells/long-method` | Extract Method; Replace Temp with Query; Introduce Parameter Object; Preserve Whole Object; Replace Method with Method Object; Decompose Conditional |
| Large Class | `/smells/large-class` | Extract Class; Extract Subclass; Extract Interface; Replace Data Value with Object |
| Primitive Obsession | `/smells/primitive-obsession` | Replace Data Value with Object; Replace Type Code with Class / Subclasses / State-Strategy; Introduce Parameter Object; Replace Array with Object |
| Long Parameter List | `/smells/long-parameter-list` | Replace Parameter with Method Call; Preserve Whole Object; Introduce Parameter Object |
| Data Clumps | `/smells/data-clumps` | Extract Class; Introduce Parameter Object; Preserve Whole Object |

### Object-Orientation Abusers -- `/refactoring/smells/oo-abusers`
Incomplete or incorrect application of OO principles.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Switch Statements | `/smells/switch-statements` | Replace Conditional with Polymorphism; Replace Type Code with Subclasses / State-Strategy; Introduce Null Object |
| Temporary Field | `/smells/temporary-field` | Extract Class; Introduce Null Object |
| Refused Bequest | `/smells/refused-bequest` | Push Down Method; Push Down Field; Replace Inheritance with Delegation |
| Alternative Classes with Different Interfaces | `/smells/alternative-classes-with-different-interfaces` | Rename Method; Move Method; Extract Superclass |

### Change Preventers -- `/refactoring/smells/change-preventers`
One change forces many cascading changes elsewhere.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Divergent Change | `/smells/divergent-change` | Extract Class; Move Method; Move Field |
| Shotgun Surgery | `/smells/shotgun-surgery` | Move Method; Move Field; Inline Class |
| Parallel Inheritance Hierarchies | `/smells/parallel-inheritance-hierarchies` | Move Method; Move Field |

### Dispensables -- `/refactoring/smells/dispensables`
Pointless or unneeded code whose absence makes the code cleaner.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Comments (compensating for bad code) | `/smells/comments` | Extract Method; Rename Method; Introduce Assertion |
| Duplicate Code | `/smells/duplicate-code` | Extract Method; Pull Up Method; Pull Up Field; Form Template Method; Substitute Algorithm; Extract Superclass |
| Lazy Class | `/smells/lazy-class` | Inline Class; Collapse Hierarchy |
| Data Class | `/smells/data-class` | Move Method; Encapsulate Field; Encapsulate Collection |
| Dead Code | `/smells/dead-code` | Delete the code; Inline Class; Collapse Hierarchy |
| Speculative Generality | `/smells/speculative-generality` | Collapse Hierarchy; Inline Class; Remove Parameter; Rename Method |

### Couplers -- `/refactoring/smells/couplers`
Excessive coupling between classes.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Feature Envy | `/smells/feature-envy` | Move Method; Move Field; Extract Method |
| Inappropriate Intimacy | `/smells/inappropriate-intimacy` | Move Method; Move Field; Change Bidirectional Association to Unidirectional; Replace Inheritance with Delegation; Hide Delegate |
| Message Chains | `/smells/message-chains` | Hide Delegate; Extract Method; Move Method |
| Middle Man | `/smells/middle-man` | Remove Middle Man; Inline Method; Replace Delegation with Inheritance |

### Other -- `/refactoring/smells/other`
Smells that fit no other group.

| Smell | URL | Recommended refactorings |
|-------|-----|--------------------------|
| Incomplete Library Class | `/smells/incomplete-library-class` | Introduce Foreign Method; Introduce Local Extension |

---

## Refactoring techniques (full catalog, by intent)

66 techniques across 6 groups. Each row is its own page (flat URL -- prepend
`https://refactoring.guru`). Fetch the specific page for the numbered mechanics.

### Composing Methods -- `/refactoring/techniques/composing-methods`
Streamline methods, remove code duplication.

| Technique | URL |
|-----------|-----|
| Extract Method | `/extract-method` |
| Inline Method | `/inline-method` |
| Extract Variable | `/extract-variable` |
| Inline Temp | `/inline-temp` |
| Replace Temp with Query | `/replace-temp-with-query` |
| Split Temporary Variable | `/split-temporary-variable` |
| Remove Assignments to Parameters | `/remove-assignments-to-parameters` |
| Replace Method with Method Object | `/replace-method-with-method-object` |
| Substitute Algorithm | `/substitute-algorithm` |

### Moving Features Between Objects -- `/refactoring/techniques/moving-features-between-objects`
Move responsibilities between classes safely.

| Technique | URL |
|-----------|-----|
| Move Method | `/move-method` |
| Move Field | `/move-field` |
| Extract Class | `/extract-class` |
| Inline Class | `/inline-class` |
| Hide Delegate | `/hide-delegate` |
| Remove Middle Man | `/remove-middle-man` |
| Introduce Foreign Method | `/introduce-foreign-method` |
| Introduce Local Extension | `/introduce-local-extension` |

### Organizing Data -- `/refactoring/techniques/organizing-data`
Cleaner handling of data; replace primitives with objects.

| Technique | URL |
|-----------|-----|
| Self Encapsulate Field | `/self-encapsulate-field` |
| Replace Data Value with Object | `/replace-data-value-with-object` |
| Change Value to Reference | `/change-value-to-reference` |
| Change Reference to Value | `/change-reference-to-value` |
| Replace Array with Object | `/replace-array-with-object` |
| Duplicate Observed Data | `/duplicate-observed-data` |
| Change Unidirectional Association to Bidirectional | `/change-unidirectional-association-to-bidirectional` |
| Change Bidirectional Association to Unidirectional | `/change-bidirectional-association-to-unidirectional` |
| Replace Magic Number with Symbolic Constant | `/replace-magic-number-with-symbolic-constant` |
| Encapsulate Field | `/encapsulate-field` |
| Encapsulate Collection | `/encapsulate-collection` |
| Replace Type Code with Class | `/replace-type-code-with-class` |
| Replace Type Code with Subclasses | `/replace-type-code-with-subclasses` |
| Replace Type Code with State/Strategy | `/replace-type-code-with-state-strategy` |
| Replace Subclass with Fields | `/replace-subclass-with-fields` |

### Simplifying Conditional Expressions -- `/refactoring/techniques/simplifying-conditional-expressions`
Decompose and clarify conditional logic.

| Technique | URL |
|-----------|-----|
| Decompose Conditional | `/decompose-conditional` |
| Consolidate Conditional Expression | `/consolidate-conditional-expression` |
| Consolidate Duplicate Conditional Fragments | `/consolidate-duplicate-conditional-fragments` |
| Remove Control Flag | `/remove-control-flag` |
| Replace Nested Conditional with Guard Clauses | `/replace-nested-conditional-with-guard-clauses` |
| Replace Conditional with Polymorphism | `/replace-conditional-with-polymorphism` |
| Introduce Null Object | `/introduce-null-object` |
| Introduce Assertion | `/introduce-assertion` |

### Simplifying Method Calls -- `/refactoring/techniques/simplifying-method-calls`
Make method calls simpler and easier to understand.

| Technique | URL |
|-----------|-----|
| Rename Method | `/rename-method` |
| Add Parameter | `/add-parameter` |
| Remove Parameter | `/remove-parameter` |
| Separate Query from Modifier | `/separate-query-from-modifier` |
| Parameterize Method | `/parameterize-method` |
| Replace Parameter with Explicit Methods | `/replace-parameter-with-explicit-methods` |
| Preserve Whole Object | `/preserve-whole-object` |
| Replace Parameter with Method Call | `/replace-parameter-with-method-call` |
| Introduce Parameter Object | `/introduce-parameter-object` |
| Remove Setting Method | `/remove-setting-method` |
| Hide Method | `/hide-method` |
| Replace Constructor with Factory Method | `/replace-constructor-with-factory-method` |
| Replace Error Code with Exception | `/replace-error-code-with-exception` |
| Replace Exception with Test | `/replace-exception-with-test` |

### Dealing with Generalization -- `/refactoring/techniques/dealing-with-generalization`
Move features along inheritance hierarchies; trade inheritance for delegation.

| Technique | URL |
|-----------|-----|
| Pull Up Field | `/pull-up-field` |
| Pull Up Method | `/pull-up-method` |
| Pull Up Constructor Body | `/pull-up-constructor-body` |
| Push Down Method | `/push-down-method` |
| Push Down Field | `/push-down-field` |
| Extract Subclass | `/extract-subclass` |
| Extract Superclass | `/extract-superclass` |
| Extract Interface | `/extract-interface` |
| Collapse Hierarchy | `/collapse-hierarchy` |
| Form Template Method | `/form-template-method` |
| Replace Inheritance with Delegation | `/replace-inheritance-with-delegation` |
| Replace Delegation with Inheritance | `/replace-delegation-with-inheritance` |

---

## How to use a mapping in a finding

For a finding, cite: the **smell** (with its page URL), the **chosen
refactoring** (with its own technique page URL), and one line of justification.
Example:

> `parser.go:88` -- **Long Method** (`/smells/long-method`, 140 lines, ccn 22).
> Apply **Extract Method** (`/extract-method`) to lift the token-classification
> block into `classifyToken`.

Cross-check every mapping against the language doc's idioms -- the language-correct
fix sometimes differs from the generic OO catalog (e.g. Go favors a small
function and early returns over polymorphism; Rust favors enums + `match` over a
State pattern). The `refactor-challenger` will attack mismatches.

Note: this catalog is the *refactoring* taxonomy (smells + techniques). The
*design-pattern* catalog (`/design-patterns/...`) is a separate refactoring.guru
section; reach for it only when a fix genuinely calls for a named GoF pattern,
and confirm it is idiomatic for the language first.
