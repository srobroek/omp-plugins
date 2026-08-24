---
name: architecture-component-promotion
description: When adding or promoting UI components, design-system code, or shared primitives into libs/ui.
globs: ["apps/**/components/**", "apps/**/ui/**", "libs/ui/**"]
---

Keep components local to an app; move shared primitives and design-system code
to `libs/ui` only after two app surfaces actually reuse them. Shared UI code
should be more stable than app-local components: use typed props, documented
variants, reusable accessibility behavior, and browser verification.
