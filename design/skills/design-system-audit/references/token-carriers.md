# Token Carriers by Ecosystem

Search the config first, then the theme module, then raw declarations in stylesheets. A
config no component imports is dead: confirm consumption before reporting a carrier.

## CSS custom properties (any web stack)

| What | Pattern |
|---|---|
| Carriers | `**/*.css`, `**/*.scss`, `**/*.less`, `**/globals.css`, `**/theme.css` |
| Declarations | `^\s*--[a-z0-9-]+\s*:` |
| Theme scopes | `:root`, `\[data-theme`, `\.dark`, `@media \(prefers-color-scheme` |
| Consumption | `var\(--` |
| Drift | `#[0-9a-fA-F]{3,8}` inside component files |

Trap: a token declared only under `:root` and never under the dark scope is a light-only
token. Report the missing counterpart as a gap, not as a complete color role.

## Tailwind

| What | Pattern |
|---|---|
| Carriers v3 | `tailwind.config.{js,ts,cjs,mjs}` |
| Carriers v4 | any CSS file containing `@theme` |
| Declarations v3 | `theme\s*:`, `extend\s*:`, `colors\s*:`, `spacing\s*:`, `borderRadius\s*:` |
| Declarations v4 | `--color-`, `--font-`, `--spacing-`, `--radius-`, `--shadow-` under `@theme` |
| Consumption | class strings in `class=`/`className=`, `@apply` |

Trap: values under `theme.extend` add to the stock scale; values directly under `theme`
replace it. A stock utility used in markup (`text-slate-500`, `rounded-lg`) is a framework
default, not a project token, until the config names it.

## styled-components, emotion, vanilla-extract

| What | Pattern |
|---|---|
| Carriers | `**/theme.{ts,tsx,js}`, `**/tokens.{ts,tsx}`, `**/*.css.ts` |
| Declarations | `createGlobalStyle`, `DefaultTheme`, `createTheme`, `createThemeContract`, `styleVariants` |
| Consumption | `useTheme\(`, `\$\{\(?\{?\s*theme`, `props\.theme\.`, `vars\.` |
| Drift | hex or px literals inside a tagged template or `css(` call |

Trap: the theme object is often partial and components fill the rest with literals inside
template strings. Count the literals; a high count means PARTIAL, not PRESENT.

## Design token JSON (DTCG, Style Dictionary)

| What | Pattern |
|---|---|
| Carriers | `**/tokens*.json`, `**/*.tokens.json`, `style-dictionary.config.*`, `sd.config.*` |
| Declarations | `"\$value"`, `"\$type"`, `"value"` with a sibling `"type"` |
| Generated output | the config's `buildPath` / `platforms` block |

Trap: JSON is the source and the emitted CSS or TS is the output. Report the JSON as the
carrier and name the generated artifact as derived; editing the output is overwritten.

## SwiftUI and UIKit

| What | Pattern |
|---|---|
| Carriers | `**/Assets.xcassets/**/Contents.json`, `**/*Theme*.swift`, `**/DesignSystem/**/*.swift` |
| Colors | `Color\("`, `UIColor\(named:`, `\.tint\(`, asset-catalog color sets with appearances |
| Type | `\.font\(\.`, `UIFont\.preferredFont`, `UIFontMetrics`, `Info.plist` `UIAppFonts` |
| Spacing and shape | `spacing:`, `padding\(`, `cornerRadius`, `RoundedRectangle\(cornerRadius:` |

Trap: `Color.primary`, `Color(.systemBackground)`, and `.font(.body)` are platform semantic
tokens supplied by the OS. Report them as platform tokens; a project token is a named asset
or a declared constant. Dynamic Type text styles are the type scale, so a hardcoded
`.system(size:)` is drift.

## Jetpack Compose

| What | Pattern |
|---|---|
| Carriers | `**/ui/theme/Color.kt`, `Type.kt`, `Shape.kt`, `Theme.kt`, `**/*Tokens.kt` |
| Colors | `lightColorScheme\(`, `darkColorScheme\(`, `Color\(0x` |
| Type | `Typography\(`, `TextStyle\(`, `MaterialTheme\.typography` |
| Shape and spacing | `Shapes\(`, `RoundedCornerShape\(`, `\.dp\b`, `\.sp\b` |
| Consumption | `MaterialTheme\.colorScheme\.`, `MaterialTheme\.shapes` |

Trap: `MaterialTheme { }` with no `colorScheme` argument leaves the Material baseline scheme
in place. That is PARTIAL with the baseline named, not PRESENT.

## Spacing base derivation

1. Collect every declared step value in one unit.
2. Sort ascending and take successive differences.
3. Report the greatest common divisor of the steps as the base when every step is a multiple
   of it; otherwise report `irregular` with the sequence.

Never report a base the sequence does not support.

## Conflicts worth looking for

- One token name with two values across two carriers.
- A Tailwind config value and a CSS custom property claiming the same role.
- A literal in a component that matches no carrier value.
- A light-scope token with no dark-scope counterpart.
- A generated output file edited by hand, diverging from its source config.
