# Doxvelt design system

**Selected direction: Living Library + Continuous script.** This is the visual
contract for adoption, not a claim that the current specimen or product has been
restyled. [Stage Experience](../docs/design/STAGE_EXPERIENCE.md) owns interaction
semantics; the [adoption plan](../docs/design/LIVING_LIBRARY_ADOPTION.md) owns gates.

## Current assets and authority

- [tokens.css](tokens.css) is the canonical token source: warm ink/parchment
  neutrals, ember actions, oxblood severity, semantic states, spacing and type.
- [index.html](index.html) is the existing static specimen, including light/dark
  themes, logo usage, fields, tags, badges, dossiers and transcript examples.
- `fonts/` supplies Geist and Geist Mono; `assets/` contains the existing brand marks.

The selected study has **not replaced these tokens, fonts or assets**. Its serif
typography, book-jacket colors and exact dimensions are reference treatments, not
new production values. Any adopted palette/type changes must update canonical
tokens and specimen together and preserve semantic contrast in both themes.

## Selected composition

Home has one featured, recognizable return item with **Continue** and a quieter
collection beside or below it. First arrival pairs the example with **Create your
own**, an understandable route to Studio. Keep the invitation to resume without
unexplained volume numbers, literary filler or “reading desk” navigation wording.
The featured-item rule and empty-collection treatment remain open.

Stage reads as a **continuous script**. Avatar and readable name anchor actor
identity; prose flows without a card, separator rule or Accepted badge on every
turn. Compact audience information remains legible. Avatar/name inspection is
keyboard-accessible and limited to the data authorized by the Stage contract.
Use existing assets or identity fallbacks until a production avatar treatment is
specified; do not import study portraits.

Keep palette and typography restrained: warm reading surfaces, strong readable
text, sparse emphasis and few competing text sizes. Preserve existing source-span,
dossier, belief-strength, access-path, tag, badge and authoring-field semantics.
A decorative accent must not silently redefine danger, selection or belief state.

Actions stay quiet but discoverable by keyboard and touch, without hover-only
access. Draft and active-revision boundaries use text as well as styling. Keep
controls compact enough to preserve history space, with readable labels, visible
focus and reachable touch targets on short/mobile screens. Inline historical
editing hides and preserves the normal composer. Maintain reading position and
show Jump to latest only when needed.

Continuous script supersedes the light-separation comparison. Exact vertical
spacing, border consolidation and type polish are deferred to implementation
review. Preserve useful structural hierarchy without multiplying decorative rules.

## Adoption boundary

Build in the existing Nuxt/Nuxt UI application using shared tokens and components.
The private study remains an existing disposable reference, not a maintained app.
Do not copy its HTML, fixtures, storage model or interaction code into production.
This contract and the adoption plan stand alone after the preview is removed.
