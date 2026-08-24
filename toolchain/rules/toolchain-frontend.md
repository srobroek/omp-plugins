---
name: toolchain-frontend
description: When choosing a frontend framework, UI kit, or client/server state library.
globs: ["**/*"]
---

# Frontend Defaults

Route framework choice by product surface:

- React + Vite for SPA and product UIs.
- Vue + Vite for app-style UIs when Vue is a better team or domain fit.
- Next.js for SSR or full-stack React.
- Astro for marketing, static content, and documentation sites.

Use framework-native UI choices. React may use shadcn/ui and Base UI. Vue may
use PrimeVue or Nuxt UI by project need.

Use store-first app/UI state and TanStack Query for server state unless the
existing codebase has a stronger local convention.
