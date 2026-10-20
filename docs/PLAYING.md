# Playing Doxvelt

[Start the app](../README.md#quick-start) first. No model is needed for manual play.

## The first scene

**Play the example** starts or resumes **The last crossing**: Mara, Nell and Corin
meet at the last ferry before a storm. There is no required narrator or injected
opening. Choose any supported actor and use **Perform** to write their words or
actions. Perform saves immediately, without a preview. Select recipients with the
Audience picker; the acting character also perceives their own turn. Names typed
in prose do not select recipients.

The example uses its own source copy beside the database. Later clicks resume it
without overwriting source edits or accepted history. **Create your own** opens
Studio for prose authoring; Executive Interviews remains an inspectable template.
Starting a simulation pins its source revision. Later source edits do not change
an existing story.

## Drafts and earlier turns

With [AI configured](../README.md#ai-drafts), **Stage whisper** supplies
private direction to the selected actor. It is separate from the performance other
characters receive. AI generation requires an endpoint and model that enforce
strict JSON-schema output. An incompatible endpoint or invalid performance/audience
response fails safely; Doxvelt does not retry with prompt-only formatting. Manual
**Perform** remains available without inference.
**Generate draft** creates a saved candidate; review both its
words and audience, then **Accept** or **Discard**. You can edit performance text,
retry the captured request, or edit the complete whisper and generate afresh.
Saved drafts remain available after API restart. A draft whose branch has moved
cannot simply be accepted at the new head.

**Revise / alternate paths** opens an inline editor at an accepted turn. Editing
or regenerating makes an alternate story path, preserving the original and its
continuation. Historical generation commits/selects the validated alternative
without a separate Accept step; ordinary continuation drafts still require Accept.
Use the editor's alternative controls to revisit saved paths. Cancel restores the
continuation composer. Unsupported operations remain gated with an explanation.

## Local saving and limits

Committed history and saved candidates live in the local database. Unsent text and
suspended editor buffers use browser-local recovery, with no server backup or
cross-device sync. Storage failures or conflicting tabs need attention to the
recovery warning; copy valuable text out when warned. Avoid simultaneous tabs
editing the same story.

Stage identity inspection shows safe public identity only. It does not expose all
subjective beliefs, memories or raw prompts. There is no authored opening briefing
beyond scenario identity. Memory jobs, explicit access changes and logical package
export/import have [CLI/API capabilities](LOCAL_REFERENCE.md), not a complete set
of visual Stage controls. This is an early local prototype.
