# Actor knowledge and alternate story paths

This contract records the approved product corrections behind #32. Design documents
own semantics; issues own live delivery status. It narrowly supersedes conflicting
presence, context-selection and historical regeneration language in the older
architecture and Stage contracts. It does not authorize a new engine or authored
content interpretation.

## Complete legitimate knowledge

Supply all knowledge already legitimate for the actor at the selected branch head
upfront: received turns, accessible beliefs and their provenance, memories, and
previously acquired first impressions, whether their subjects are present or absent.
Do not add retrieval, token-budget truncation or relevance filtering in this slice.
Existing subjective access and retained-after-access-loss rules still apply. This
is not permission to include every dossier, private state, latest surface or global
truth, or to retain live access after its authorization has ended.

A narrated turn reaches its own audience. Mentioning a person, or selecting that
person as the acting character's outgoing recipient, supplies neither current
observation nor private dossier access. A separate player-maintained presence list
must not be necessary to keep context consistent with prose. New-policy prompts
must contain no automatic surfaces or `Observed presence` assertions derived from
stored active presence. Prior legitimate observations remain historic knowledge;
they are not refreshed from the latest description. The actor's own legitimate
knowledge remains available under existing authored-content rules. Untagged dossier
prose is not newly promoted to knowledge by this correction.

Acceptance must not infer mutual face-to-face observation from recipients. Removing
surfaces from generation alone is insufficient if acceptance recreates them as
first-impression beliefs for the next turn. Existing recorded observation history
remains available; sender perception and chosen-recipient receipt still occur.
Unknown reported information stays attributed speech/claim, not authoritative fact.
Queries remain pure and nonancestor knowledge/effects remain excluded.

## Policy and compatibility boundary

Stage explicitly opts into the new actor-knowledge policy. Routing v1 additive and
v2 complete-whisper records, legacy routes and archives retain their exact saved
interpretation, prompt/context hashes, retries, acceptance and receipt replay.
No old record is upgraded by reading or accepting it.
New Stage Perform submissions also opt in explicitly, using manual-command
`knowledgePolicy: "actor-knowledge-v1"`. They commit speech and recipient
perceptions immediately but derive no mutual first impressions from delivery.
Omitting the field preserves legacy manual fingerprints, effects and replay.
The policy is captured in the immutable command and validated during archive
import; it is not inferred from which client later reads the turn. This does not
change historical manual editing semantics.

Editing a saved legacy candidate in current Stage is a new submission, not an
exact retry. Stage explicitly sends `draftingPolicy: "actor-knowledge-v1"` for
complete-whisper revisions, including director-preserved wording. A replacement
gets v3 context and new hashes; the source's original hashes, artifact and identity
remain immutable provenance. Old API revision requests without an opt-in retain
their source-policy behavior. Exact Retry, Accept and replay remain frozen.
Preserve-wording transitions make no model call, require unchanged resolved
complete input and explicit recipients, revalidate under the new context policy,
and retain director-preserved attribution rather than claiming new model output.
 New policy must be bound to
saved routing and prompt policy, validated on retry/acceptance/import, and reject
mismatched or forged versions. Implementation identities and endpoint details are
internal choices; no schema redesign is required by this product contract.

New generation uses only the current complete whisper (including empty), permitted
pre-turn knowledge and explicit director audience for recipient references. Removed
input and source performances remain provenance only. Referenced identity does not
expand a dossier. Keep explicit-recipient validation, empty tools, immutable saved
artifacts, authorized scope, exact command replay, atomic rollback and branch-local
source eligibility. Ordinary continuation retains its existing Accept action.

## Future historical regeneration target

For #17, successful validated historical generation immediately creates/selects an
alternate story path without a separate Accept UI. The UI action may coordinate
generation and safe atomic commit; partial or failed output must never enter history.
The architectural validation/commit boundary remains even though an extra button
does not. This supersedes #31's docs-only historical draft-plus-Accept target.

Alternatives cycle at the branching turn and each retains its own continuation.
Regenerating earlier preserves all old paths. Manual editing semantics are unchanged.
Browser-local unsent wording recovery, owner-scoped originating-whisper retrieval
and latest complete-whisper input remain approved. The earlier recommendation to
block effectful turns was not accepted product policy: keep unsupported cases
honestly gated pending support, without presenting blanket blocking as approved.

Branch cleanup is a follow-up requirement tracked by #33; deletion, hiding and
descendant semantics remain undecided. Neither cleanup nor historical branching,
cycling, autosave, notation (#28), Actor state (#18) or briefing (#19) is runtime work
in #32. Under #25, deliver #32 context correction first, then #17 saved alternatives
engine/API, then UI cycling/recovery. This is sequencing, not another backlog.
