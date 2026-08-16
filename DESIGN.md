# DESIGN.md — orcflood.com visual world

**World.** A war-office field report from a front that is one long losing
battle: munitions-crate stencil lettering, signal-flare green on powder
black, and the flood itself rendered live. Extends the shipped store-poster
identity (same palette, band device, chips) — the posters are canon.

## Tokens

Color (single committed dark theme — the game's world; every surface paints
its own background, no theme switching):
- `--bg` #141118 powder black (page ground)
- `--bg2` #1d1922 raised panel · `--bg3` #0c0a10 recessed/screenshot wells
- `--ink` #f2efe6 bone · `--muted` #b3aea2 (secondary text, warm — never gray)
- `--acc` #a6dc30 signal green — the horde's color; owns the diagonal bands,
  primary actions, stat numerals. Committed strategy: green carries whole
  regions, not sprinkles.
- `--gold` #c49c48 muster gold — captions, rules, secondary tags (from the
  landscape-poster caption strip)
- `--line` #2e2a36 hairline borders
- On-green ink: #17151c (headlines) / #1d2410 (labels)

Type:
- Display: **Big Shoulders Stencil** 900 (self-hosted woff2), uppercase,
  tracking -0.01em to 0 (stencil needs air; never negative beyond -0.02),
  sizes clamp(2.6rem → 6rem). Two-tone headline device: bone + green lines.
- Body: **Public Sans** 400/600/700, 16-18px, measure ≤ 70ch.
- Numerals: Public Sans 700 `font-variant-numeric: tabular-nums` with
  thin-space grouping (160 000 style, as in the game).
- Labels/kickers: Public Sans 700 uppercase, letter-spacing .14em, gold or
  green — used as *report field labels* (a system, not an everywhere-eyebrow).

Components:
- **Band**: full-width green field, top edge clipped diagonal
  (`polygon(0 X, 100% 0, ...)`), carrying one huge dark stat + small label.
- **Chip**: #232029 pill, 48px pixel game icon (`image-rendering: pixelated`)
  + 600 label.
- **Screenshot well**: `--bg3` frame, 2px `--line` border, radius 14px,
  offset soft shadow, gold viewfinder corner ticks (top corners) marking it
  as a capture; captions in gold mono-case label style. Declared exception
  to the elevation rule: capture wells are framed plates and carry border +
  shadow together.
- Buttons: green fill / bone stencil-adjacent caps label; secondary =
  1px green stroke on black.
- Radii 12-14px cards, pills only for chips/buttons. Elevation via shadow
  OR border (sole exception: capture wells, above).

Motion: one authored moment — the hero canvas horde tide (dots flow, thin
defended line fires tracers; honest on-page orc counter). Everything else
static except restrained hovers. `prefers-reduced-motion`: canvas renders a
single still frame.

Bans checked against the world: no gradient text, no glass, no card grids
of icon+heading+text, no section numbering, no gray secondary text on
color, no third-party requests. Stencil display never used for body copy.
