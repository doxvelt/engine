window.__ModuleLoader__.load({
  id: '@doxvelt/dsh-gui-spike',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
    const fixtureCast = ['Corin', 'Nell', 'Mara'].map(token => ({ token, name: token, canGenerate: token !== 'Corin' }));
    const casts = new Map();
    const castFor = sessionId => casts.get(sessionId) ?? fixtureCast;
    const modes = ['perform', 'generate'];
    const kind = 'doxvelt-performance';
    const defaultRoute = { mode: 'perform', character: 'Corin', audience: '!all' };
    const routes = new Map();
    const sceneListeners = new Map();
    const carryDrafts = new Map();

    async function submit(sessionId, command, signal) {
      try {
        const response = await fetch('/api/doxvelt-fixture', {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ...command }),
        });
        const result = await response.json();
        if (response.ok && result.opened?.cast) casts.set(sessionId, result.opened.cast);
        if (response.ok && ['perform', 'generate', 'correct'].includes(command.mode)) void sceneListeners.get(sessionId)?.();
        return response.ok ? { kind: 'success', result } : { kind: 'error', status: response.status, text: result.error };
      } catch {
        return { kind: 'error', uncertain: true, text: 'The scene could not save. Try again.' };
      }
    }

    function parseDraft(draft, cast) {
      const match = /^\/(perform|generate)\s+@([\w-]+)\s+to\s+([^|]+)\|\s*([\s\S]*)$/i.exec(draft.trimStart());
      if (!match) return undefined;
      const resolve = name => cast.find(actor => actor.token.toLowerCase() === name.toLowerCase())?.token;
      const mode = match[1].toLowerCase();
      const character = resolve(match[2]);
      const direction = match[3].trim();
      const delegate = /^actor(?:\s+among\s+(.+))?$/i.exec(direction);
      let audience;
      if (/^(all|self)$/i.test(direction)) audience = '!' + direction.toLowerCase();
      else if (delegate && mode === 'generate' && !delegate[1]) audience = '!actor';
      else if (!delegate || mode === 'generate') {
        const recipients = (delegate?.[1] ?? direction).split(',').map(item => {
          const mention = /^@([\w-]+)$/.exec(item.trim());
          return mention && resolve(mention[1]);
        });
        if (recipients.every(item => item && item !== character) && new Set(recipients).size === recipients.length) {
          const list = cast.filter(actor => recipients.includes(actor.token)).map(actor => actor.token).join(',');
          audience = delegate ? '!actor:' + list : list;
        }
      }
      return { mode, character, audience, body: match[4] };
    }

    function claim(session, mode) {
      return {
        name: mode,
        token: '/' + mode + ' ',
        submit(args) {
          const command = parseDraft('/' + mode + ' ' + args, castFor(session.sessionId));
          if (!command?.character || !command.audience) {
            return Promise.resolve({ kind: 'error', text: 'Choose recipients with the Audience control, or use to all, to @Nell, @Mara, or to actor before |.' });
          }
          return submit(session.sessionId, command);
        },
      };
    }

    function formatDraft({ mode, character, audience, body = '' }) {
      const mentions = value => value.split(',').map(token => '@' + token).join(', ');
      const recipients = ['!all', '!self', '!actor'].includes(audience) ? audience.slice(1)
        : audience.startsWith('!actor:') ? 'actor among ' + mentions(audience.slice(7)) : mentions(audience);
      return '/' + mode + ' @' + character + ' to ' + recipients + ' | ' + body;
    }

    function supportedRoute(values, cast) {
      const generators = cast.filter(actor => actor.canGenerate);
      if (values.mode === 'generate' && !generators.length) values.mode = 'perform';
      const eligible = values.mode === 'generate' ? generators : cast;
      if (!eligible.some(actor => actor.token === values.character)) values.character = eligible[0]?.token;
      const delegated = values.audience === '!actor' || values.audience?.startsWith('!actor:');
      if (!values.audience || (delegated && values.mode === 'perform')) values.audience = '!all';
      else if (!['!all', '!self', '!actor'].includes(values.audience)) {
        const selected = (delegated ? values.audience.slice(7) : values.audience).split(',');
        const recipients = cast.filter(actor => actor.token !== values.character && selected.includes(actor.token));
        const group = recipients.map(actor => actor.token).join(',');
        values.audience = group ? (delegated ? '!actor:' : '') + group : '!self';
      }
      return values;
    }

    function Routing({ sessionId, useSession, useInput, inputActions, focusComposer, openEpisodeSession }) {
      const draft = useInput(state => state.draft);
      const phase = useInput(state => state.phase);
      const openState = useSession(state => state.openState);
      const cast = castFor(sessionId);
      const command = parseDraft(draft, cast);
      const busy = phase === 'submitting' || phase === 'sending' || phase === 'adjudicating';
      const [saved, setSaved] = useState({ simulations: [], opened: null, branches: [], episodes: [] });
      const [opening, setOpening] = useState(false);
      const [error, setError] = useState('');

      useEffect(() => {
        if (openState !== 'open') return;
        let current = true;
        void submit(sessionId, { mode: 'saved' }).then(outcome => {
          if (current && outcome.kind === 'success') setSaved(outcome.result);
        });
        return () => { current = false; };
      }, [openState, sessionId]);

      useEffect(() => {
        if (command?.character && command.audience) {
          const { mode, character, audience } = command;
          routes.set(sessionId, { mode, character, audience });
        } else if (!draft && !busy && openState === 'open') {
          // Let the stock composer restore focus after its submit transaction first.
          const selection = inputActions.captureInsertion();
          const frame = requestAnimationFrame(() => {
            const route = supportedRoute({ ...(routes.get(sessionId) ?? defaultRoute) }, cast);
            const carried = carryDrafts.get(sessionId);
            if (carried) {
              if (inputActions.insertText(carried, selection)) carryDrafts.delete(sessionId);
            } else if (route.character && route.audience) inputActions.insertText(formatDraft(route), selection);
          });
          return () => cancelAnimationFrame(frame);
        }
      }, [draft, busy, openState, sessionId, inputActions]);

      useEffect(() => {
        if (!saved.opened || (command?.body ?? (/^\/(perform|generate)\b[^|]*\|\s*$/i.test(draft) ? '' : draft)).trim()) return;
        // Opening history can remount the stock editor. Place its caret after the route in the new view.
        const span = { ...inputActions.captureInsertion(), start: 0, end: draft.length };
        const route = supportedRoute({ ...(routes.get(sessionId) ?? defaultRoute), ...command }, cast);
        if (!route.character || !route.audience) return;
        const next = formatDraft(route);
        const frame = requestAnimationFrame(() => {
          if (inputActions.insertText(next, span) && document.activeElement === document.body) focusComposer();
        });
        return () => cancelAnimationFrame(frame);
      }, [saved.opened, sessionId, inputActions]);

      async function openSaved(simulationId) {
        setOpening(true);
        setError('');
        const outcome = await submit(sessionId, { mode: 'open-saved', simulationId });
        if (outcome.kind === 'success') setSaved(previous => ({ ...previous, ...outcome.result }));
        else setError(outcome.text);
        setOpening(false);
      }

      async function navigate(selection) {
        setOpening(true);
        setError('');
        try {
          await openEpisodeSession({ simulationId: saved.opened.simulationId, ...selection });
        } catch (error) {
          setError(error.message);
        } finally {
          setOpening(false);
        }
      }

      function update(change) {
        const values = { ...defaultRoute, body: draft, ...command, ...change };
        const route = supportedRoute(values, cast);
        if (route.character && route.audience) inputActions.setDraft(formatDraft(route));
      }
      function select(label, value, options, onChange) {
        const labels = { '!all': 'Everyone', '!self': 'Only self', '!actor': 'Actor chooses' };
        const optionLabel = option => label === 'Audience limit' && option === '!all' ? 'No limit'
          : (Object.hasOwn(labels, option) ? labels[option] : undefined) ?? option.split(',').map(token => cast.find(actor => actor.token === token)?.name ?? token).join(' + ');
        return h('label', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, label, ' ',
          h('select', { 'aria-label': label, value: value ?? '', disabled: busy || opening,
            onChange: event => onChange(event.target.value) },
            h('option', { value: '', disabled: true }, 'Choose'),
            options.map(option => h('option', { value: option, key: option }, optionLabel(option)))));
      }

      const unsent = Boolean((command?.body ?? draft).trim());
      const available = command?.mode === 'generate' ? cast.filter(actor => actor.canGenerate) : cast;
      const recipients = cast.filter(actor => actor.token !== command?.character).map(actor => actor.token);
      const groups = recipients.length <= 4
        ? recipients.flatMap((first, index) => recipients.slice(index + 1).map(second => first + ',' + second))
        : [];
      const audience = command?.audience?.startsWith('!actor:') ? '!actor' : command?.audience;
      const limit = command?.audience?.startsWith('!actor:') ? command.audience.slice(7) : '!all';
      const fixed = ['!all', '!self', ...recipients, ...groups];
      const limits = ['!all', ...recipients, ...groups];
      if (audience && audience !== '!actor' && !fixed.includes(audience)) fixed.push(audience);
      if (!limits.includes(limit)) limits.push(limit);
      return h('div', { 'aria-label': 'Doxvelt routing', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '0 8px 8px', width: '100%', margin: '0 auto',
        maxWidth: 'var(--dsh-composer-card-max-width, 712px)', boxSizing: 'border-box' } },
        select('Action', command?.mode, cast.some(actor => actor.canGenerate) ? modes : ['perform'], mode => update({ mode })),
        select(command?.mode === 'generate' ? 'Actor' : 'Character', command?.character, available.map(actor => actor.token), character => update({ character })),
        select('Audience', audience, command?.mode === 'generate' ? [...fixed, '!actor'] : fixed, audience => update({ audience })),
        audience === '!actor' && select('Audience limit', limit, limits, value => update({ audience: value === '!all' ? '!actor' : '!actor:' + value })),
        h('select', {
          'aria-label': 'Saved episode',
          value: saved.opened?.simulationId ?? '',
          disabled: busy || opening || Boolean(saved.opened) || Boolean((command?.body ?? draft).trim()),
          onChange: event => { void openSaved(event.target.value); },
        },
          h('option', { value: '', disabled: true }, opening ? 'Opening episode…' : 'Open saved episode'),
          saved.simulations.map(item => h('option', { value: item.simulationId, key: item.simulationId }, item.scenarioName ?? item.simulationId))),
        saved.opened && saved.branches.length > 1 && h('label', null, 'Story path ',
          h('select', {
            'aria-label': 'Story path', value: saved.opened.branchId,
            disabled: busy || opening || Boolean((command?.body ?? draft).trim()),
            onChange: event => { void navigate({ branchId: event.target.value, episodeId: saved.opened.episodeId, followPath: true }); },
          }, saved.branches.map(branch => h('option', { value: branch.id, key: branch.id }, branch.label)))),
        saved.opened && saved.episodes?.length > 0 && h('label', null, 'Episode transcript ',
          h('select', {
            'aria-label': 'Episode transcript', value: saved.opened.episodeId ?? '',
            disabled: busy || opening || unsent,
            onChange: event => { void navigate({ branchId: saved.opened.branchId, episodeId: event.target.value || null }); },
          }, h('option', { value: '' }, 'Current episode'),
            ...saved.episodes.map(episode => h('option', { value: episode.id, key: episode.id }, episode.label)))),
        saved.opened?.episodeId && h('span', null, 'Closed episode'),
        error && h('span', { role: 'alert' }, error),
        saved.opened && h(MemoryControls, { sessionId, busy, unsent,
          openNextEpisode: () => openEpisodeSession({ simulationId: saved.opened.simulationId, branchId: saved.opened.branchId }) }));
    }

    function MemoryControls({ sessionId, busy, openNextEpisode, unsent }) {
      const [state, setState] = useState(null);
      const [open, setOpen] = useState(false);
      const [selected, setSelected] = useState('');
      const [dateDraft, setDateDraft] = useState(null);
      const [notice, setNotice] = useState('');
      const [action, setAction] = useState('');
      const operation = useRef(null);
      useEffect(() => {
        let mounted = true;
        async function refresh() {
          const outcome = await submit(sessionId, { mode: 'memory-status' });
          if (mounted && outcome.kind === 'success' && outcome.result.episodes) setState(outcome.result);
        }
        sceneListeners.set(sessionId, refresh);
        void refresh();
        return () => {
          mounted = false;
          if (sceneListeners.get(sessionId) === refresh) sceneListeners.delete(sessionId);
          operation.current?.abort();
        };
      }, [sessionId]);
      if (!state) return null;
      const current = state.episodes.at(-1);
      const viewed = state.episodes.find(item => item.episodeId === state.episodeId) ?? current;
      const episode = state.episodes.find(item => item.slot === selected) ?? viewed;
      const date = dateDraft ?? episode.date ?? '';
      const drifted = state.episodes.filter(item => item.status === 'drifted' &&
        (item.slot === viewed.slot || (item.date && viewed.date && item.date < viewed.date)));
      const locked = busy || Boolean(action);
      async function perform(mode, values) {
        const controller = new AbortController();
        operation.current = controller;
        setAction(mode);
        setNotice('');
        const outcome = await submit(sessionId, { mode, slot: episode.slot, ...values }, controller.signal);
        if (controller.signal.aborted) setNotice('Memorization cancelled.');
        else if (outcome.kind === 'success') {
          setState(outcome.result);
          setDateDraft(null);
          if (mode === 'memory-memorize') setNotice(outcome.result.status === 'published' ? 'Memories saved.' : 'Memories are already current.');
          if (mode === 'memory-next') await openNext();
        } else setNotice(outcome.text);
        operation.current = null;
        setAction('');
      }
      async function openNext() {
        try { await openNextEpisode(); }
        catch { setNotice('Episode ended. Open next episode to retry.'); }
      }
      return h('div', null,
        h(Button, { size: 'sm', variant: 'outline', onClick: () => setOpen(true) }, 'Episode memory'),
        drifted.length > 0 && h('span', { role: 'status', style: { marginLeft: 8 } },
          'Memories are out of date for ' + drifted.map(item => item.label).join(', ') + '.'),
        h(Modal, { title: 'Episode memory', closeLabel: 'Close episode memory', open,
          onClose: () => { if (!action) setOpen(false); } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h('label', null, 'Episode ', h('select', { 'aria-label': 'Memory episode', value: episode.slot,
              disabled: Boolean(action), onChange: event => { setSelected(event.target.value); setDateDraft(null); } },
              state.episodes.map(item => h('option', { key: item.slot, value: item.slot }, item.label)))),
            h('label', null, 'Fictional date ', h('input', { 'aria-label': 'Fictional date', type: 'date',
              value: date, disabled: locked, onChange: event => setDateDraft(event.target.value) })),
            h(Button, { size: 'sm', variant: 'outline', disabled: locked || !date || date === episode.date,
              onClick: () => { void perform('memory-date', { date }); } }, 'Set date')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            h(Button, { variant: 'primary', disabled: locked || !episode.date || !episode.canMemorize,
              onClick: () => { void perform('memory-memorize', {}); } }, episode.status === 'unmemorized' ? 'Memorize' : 'Memorize again'),
            action === 'memory-memorize' && h(Button, { variant: 'outline',
              onClick: () => operation.current?.abort() }, 'Cancel memorization'),
            h(Button, { variant: 'outline', disabled: locked || state.ended || unsent || !current.canMemorize,
              onClick: () => { void perform('memory-next', { label: current.label }); } }, 'End and open next episode'),
            state.ended && h(Button, { variant: 'outline', onClick: () => { void openNext(); } }, 'Open current episode')),
          action === 'memory-memorize' && h('p', { role: 'status' }, 'Forming memories…'),
          notice && h('p', { role: 'status' }, notice),
          h('div', { style: { maxHeight: 220, overflowY: 'auto', marginTop: 12 } },
            ...episode.memories.map(character => h('section', { key: character.characterId },
              h('strong', null, character.characterId),
              h('ul', null, ...character.memories.map((entry, index) => h('li', { key: index }, entry.gist)),
                ...character.impressions.map((entry, index) => h('li', { key: 'impression-' + index }, entry.text))))))));
    }

    function SavedTurn({ turn, sessionId, openEpisodeSession }) {
      const [mode, setMode] = useState(null);
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [savedPath, setSavedPath] = useState(null);
      const [retry, setRetry] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const button = useRef(null);
      const requestId = useRef(null);
      const identity = { id: turn.id, version: turn.version };

      async function edit(action) {
        setMode(action);
        setForm(null);
        setSavedPath(null);
        setRetry(null);
        setAttempt(0);
        requestId.current = crypto.randomUUID();
        setError('');
        setBusy(true);
        const result = await submit(sessionId, { mode: 'history-origin', ...identity });
        if (result.kind === 'success') {
          const { cast, actor, audience, whisper, version, body, expectedHead, next } = result.result;
          const eligible = cast.filter(item => item.canGenerate);
          const preferred = action === 'generate' ? actor : next?.actor;
          const character = eligible.some(item => item.token === preferred) ? preferred : eligible[0]?.token ?? '';
          const recipients = action === 'generate' ? audience : next?.audience ?? null;
          setForm({ eligible, cast, speaker: actor, editedAudience: audience, originalActor: actor, originalAudience: audience,
            character, audience: recipients?.filter(item => item !== character) ?? null,
            whisper: action === 'generate' ? whisper : next?.whisper ?? '', version, body, expectedHead });
        } else setError(result.text);
        setBusy(false);
      }

      function update(change) { setForm(previous => ({ ...previous, ...change })); }

      function close() {
        if (busy) return;
        setMode(null);
        requestAnimationFrame(() => button.current?.focus());
      }

      async function openPath(selection, keepDraft = false) {
        try { await openEpisodeSession(selection, keepDraft); }
        catch { setError('The new path is saved. Open it to continue.'); }
      }

      async function save(action) {
        setBusy(true);
        setError('');
        const routing = { character: form.character, audience: form.audience, whisper: form.whisper,
          ...(form.audience === null && form.audienceLimit?.length ? { audienceLimit: form.audienceLimit } : {}) };
        const result = await submit(sessionId, { ...identity, version: form.version, expectedHead: form.expectedHead, requestId: requestId.current,
          ...(action === 'correct' ? { mode: 'history-correct', body: form.body }
            : action === 'next' ? { mode: 'history-edit-next', attempt, ...routing,
              body: form.body, speaker: form.speaker, editedAudience: form.editedAudience }
            : { mode: 'history-generate', ...routing }) });
        if (result.kind === 'success') {
          setSavedPath(result.result.selection);
          setRetry(result.result.retry ?? null);
          if (result.result.retry === 'next') {
            setAttempt(value => value + 1);
            setError('Edit saved. The next turn did not generate. Try again or open the saved path.');
          } else if (result.result.retry === 'check') {
            setError('Edit saved. Check whether the next turn finished.');
          } else await openPath(result.result.selection, action === 'correct');
        } else {
          if (action === 'next' && result.uncertain) setRetry('check');
          if (action === 'generate' && result.status === 422) requestId.current = crypto.randomUUID();
          setError(result.text);
        }
        setBusy(false);
      }

      function characterSelect(label, character, options, disabled, onChange) {
        return h('label', null, label + ' ', h('select', { 'aria-label': label, value: character, disabled,
          onChange: event => onChange(event.target.value) },
          options.map(actor => h('option', { key: actor.token, value: actor.token }, actor.name))));
      }

      function audienceSelect(label, character, audience, disabled, onChange, onLimit) {
        const selected = audience ?? form.audienceLimit ?? [];
        return h('fieldset', { disabled, 'aria-label': label },
          h('legend', null, label),
          onLimit && h('label', null, h('input', { type: 'checkbox', checked: audience === null,
            onChange: event => onChange(event.target.checked ? null : selected) }), ' Actor chooses'),
          ...form.cast.filter(item => item.token !== character).map(item => h('label', { key: item.token, style: { marginLeft: 8 } },
            h('input', { type: 'checkbox', checked: selected.includes(item.token),
              onChange: event => {
                const recipients = event.target.checked ? [...selected, item.token] : selected.filter(value => value !== item.token);
                (audience === null ? onLimit : onChange)(recipients);
              } }),
            ' ', item.name)),
          audience === null && h('small', { style: { display: 'block' } },
            selected.length ? 'The actor can choose among the checked characters.' : 'No limit. Check characters to limit the choice.'));
      }

      function generationFields(prefix) {
        const locked = busy || retry === 'check';
        return [
          characterSelect(prefix + ' actor', form.character, form.eligible, locked,
            character => update({ character, audience: form.audience?.filter(item => item !== character) ?? null,
              audienceLimit: form.audienceLimit?.filter(item => item !== character) })),
          audienceSelect(prefix + ' audience', form.character, form.audience, locked,
            audience => update({ audience, audienceLimit: undefined }), audienceLimit => update({ audienceLimit })),
          h('label', null, prefix + ' stage whisper', h('textarea', { style: { display: 'block', width: '100%' },
            'aria-label': prefix + ' stage whisper', value: form.whisper, disabled: locked, onChange: event => update({ whisper: event.target.value }) })),
        ];
      }

      const editLocked = busy || Boolean(retry);
      const routingChanged = form && (form.speaker !== form.originalActor || form.editedAudience.length !== form.originalAudience.length ||
        form.editedAudience.some(item => !form.originalAudience.includes(item)));
      const validText = Boolean(form?.body.trim());
      return h('article', { 'data-doxvelt-turn': turn.id, style: { padding: '0.6rem 0' } },
        h('strong', null, turn.character), ' → ', turn.audience || 'Self',
        h('p', null, h('span', null, turn.body), ' ',
          h('button', { type: 'button', onClick: event => { button.current = event.currentTarget; void edit('correct'); } }, 'Edit turn'), ' ',
          h('button', { type: 'button', onClick: event => { button.current = event.currentTarget; void edit('generate'); } }, 'Regenerate this turn')),
        h(Modal, { title: mode === 'correct' ? 'Edit turn' : 'Regenerate this turn', closeLabel: 'Close turn editor', open: Boolean(mode), onClose: close },
          mode === 'generate' && h('p', null, turn.body),
          form && (!savedPath || retry) && mode === 'correct' && h('form', {
            onSubmit: event => { event.preventDefault(); if (!editLocked && validText && !routingChanged && form.body.trim() !== turn.body) void save('correct'); },
            style: { display: 'grid', gap: 8 },
          },
            h('label', null, 'Performance', h('textarea', { 'aria-label': 'Revised performance', value: form.body, autoFocus: true, rows: 4,
              style: { display: 'block', width: '100%', boxSizing: 'border-box' },
              disabled: editLocked, onChange: event => update({ body: event.target.value }) })),
            characterSelect('Speaking character', form.speaker, form.cast, editLocked,
              speaker => update({ speaker, editedAudience: form.editedAudience.filter(item => item !== speaker) })),
            audienceSelect('Edited audience', form.speaker, form.editedAudience, editLocked,
              editedAudience => update({ editedAudience })),
            form.eligible.length > 0 && h('details', { open: retry ? true : undefined },
              h('summary', null, 'Next turn direction'),
              h('div', { style: { display: 'grid', gap: 8, marginTop: 8 } }, ...generationFields('Next'))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h(Button, { type: 'submit', variant: routingChanged ? 'outline' : 'primary', disabled: editLocked || !validText || routingChanged || form.body.trim() === turn.body }, 'Save correction'),
              h(Button, { type: 'button', variant: routingChanged ? 'primary' : 'outline', disabled: busy || !validText || !form.character,
                onClick: () => { void save('next'); } }, retry === 'next' ? 'Retry next turn'
                : retry === 'check' ? 'Check next turn' : 'Save & generate next turn'))),
          form && !savedPath && mode === 'generate' && h('form', {
            onSubmit: event => { event.preventDefault(); if (!busy && form.character) void save('generate'); },
            style: { display: 'grid', gap: 8 },
          },
            ...generationFields('Revision'),
            h(Button, { type: 'submit', variant: 'primary', disabled: busy || !form.character }, 'Generate and open new path')),
          savedPath && h(Button, { disabled: busy, onClick: () => { void openPath(savedPath); } }, 'Open saved path'),
          busy && h('p', { role: 'status' }, form ? 'Saving the revised path…' : 'Loading the turn…'),
          error && h('p', { role: 'alert' }, error)));
    }

    function Turn({ node, sessionId }) {
      const turn = node.data;
      const [editing, setEditing] = useState(false);
      const [body, setBody] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [whisper, setWhisper] = useState(null);
      async function showWhisper() {
        const result = await submit(sessionId, { mode: 'inspect', id: turn.id });
        if (result.kind === 'success') setWhisper(result.result.whisper ?? 'No recorded whisper.');
        else setError(result.text);
      }
      async function save(event) {
        event.preventDefault();
        setBusy(true);
        const result = await submit(sessionId, { mode: 'correct', id: turn.id, body });
        setBusy(false);
        if (result.kind === 'success') setEditing(false);
        else setError(result.text);
      }
      return h('article', { 'data-doxvelt-turn': turn.id, style: { padding: '0.6rem 0' } },
        h('strong', null, turn.character), ' → ', turn.audience,
        editing
          ? h('form', { onSubmit: save },
              h('textarea', { 'aria-label': 'Correct performance', value: body, autoFocus: true, onChange: event => setBody(event.target.value) }),
              h('button', { type: 'submit', disabled: busy }, 'Save correction'),
              h('button', { type: 'button', disabled: busy, onClick: () => setEditing(false) }, 'Cancel correction'),
              turn.performer !== 'player' && h('button', { type: 'button', onClick: showWhisper }, 'Show stage whisper'),
              whisper !== null && h('p', null, whisper),
              error && h('p', { role: 'alert' }, error))
          : h('p', null, turn.body, ' ', !turn.saved && h('button', {
              type: 'button',
              'aria-label': 'Edit turn ' + turn.id,
              onClick: () => { setBody(turn.body); setError(''); setWhisper(null); setEditing(true); },
            }, 'Edit')));
    }

    function apply(ctx) {
      async function openEpisodeSession(sessionId, selection, keepDraft) {
        const workspaceId = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))?.workspaceId;
        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
        const next = await ctx.sessions.create(workspaceId ? { workspaceId } : { cwd });
        const result = await submit(next, { mode: 'open-saved', ...selection });
        if (result.kind !== 'success') throw new Error(result.text);
        routes.set(next, routes.get(sessionId) ?? defaultRoute);
        if (keepDraft) {
          const binding = ctx.sessions.binding(sessionId);
          const draft = binding && ctx.conversation.input.for(binding.ctx).snapshot.draft;
          if (draft) carryDrafts.set(next, draft);
        }
        ctx.uiWorkspace.openSession(next);
      }
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '@', name: 'Doxvelt characters', order: -10,
        async candidates(session, { query }) {
          return castFor(session.sessionId).filter(actor => [actor.token, actor.name].some(value => value.toLowerCase().startsWith(query.toLowerCase())))
            .map(actor => ({ name: actor.token, description: actor.token === actor.name ? "Doxvelt character" : actor.name }));
        },
        onPick: ({ candidate }) => ({ text: '@' + candidate.name + ' ' }),
      }));

      function match(session, line) {
        const mode = modes.find(name => new RegExp('^/' + name + '(?:\\s|$)').test(line));
        return mode ? claim(session, mode) : undefined;
      }
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '/', name: 'Doxvelt turns', order: -10,
        async candidates(_session, { query }) {
          return modes.filter(name => name.startsWith(query)).map(name => ({ name, description: 'Doxvelt turn' }));
        },
        onPick: ({ session, candidate }) => ({ claim: claim(session, candidate.name) }),
        matchSpace: (session, token) => {
          const result = match(session, token);
          return result ? { claim: result } : undefined;
        },
        async matchEnter(session, line, _signal, envelope) {
          const result = match(session, line);
          if (!result) return undefined;
          if (envelope.attachments) throw new Error('Doxvelt turns use text only.');
          return { claim: result };
        },
        async matchClaim(session, token) { return match(session, token); },
      }));

      ctx.effect(() => ctx.uiConversation.events.register({
        kind, target: 'chat',
        match: event => event.type === 'doxvelt/played-turn' ? { id: event.data.id, role: 'start', exclusive: true } : null,
        start: (_context, match) => match.event.data,
        update: (_context, match) => match.event.data,
        buildViewNode(context) {
          if (!context.state) return null;
          return {
            key: context.key, kind, id: context.id, target: 'chat',
            anchorSeq: context.start.event.seq, location: context.start.location,
            visibility: 'visible', data: context.state,
          };
        },
      }));
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: kind },
        props => props.node.data.saved
          ? h(SavedTurn, { turn: props.node.data, sessionId: props.sessionId,
            openEpisodeSession: (selection, keepDraft) => openEpisodeSession(props.sessionId, selection, keepDraft) })
          : h(Turn, props)));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'doxvelt-routing', order: -10,
        inject: sessionId => ({ focusComposer() {
          const binding = ctx.sessions.binding(sessionId);
          if (binding) ctx.conversation.input.for(binding.ctx).focus();
        },
        openEpisodeSession: selection => openEpisodeSession(sessionId, selection) }),
      }, Routing));
    }

    return { inject: ['inputTriggers', 'uiConversation', 'slots', 'sessions', 'conversation', 'workspaces', 'uiWorkspace'], apply };
  },
});
