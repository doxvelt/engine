# Scoped audiences and actor projections

DSH Perform and the legacy workbench support inline audiences within one atomic,
branch-bound turn. The actor
selector chooses the performer; there is no separate addressee. Transcript visual
design is outside this change. Generated candidates retain their captured routing
and existing acceptance contract; their prose is not implicitly parsed as notation.

## Authoring

- `@Corin` selects the acting identity for this turn. Omit it to use the composer actor.
- A leading `#Mara,Nell` replaces the base audience for this turn. Lists use commas.
- Otherwise use the explicitly selected, visible **Default audience** in Perform.
  No default is initially selected. Choose one, provide a turn override, or author
  entirely scoped content. Never silently fall back to everyone.
- `#Mara(text)` replaces the audience for that span only; closing restores the base.
  A span recipient outside the base receives none of the surrounding text.
- The actor retains all their own primary performance without self-listing.

The composer default persists across turns in the same authoring context. Turn
selectors never change it or the composer actor. A new simulation/branch session
starts without a default; browser recovery restores only that exact installation,
owner, simulation and branch's saved buffer. Review the visible selection when
returning to a context. Defaults change neither presence nor access, and delivery
creates no automatic mutual first impressions. DSH keeps its default and fallback
choice in that episode chat's browser state; a new path or episode chat resets
them. `/perform @Corin` supplies the composer identity in DSH; the body can begin
with a turn override or span. Explicit `#all` and `#self` remain DSH shorthands;
neither is an implicit default. Generated direction keeps its existing grammar.

Selectors accept pinned IDs or unambiguous, case-sensitive single-token names.
Use IDs for names containing spaces. Unsupported actors, unknown/ambiguous names
and malformed notation reject the whole submission before acceptance.

## Proposed observer fallbacks

`#Mara(primary|fallback)` is implemented behind the explicit **Enable proposed
observer fallbacks** checkbox. It remains an unratified product extension. Without
that opt-in, an outer-depth pipe is rejected, not silently delivered as text.

Named span recipients get primary. Base recipients excluded from that span get
fallback if authored, otherwise nothing. The actor gets primary, never an extra
fallback. A fallback describes the perceivable aspect of the same occurrence,
not another speech act or event. Perceiving a claim neither establishes its truth
nor forces belief.

`[not perceived]` is ordinary authored fallback text, not an automatic rule.
Use `[unintelligible]` for noticed but uncomprehended speech. Unnoticed acts and
private thoughts leave no placeholder unless authored. Empty observer projections
are omitted entirely, including their perceptions and memory inputs.

```text
@Corin #Mara,Nell He leans in and whispers to Mara: #Mara("The key is under the ferry rope."|[unintelligible]) Then he steps back.
```

Mara and Corin receive the quote within the shared prose. Nell receives
`[unintelligible]` in its place.

```text
@Corin #Mara,Nell #Mara(He leans toward Mara.) "The key is under the ferry rope."
```

Nell receives only the quote. Keep connective punctuation inside its appropriate
span so omission does not strand it. `#Corin(I must not tell them.)` alone gives
Mara and Nell no turn or placeholder.

## Literal delimiters

Scopes are flat; nested audience scopes fail. Ordinary parentheses inside scopes
balance normally. Escape literal delimiters with `\\`, `\(`, `\)`, `\|`, `\#`
and `\@`; other backslashes remain text. A literal hashtag must be escaped in
new scoped submissions. The fallback separator is an unescaped pipe at the
scope's outer depth. Inner-parenthesis pipes are text; a second outer-depth pipe
fails. For example, `#Mara(The mark (two strokes) means A\|B.)` delivers
`The mark (two strokes) means A|B.`. Leading/trailing observer whitespace is trimmed;
internal authored spacing and punctuation are preserved.

## Commands and immutable history

Manual commands opt in with `audienceSyntax: "scoped-v1"`, or
`"scoped-fallback-v1"` for proposed fallbacks, alongside
`knowledgePolicy: "actor-knowledge-v1"`. `audience` is the captured composer default
as existing IDs, or null if unresolved; an empty array explicitly selects only
the actor. HTTP `/simulations/:id/turns` uses `manualText`; core uses `text`.
Missing/null audience under scoped syntax never reads the presence roster.
CLI manual turns accept `--audience-syntax scoped-v1` (or the fallback version),
with optional `--audience id,id` as the explicit default. All acceptance paths
retain expected-head checks and idempotent command identities.

The accepted message stores the authored text plus `performance`: interpretation
version, syntax, resolved base, ordered spans with resolved audiences and primary/
fallback text, and per-actor projections. One message event and commit preserve
existing message/event/perception provenance. Canonical audience metadata records
actual perceivers; it is never permission to deliver the entire authored text.

Context assembly, runtime input and episode-memory work use only the character's
projection. Scoped transcript records in these inputs contain no performance
metadata or recipient union. Hidden text, lists, span counts and offsets are not
provided. Source selection cannot bypass the authoritative projection. Historical
manual edits retain scoped syntax and form independent sibling paths. Archive
validation recomputes projections against pinned identities and rejects forged
spans/projections. Legacy commands and turns without opt-in remain literal and
retain their original fingerprints, effects and interpretation.

Invalid input has no canonical effects. A lost accepted response replays the exact
frozen command, including default and syntax, even after newer typing, default
changes or restart. Memory failure leaves the accepted turn saved and memory work
retryable without repeating acceptance. Manual acceptance is synchronous after
validation; abandoning unsent text creates nothing. Existing model-draft abort and
memory-job failure behavior remain separate from immediate Perform.

DSH stores an acceptance request's original default, syntax, command ID and branch
head before transmission. **Retry pending performance** reconciles it even after
new typing or reload. A body-only correction reparses with the saved interpretation
and base, persists fresh projections and retains audience structure. Routing
changes require a replacement turn. The standalone Reverie bridge supplies only
the observer's projected text and omits scope recipient metadata from reflection.

Behavior checks live in `scoped-audiences.test.ts`, `dsh-scoped-retry.test.ts` and
`scoped-audiences-api.test.ts`: both examples, precedence, outside-base recipients,
private omission, actor perception, escaping, invalid input, safe context and
memory callbacks, atomic rejection, restart/retry, browser recovery, changed
defaults, legacy replay, sibling histories and archive tampering/import.
