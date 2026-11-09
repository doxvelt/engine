window.__ModuleLoader__.load({
  id: '@doxvelt/dsh',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react');
    const { Button, Modal, SegmentedTabs } = require('@deepseek-ai/dsh-client-ui-primitives');
    const fixtureCast = ['Corin', 'Nell', 'Mara'].map(token => ({ token, name: token, canGenerate: token !== 'Corin' }));
    const casts = new Map();
    const castFor = sessionId => casts.get(sessionId) ?? fixtureCast;
    const modes = ['perform', 'generate'];
    const kind = 'doxvelt-performance';
    const defaultRoute = { mode: 'perform', character: 'Corin', audience: '!unset', audienceSyntax: 'scoped-v1' };
    const routes = new Map();
    const performDefaults = new Map();
    function performRoute(sessionId) {
      if (!performDefaults.has(sessionId)) {
        let saved;
        try { saved = JSON.parse(localStorage.getItem('doxvelt:audience-default:' + sessionId)); } catch { /* no saved default */ }
        performDefaults.set(sessionId, saved && typeof saved.audience === 'string' && typeof saved.character === 'string' &&
          ['scoped-v1', 'scoped-fallback-v1'].includes(saved.audienceSyntax) ? saved : { ...defaultRoute });
      }
      return performDefaults.get(sessionId);
    }
    const sceneListeners = new Map();
    const carryDrafts = new Map();
    const episodeSessions = new Map();
    const modeDrafts = new Map();
    function pendingPerformance(sessionId) {
      try {
        const pending = JSON.parse(localStorage.getItem('doxvelt:scoped-perform:' + sessionId));
        if (!pending || !pending.input || !pending.command) return null;
        const keys = ['mode', 'character', 'actor', 'audience', 'audienceSyntax', 'body'];
        if (Object.keys(pending.input).length !== keys.length || keys.some(key => typeof pending.input[key] !== 'string') ||
            pending.input.mode !== 'perform' || !['scoped-v1', 'scoped-fallback-v1'].includes(pending.input.audienceSyntax)) return null;
        const { requestId, expectedHead, ...input } = pending.command;
        return typeof requestId === 'string' && typeof expectedHead === 'string' && JSON.stringify(input) === JSON.stringify(pending.input) ? pending : null;
      } catch { return null; }
    }

    async function submit(sessionId, command, signal) {
      try {
        const pendingKey = 'doxvelt:scoped-perform:' + sessionId;
        if (command.mode === 'perform' && command.audienceSyntax) {
          // Persist the exact request before transmission. A response loss must
          // never append another occurrence after a default change or restart.
          const saved = localStorage.getItem(pendingKey);
          if (saved) {
            const pending = pendingPerformance(sessionId);
            if (!pending) return { kind: 'error', text: 'The saved pending performance is invalid. Keep your text and review browser recovery before submitting.' };
            if (JSON.stringify(pending.input) !== JSON.stringify(command))
              return { kind: 'error', text: 'Retry the pending performance before submitting different text or defaults. Your new text remains unsent.' };
            command = pending.command;
          } else {
            const status = await submit(sessionId, { mode: 'scene-status' }, signal);
            if (status.kind !== 'success') return status;
            const frozen = { ...command, requestId: crypto.randomUUID(), expectedHead: status.result.expectedHead };
            localStorage.setItem(pendingKey, JSON.stringify({ input: command, command: frozen }));
            command = frozen;
          }
        }
        const response = await fetch('/api/doxvelt-fixture', {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ...command }),
        });
        const result = await response.json();
        if (command.mode === 'perform' && command.audienceSyntax && (response.ok || response.status === 400 || response.status === 409)) localStorage.removeItem(pendingKey);
        if (response.ok && command.mode === 'saved') episodeSessions.set(sessionId, result.workspace ? Boolean(result.opened) : true);
        if (response.ok && result.opened?.cast) casts.set(sessionId, result.opened.cast);
        if (response.ok && ['perform', 'generate', 'correct'].includes(command.mode)) void sceneListeners.get(sessionId)?.();
        if (response.ok && ['perform', 'generate'].includes(command.mode)) modeDrafts.get(sessionId)?.delete(command.mode);
        return response.ok ? { kind: 'success', result } : { kind: 'error', status: response.status, text: result.error };
      } catch {
        return { kind: 'error', uncertain: true, text: 'The scene could not save. Try again.' };
      }
    }

    function actorChoices(cast, mode) {
      return cast.flatMap(character => {
        const { token, name, canGenerate, configurations = [] } = character;
        if (mode !== 'generate' || (canGenerate && !configurations.length)) return [{ token, character: token, name }];
        if (!canGenerate) return [];
        return configurations.map(({ key, label, profile }) => ({
          token: key === 'default' ? token : token + '#' + key,
          character: token, name: name + ' · ' + label, configuration: key, profile,
        }));
      });
    }

    function parseDraft(draft, cast, defaults) {
      if (defaults?.audienceSyntax) {
        const scoped = /^\/perform\s+@([\w-]+)(?:[ \t]|\r?\n|$)([\s\S]*)$/i.exec(draft.trimStart());
        if (scoped && !/^to\s+[^|]+\|/.test(scoped[2])) {
          const character = cast.find(actor => actor.token.toLowerCase() === scoped[1].toLowerCase())?.token;
          return { mode: 'perform', character, actor: character, audience: defaults.audience ?? '!unset',
            audienceSyntax: defaults.audienceSyntax, body: scoped[2] };
        }
      }
      const compact = /^\/(perform|generate)\s+@([\w-]+)(?:#([a-z0-9-]+))?\s+(#[\s\S]*)$/i.exec(draft.trimStart());
      if (compact) {
        const resolve = name => cast.find(actor => actor.token.toLowerCase() === name.toLowerCase())?.token;
        const mode = compact[1].toLowerCase();
        const character = resolve(compact[2]);
        const key = compact[3]?.toLowerCase();
        const actor = actorChoices(cast, mode).find(choice => choice.character === character && (!key || choice.configuration === key));
        const selections = [];
        let rest = compact[4];
        while (rest.startsWith('#')) {
          const token = /^#(?:\[([\w-]+)\]|([\w-]+)(?::([\w,-]+))?)(?=\s|$)/.exec(rest);
          if (!token) return { mode, character, actor: actor?.token, body: rest };
          selections.push({ name: token[1] ?? token[2], limit: token[3], literal: Boolean(token[1]) });
          const following = rest.slice(token[0].length);
          const another = /^[ \t]+#/.test(following);
          rest = another ? following.trimStart() : following.replace(/^[ \t]/, '');
          if (!another) break;
        }
        let audience;
        const single = selections.length === 1 && selections[0];
        if (single && !single.literal && /^(all|self)$/i.test(single.name) && !single.limit) audience = '!' + single.name.toLowerCase();
        else if (single && !single.literal && /^actor$/i.test(single.name) && mode === 'generate') {
          const limit = single.limit?.split(',').map(resolve);
          if (!limit) audience = '!actor';
          else if (limit.every(token => token && token !== character)) audience = '!actor:' + [...new Set(limit)].join(',');
        } else {
          const recipients = selections.map(item => !item.limit && resolve(item.name));
          if (recipients.length && recipients.every(Boolean)) {
            const others = cast.filter(actor => actor.token !== character && recipients.includes(actor.token)).map(actor => actor.token);
            audience = others.length ? others.join(',') : '!self';
          }
        }
        return { mode, character, actor: actor?.token, actorConfiguration: actor?.configuration, audience, body: rest };
      }
      // Keep unsent drafts from the earlier web prototype readable.
      const match = /^\/(perform|generate)\s+@([\w-]+)(?:#([a-z0-9-]+))?\s+to\s+([^|]+)\|\s*([\s\S]*)$/i.exec(draft.trimStart());
      if (!match) return undefined;
      const resolve = name => cast.find(actor => actor.token.toLowerCase() === name.toLowerCase())?.token;
      const mode = match[1].toLowerCase();
      const character = resolve(match[2]);
      const key = match[3]?.toLowerCase();
      const actor = actorChoices(cast, mode).find(choice => choice.character === character && (!key || choice.configuration === key));
      const direction = match[4].trim();
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
      return { mode, character, actor: actor?.token, actorConfiguration: actor?.configuration, audience, body: match[5] };
    }

    function claim(session, mode) {
      return {
        name: mode,
        token: '/' + mode + ' ',
        submit(args) {
          const command = parseDraft('/' + mode + ' ' + args, castFor(session.sessionId), mode === 'perform' ? performRoute(session.sessionId) : undefined);
          if (!command?.actor || !command.audience) {
            return Promise.resolve({ kind: 'error', text: 'Choose a valid actor and audience, such as @Corin #Mara or @Corin #all, followed by your words.' });
          }
          return submit(session.sessionId, command);
        },
      };
    }

    function formatDraft({ mode, character, actor, audience, audienceSyntax, body = '' }) {
      if (mode === 'perform' && audienceSyntax) return '/perform @' + character + ' ' + body;
      const recipients = audience.startsWith('!actor:') ? '#actor:' + audience.slice(7)
        : audience.startsWith('!') ? '#' + audience.slice(1) : audience.split(',').map(token => /^(all|self|actor)$/i.test(token) ? '#[' + token + ']' : '#' + token).join(' ');
      return '/' + mode + ' @' + (mode === 'generate' ? actor : character) + ' ' + recipients + ' ' + body;
    }

    function supportedRoute(values, cast) {
      if (values.mode === 'generate' && !cast.some(actor => actor.canGenerate)) values.mode = 'perform';
      const eligible = actorChoices(cast, values.mode);
      const selected = eligible.find(item => item.character === values.character && item.token === values.actor)
        ?? eligible.find(item => item.character === values.character) ?? eligible[0];
      values.character = selected?.character;
      values.actor = selected?.token;
      const delegated = values.audience === '!actor' || values.audience?.startsWith('!actor:');
      if (values.mode === 'generate' && values.audience === '!unset') values.audience = '!actor';
      if (!values.audience || (delegated && values.mode === 'perform')) values.audience = values.mode === 'perform' ? '!unset' : '!actor';
      else if (!['!all', '!self', '!actor', '!unset'].includes(values.audience)) {
        const selected = (delegated ? values.audience.slice(7) : values.audience).split(',');
        const recipients = cast.filter(actor => actor.token !== values.character && selected.includes(actor.token));
        const group = recipients.map(actor => actor.token).join(',');
        values.audience = values.mode === 'perform' && selected.some(token => !cast.some(actor => actor.token === token)) ? '!unset'
          : group ? (delegated ? '!actor:' : '') + group : '!self';
      }
      if (values.mode === 'perform') values.audienceSyntax ??= 'scoped-v1';
      else delete values.audienceSyntax;
      return values;
    }

    function Routing({ sessionId, useSession, useInput, inputActions, getInputSnapshot, focusComposer, openEpisodeSession }) {
      const draft = useInput(state => state.draft);
      const phase = useInput(state => state.phase);
      const openState = useSession(state => state.openState);
      const cast = castFor(sessionId);
      const composerRoute = supportedRoute({ ...performRoute(sessionId) }, cast);
      const command = parseDraft(draft, cast, composerRoute);
      const busy = phase === 'submitting' || phase === 'sending' || phase === 'adjudicating';
      const [saved, setSaved] = useState({ workspace: { loading: true }, simulations: [], opened: null, branches: [], episodes: [] });
      const [opening, setOpening] = useState(false);
      const [error, setError] = useState('');
      const restorationFrame = useRef(null);

      function restoreDraft(route, span) {
        // Lexical can accept two inserts before publishing either revision.
        // Coalesce route/caret restoration into one write, with carried prose first.
        if (restorationFrame.current !== null) cancelAnimationFrame(restorationFrame.current);
        const frame = requestAnimationFrame(() => {
          restorationFrame.current = null;
          const latest = getInputSnapshot();
          if (!latest || latest.draft !== draft || ['submitting', 'sending', 'adjudicating'].includes(latest.phase)) return;
          const carried = carryDrafts.get(sessionId);
          const next = carried ?? formatDraft(route);
          if (inputActions.insertText(next, span)) {
            if (carried) carryDrafts.delete(sessionId);
            if (document.activeElement === document.body) focusComposer();
          }
        });
        restorationFrame.current = frame;
        return () => {
          cancelAnimationFrame(frame);
          if (restorationFrame.current === frame) restorationFrame.current = null;
        };
      }

      useEffect(() => {
        if (openState !== 'open') return;
        let current = true;
        void submit(sessionId, { mode: 'saved' }).then(outcome => {
          if (!current) return;
          if (outcome.kind === 'success') setSaved(outcome.result);
          else setError(outcome.text);
        });
        return () => { current = false; };
      }, [openState, sessionId]);

      useEffect(() => {
        if (command?.actor && command.audience) {
          const { mode, character, actor, audience } = command;
          if (!command.audienceSyntax) routes.set(sessionId, { mode, character, actor, audience });
          else if (!routes.has(sessionId)) routes.set(sessionId, composerRoute);
        } else if (!draft && !busy && openState === 'open' && (!saved.workspace || saved.opened)) {
          // Let the stock composer restore focus after its submit transaction first.
          const selection = inputActions.captureInsertion();
          const route = supportedRoute({ ...(routes.get(sessionId) ?? defaultRoute) }, cast);
          if (route.character && route.audience) return restoreDraft(route, selection);
        }
      }, [draft, busy, openState, sessionId, inputActions, cast, saved.opened, saved.workspace]);

      useEffect(() => {
        if (!saved.opened || (command?.body ?? draft).trim()) return;
        // Opening history can remount the stock editor. Place its caret after the route in the new view.
        const span = { ...inputActions.captureInsertion(), start: 0, end: draft.length };
        const route = supportedRoute({ ...(routes.get(sessionId) ?? defaultRoute), ...command }, cast);
        if (!route.character || !route.audience) return;
        return restoreDraft(route, span);
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
        let values = { ...defaultRoute, body: draft, ...command, ...change };
        if (change.mode && command?.mode && change.mode !== command.mode) {
          let buffers = modeDrafts.get(sessionId);
          if (!buffers) modeDrafts.set(sessionId, buffers = new Map());
          buffers.set(command.mode, { ...command });
          values = buffers.get(change.mode) ?? { ...values, body: '' };
          if (change.mode === 'perform') values = { ...composerRoute, ...values, audience: composerRoute.audience, audienceSyntax: composerRoute.audienceSyntax, mode: 'perform' };
        }
        const route = supportedRoute(values, cast);
        if (route.mode === 'perform') {
          const next = supportedRoute({ ...composerRoute, ...change, mode: 'perform' }, cast);
          performDefaults.set(sessionId, next); routes.set(sessionId, next);
          try { localStorage.setItem('doxvelt:audience-default:' + sessionId, JSON.stringify(next)); } catch { /* explicit in-memory selection remains visible */ }
        }
        if (route.character && route.audience) inputActions.setDraft(formatDraft(route));
      }
      function select(label, value, options, onChange, displayName) {
        const labels = { '!all': 'Everyone', '!self': 'Only self', '!actor': 'Actor chooses', '!unset': 'No default selected' };
        const optionLabel = option => label === 'Audience limit' && option === '!all' ? 'No limit'
          : (Object.hasOwn(labels, option) ? labels[option] : undefined) ?? option.split(',').map(token => cast.find(actor => actor.token === token)?.name ?? token).join(' + ');
        if (options.length === 2) return h(SegmentedTabs, { label, value: value ?? '',
          onChange: next => { if (!busy && !opening) onChange(next); },
          items: options.map(option => ({ value: option, label: displayName?.(option) ?? optionLabel(option), disabled: busy || opening })) });
        return h('label', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, label, ' ',
          h('select', { 'aria-label': label, value: value ?? '', disabled: busy || opening, style: { font: 'inherit' },
            onChange: event => onChange(event.target.value) },
            h('option', { value: '', disabled: true }, 'Choose'),
            options.map(option => h('option', { value: option, key: option }, displayName?.(option) ?? optionLabel(option)))));
      }

      const unsent = Boolean((command?.body ?? draft).trim());
      const pending = pendingPerformance(sessionId);
      if (saved.workspace && !saved.opened) return h('div', { style: { padding: '0 8px 8px', fontSize: 13 } },
        saved.workspace.loading ? (error && h('span', { role: 'alert' }, error))
          : !saved.workspace.active ? h(Button, { size: 'sm', variant: 'outline', disabled: opening || busy,
            onClick: async () => {
              setOpening(true);
              const result = await submit(sessionId, { mode: 'workspace-activate' });
              if (result.kind === 'success') {
                const state = await submit(sessionId, { mode: 'saved' });
                if (state.kind === 'success') setSaved(state.result); else setError(state.text);
              } else setError(result.text);
              setOpening(false);
            } }, opening ? 'Activating Doxvelt…' : 'Activate Doxvelt for this workspace')
          : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            h(WorkspaceTools, { sessionId, busy: busy || opening, unsent,
              onChanged: async () => { const state = await submit(sessionId, { mode: 'saved' }); if (state.kind === 'success') setSaved(state.result); },
              onCreated: selection => openEpisodeSession(selection) }),
            h('select', { 'aria-label': 'Saved episode', value: '', disabled: opening || busy || unsent,
              style: { font: 'inherit' }, onChange: event => { void openSaved(event.target.value); } },
              h('option', { value: '', disabled: true }, 'Continue a saved story'),
              saved.simulations.map(item => h('option', { key: item.simulationId, value: item.simulationId }, item.scenarioName ?? item.simulationId)))),
        !saved.workspace.loading && error && h('p', { role: 'alert' }, error));
      const available = actorChoices(cast, command?.mode);
      const recipients = cast.filter(actor => actor.token !== command?.character).map(actor => actor.token);
      const groups = recipients.length <= 4
        ? recipients.flatMap((first, index) => recipients.slice(index + 1).map(second => first + ',' + second))
        : [];
      const audience = command?.audienceSyntax ? composerRoute.audience : command?.audience?.startsWith('!actor:') ? '!actor' : command?.audience;
      const limit = command?.audience?.startsWith('!actor:') ? command.audience.slice(7) : '!all';
      const fixed = ['!unset', '!all', '!self', ...recipients, ...groups];
      const limits = ['!all', ...recipients, ...groups];
      if (audience && audience !== '!actor' && !fixed.includes(audience)) fixed.push(audience);
      if (!limits.includes(limit)) limits.push(limit);
      return h('div', { 'aria-label': 'Doxvelt routing', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '0 8px 8px', width: '100%', margin: '0 auto',
        maxWidth: 'var(--dsh-composer-card-max-width, 712px)', boxSizing: 'border-box', fontSize: 13 } },
        h(SegmentedTabs, { label: 'Action', value: command?.mode ?? 'perform',
          onChange: mode => { if (!busy && !opening) update({ mode }); },
          items: (cast.some(actor => actor.canGenerate) ? modes : ['perform']).map(mode => ({
            value: mode, label: mode === 'perform' ? 'Perform' : 'Generate', disabled: busy || opening,
          })) }),
        select(command?.mode === 'generate' ? 'Actor' : 'Character', command?.audienceSyntax ? composerRoute.actor : command?.actor, available.map(item => item.token), actor => {
          update({ actor, character: available.find(item => item.token === actor).character });
        }, token => available.find(item => item.token === token)?.name),
        select(command?.mode === 'perform' ? 'Default audience' : 'Audience', audience, command?.mode === 'generate' ? [...fixed.filter(item => item !== '!unset'), '!actor'] : fixed, audience => update({ audience })),
        command?.mode === 'perform' && h('label', null, h('input', { type: 'checkbox', checked: composerRoute.audienceSyntax === 'scoped-fallback-v1',
          disabled: busy || opening, onChange: event => update({ audienceSyntax: event.target.checked ? 'scoped-fallback-v1' : 'scoped-v1' }) }), ' Proposed observer fallbacks'),
        command?.mode === 'perform' && h('small', null, '#Mara,Nell sets this turn; #Mara(text) scopes a span. The default stays unchanged.'),
        pending && h('button', { type: 'button', disabled: busy || opening, onClick: async () => {
          const outcome = await submit(sessionId, pending.input);
          if (outcome.kind !== 'success') setError(outcome.text); else setError('');
        } }, 'Retry pending performance'),
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
        saved.workspace?.active && h(WorkspaceTools, { sessionId, busy: busy || opening, unsent,
          onChanged: async () => { const state = await submit(sessionId, { mode: 'saved' }); if (state.kind === 'success') setSaved(state.result); },
          onCreated: selection => openEpisodeSession(selection) }),
        saved.workspace?.active && saved.opened && !saved.opened.episodeId && h(SceneControls, { sessionId, busy: busy || opening }),
        error && h('span', { role: 'alert' }, error),
        saved.opened && h(MemoryControls, { sessionId, busy, unsent,
          memoryConfigured: saved.workspace ? saved.workspace.memoryConfigured : true,
          openNextEpisode: () => openEpisodeSession({ simulationId: saved.opened.simulationId, branchId: saved.opened.branchId }) }));
    }

    function WorkspaceTools({ sessionId, busy, unsent, onCreated, onChanged }) {
      const [view, setView] = useState(null);
      const [collection, setCollection] = useState(null);
      const [object, setObject] = useState(null);
      const [source, setSource] = useState(null);
      const [setup, setSetup] = useState({ worldId: '', scenarioId: '', formatId: '', characterIds: [], date: '' });
      const [working, setWorking] = useState(false);
      const [error, setError] = useState('');
      const [created, setCreated] = useState(null);
      const [models, setModels] = useState([]);
      const operation = useRef(null);
      async function load() {
        const result = await submit(sessionId, { mode: 'collection' });
        if (result.kind !== 'success') throw new Error(result.text);
        setCollection(result.result);
        return result.result;
      }
      async function open(next) {
        setView(next); setCollection(null); setError(''); setWorking(true); setObject(null); setSource(null); setCreated(null);
        operation.current = null;
        try {
          if (next === 'models') {
            const data = check(await submit(sessionId, { mode: 'workspace-models' }));
            setModels(data.models); setCollection(data); return;
          }
          const data = await load();
          setSetup({ worldId: data.worlds[0]?.id ?? '', scenarioId: data.scenarios[0]?.id ?? '',
            formatId: data.formats[0]?.id ?? '', characterIds: data.characters.map(item => item.id), date: '' });
        } catch (error) { setError(error.message); }
        finally { setWorking(false); }
      }
      function change(values) { operation.current = null; setSetup(previous => ({ ...previous, ...values })); }
      async function perform(action) {
        setWorking(true); setError('');
        try { await action(); } catch (error) { setError(error.message); }
        finally { setWorking(false); }
      }
      function check(result) { if (result.kind !== 'success') throw new Error(result.text); return result.result; }
      function newObject(kind) { setSource(null); setObject({ kind, name: '', id: '', body: '' }); setError(''); }
      const kindNames = { world: 'world', scenario: 'scenario', character: 'character', format: 'format' };
      const fieldStyle = { display: 'grid', gap: 4, marginBottom: 12 };
      function field(label, value, onChange, type = 'text') {
        return h('label', { style: fieldStyle }, label, h('input', { 'aria-label': label, value, type,
          disabled: working, onChange: event => onChange(event.target.value), style: { font: 'inherit', padding: 6 } }));
      }
      function choose(kind, items, key) {
        return h('div', { style: { display: 'flex', gap: 8, marginBottom: 12, alignItems: 'end' } },
          h('label', { style: { ...fieldStyle, flex: 1, marginBottom: 0 } }, kind[0].toUpperCase() + kind.slice(1),
            items.length === 2 ? h(SegmentedTabs, { label: 'Episode ' + kind, value: setup[key],
              onChange: value => { if (!working) change({ [key]: value }); },
              items: items.map(item => ({ value: item.id, label: item.name, disabled: working })) })
            : h('select', { 'aria-label': 'Episode ' + kind, value: setup[key], disabled: working,
              onChange: event => change({ [key]: event.target.value }), style: { font: 'inherit', padding: 6 } },
              h('option', { value: '', disabled: true }, 'Choose ' + kind),
              items.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h(Button, { size: 'sm', variant: 'outline', disabled: working, onClick: () => newObject(kind) }, 'New ' + kind + '…'));
      }
      function modelChoice(label, key, emptyLabel) {
        return h('label', { style: fieldStyle }, label,
          h('select', { 'aria-label': label, value: JSON.stringify(collection.configuration[key] ?? null), disabled: working,
            onChange: event => setCollection({ ...collection, configuration: { ...collection.configuration, [key]: JSON.parse(event.target.value) ?? undefined } }),
            style: { font: 'inherit', padding: 6 } },
            h('option', { value: 'null' }, emptyLabel),
            models.map(model => h('option', { key: model.provider + ':' + model.model, value: JSON.stringify({ provider: model.provider, model: model.model }) }, model.label))));
      }
      const title = object ? 'New ' + kindNames[object.kind] : source ? 'Edit source' : view === 'models' ? 'Doxvelt models' : view === 'episode' ? 'Create episode' : 'Workspace collection';
      return h('div', { style: { display: 'flex', gap: 8, fontSize: 13 } },
        h(Button, { size: 'sm', variant: 'outline', disabled: busy || unsent, onClick: () => { void open('episode'); } }, 'New episode'),
        h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => { void open('library'); } }, 'Collection'),
        h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => { void open('models'); } }, 'Models'),
        h(Modal, { open: Boolean(view), title, closeLabel: 'Close Doxvelt setup', onClose: () => { if (!working) setView(null); } },
          h('div', { style: { fontSize: 13, maxHeight: '65vh', overflowY: 'auto' } },
            error && h('p', { role: 'alert' }, error),
            working && h('p', { role: 'status' }, 'Saving or loading…'),
            view === 'models' ? collection?.configuration && h('form', { onSubmit: event => {
              event.preventDefault(); void perform(async () => {
                check(await submit(sessionId, { mode: 'workspace-save-models', configuration: collection.configuration, expectedRevision: collection.configurationRevision }));
                await onChanged(); setView(null);
              });
            } },
              h('p', null, 'Choose models already configured in DSH. Provider connections and credentials remain in the harness.'),
              modelChoice('Character generation', 'actorModel', 'Manual play only'),
              modelChoice('Memory reflection', 'reflectionModel', 'Use character generation model'),
              h(Button, { type: 'submit', variant: 'primary', disabled: working }, 'Save model choices'))
            : object ? h('form', { onSubmit: event => {
              event.preventDefault(); void perform(async () => {
                check(await submit(sessionId, { mode: 'collection-create', object }));
                await load();
                const key = { world: 'worldId', scenario: 'scenarioId', format: 'formatId' }[object.kind];
                if (key) change({ [key]: object.id });
                else change({ characterIds: [...setup.characterIds, object.id] });
                setObject(null);
              });
            } },
              field('Name', object.name, name => setObject({ ...object, name,
                id: name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) })),
              field('Object ID', object.id, id => setObject({ ...object, id })),
              h('label', { style: fieldStyle }, 'Description (Markdown)', h('textarea', { 'aria-label': 'Description (Markdown)', rows: 8,
                value: object.body, disabled: working, onChange: event => setObject({ ...object, body: event.target.value }), style: { width: '100%', font: 'inherit' } })),
              object.kind === 'character' && h('p', null, 'Use :+3 at the end of a line for something this character takes as true, or :+1 for a suspicion.'),
              h(Button, { type: 'submit', disabled: working || !object.name.trim() || !object.id, variant: 'primary' }, 'Create ' + object.kind),
              h(Button, { type: 'button', variant: 'outline', disabled: working, onClick: () => setObject(null) }, 'Back'))
            : source ? h('form', { onSubmit: event => {
              event.preventDefault(); void perform(async () => {
                check(await submit(sessionId, { mode: 'collection-save', source: { path: source.path, text: source.text, expectedRevision: source.revision } }));
                await load(); setSource(null);
              });
            } }, h('p', null, source.path),
              h('textarea', { 'aria-label': 'Source Markdown', rows: 14, value: source.text, disabled: working,
                onChange: event => setSource({ ...source, text: event.target.value }), style: { width: '100%', font: 'inherit' } }),
              h('p', null, 'Changes apply when starting a new story. Existing stories keep their pinned source.'),
              h(Button, { type: 'submit', disabled: working, variant: 'primary' }, 'Save source'),
              h(Button, { type: 'button', disabled: working, variant: 'outline', onClick: () => setSource(null) }, 'Back'))
            : view && collection && (view === 'episode' ? h('form', { onSubmit: event => {
              event.preventDefault(); void perform(async () => {
                operation.current ??= crypto.randomUUID();
                const result = check(await submit(sessionId, { mode: 'create-story', setup: {
                  ...setup, operationId: operation.current, collectionRevision: collection.revision,
                } }));
                if (result.status === 'partial') { setCreated(result); setError(result.message); }
                else { await onCreated(result); setView(null); }
              });
            } },
              h('p', null, 'Start a new story from this workspace collection. Each story keeps its own history and memories.'),
              choose('world', collection.worlds, 'worldId'), choose('scenario', collection.scenarios, 'scenarioId'),
              choose('format', collection.formats, 'formatId'),
              h('fieldset', { disabled: working, style: { marginBottom: 12 } }, h('legend', null, 'Characters'),
                collection.characters.map(character => h('label', { key: character.id, style: { display: 'block' } },
                  h('input', { type: 'checkbox', checked: setup.characterIds.includes(character.id),
                    onChange: event => change({ characterIds: event.target.checked ? [...setup.characterIds, character.id] : setup.characterIds.filter(id => id !== character.id) }) }), character.name)),
                h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => newObject('character') }, 'New character…')),
              field('Episode date', setup.date, date => change({ date }), 'date'),
              created ? h(Button, { type: 'button', onClick: () => { void onCreated(created); } }, 'Open saved story')
                : h(Button, { type: 'submit', variant: 'primary', disabled: working || !setup.worldId || !setup.scenarioId || !setup.formatId || !setup.characterIds.length || !setup.date }, 'Create episode'))
            : h('div', null,
              h('p', null, 'Objects are Markdown files in this workspace. You can edit them here, directly, or with the harness.'),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 } },
                Object.keys(kindNames).map(kind => h(Button, { key: kind, size: 'sm', variant: 'outline', disabled: working,
                  onClick: () => newObject(kind) }, 'New ' + kind + '…'))),
              collection.files.length === 0 && h('p', null, 'Your collection is empty. Create an object here or while setting up an episode.'),
              collection.files.map(file => h('div', { key: file.path }, h(Button, { variant: 'outline', size: 'sm', disabled: working,
                onClick: () => { void perform(async () => {
                  const result = check(await submit(sessionId, { mode: 'collection-read', path: file.path }));
                  setSource({ path: file.path, text: result.text, revision: file.revision });
                }); } }, file.path))))))));
    }

    function SceneControls({ sessionId, busy }) {
      const [open, setOpen] = useState(false);
      const [title, setTitle] = useState('');
      const [basis, setBasis] = useState(null);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const command = useRef(null);
      return h('div', null,
        h(Button, { size: 'sm', variant: 'outline', disabled: busy || saving, onClick: async () => {
          setOpen(true); setError(''); setBasis(null); setTitle(''); command.current = null;
          const result = await submit(sessionId, { mode: 'scene-status' });
          if (result.kind === 'success') setBasis(result.result.expectedHead); else setError(result.text);
        } }, 'New scene'),
        h(Modal, { open, title: 'New scene', closeLabel: 'Close scene heading', onClose: () => { if (!saving) setOpen(false); } },
          h('form', { style: { fontSize: 13 }, onSubmit: async event => {
            event.preventDefault(); setSaving(true); setError(''); command.current ??= crypto.randomUUID();
            const result = await submit(sessionId, { mode: 'scene-create', expectedHead: basis, commandId: command.current, title });
            if (result.kind === 'success') setOpen(false); else setError(result.text);
            setSaving(false);
          } },
            h('p', null, 'A scene heading organizes the transcript. It does not tell characters anything or change their memories.'),
            h('label', { style: { display: 'grid', gap: 4, marginBottom: 12 } }, 'Scene heading',
              h('input', { 'aria-label': 'Scene heading', value: title, maxLength: 160, disabled: saving,
                onChange: event => { setTitle(event.target.value); command.current = null; }, style: { font: 'inherit', padding: 6 } })),
            error && h('p', { role: 'alert' }, error),
            h(Button, { type: 'submit', variant: 'primary', disabled: saving || !basis || !title.trim() }, 'Add scene heading'))));
    }

    function MemoryControls({ sessionId, busy, openNextEpisode, unsent, memoryConfigured }) {
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
            h(Button, { variant: 'primary', disabled: locked || !episode.date || !episode.canMemorize || !memoryConfigured,
              onClick: () => { void perform('memory-memorize', {}); } }, episode.status === 'unmemorized' ? 'Memorize' : 'Memorize again'),
            action === 'memory-memorize' && h(Button, { variant: 'outline',
              onClick: () => operation.current?.abort() }, 'Cancel memorization'),
            h(Button, { variant: 'outline', disabled: locked || state.ended || unsent || !current.canMemorize,
              onClick: () => { void perform('memory-next', { label: current.label }); } }, 'End and open next episode'),
            state.ended && h(Button, { variant: 'outline', onClick: () => { void openNext(); } }, 'Open current episode')),
          action === 'memory-memorize' && h('p', { role: 'status' }, 'Forming memories…'),
          !memoryConfigured && h('p', null, 'Choose a reflection model in Models before memorizing.'),
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
          const { cast, actor, actorProfile, audience, whisper, version, body, expectedHead, next } = result.result;
          const eligible = actorChoices(cast, 'generate');
          const preferred = action === 'generate' ? actor : next?.actor;
          const recorded = action === 'generate' ? actorProfile : next?.actorProfile;
          const selected = recorded
            ? eligible.find(item => item.character === preferred && item.profile?.id === recorded.id && item.profile?.version === recorded.version)
            : eligible.find(item => item.character === preferred) ?? eligible[0];
          const character = selected?.character ?? preferred ?? '';
          const recipients = action === 'generate' ? audience : next?.audience ?? null;
          setForm({ eligible, cast, speaker: actor, editedAudience: audience, originalActor: actor, originalAudience: audience,
            actor: selected?.token ?? '', actorConfiguration: selected?.configuration, unavailable: Boolean(recorded && !selected),
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
        const routing = { character: form.character, actorConfiguration: form.actorConfiguration, audience: form.audience, whisper: form.whisper,
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
          !character && h('option', { value: '', disabled: true }, 'Choose an actor'),
          options.map(actor => h('option', { key: actor.token, value: actor.token }, actor.name))));
      }

      function audienceSelect(label, character, audience, disabled, onChange, onLimit) {
        const selected = audience ?? (onLimit ? form.audienceLimit : null) ?? [];
        return h('fieldset', { disabled, 'aria-label': label },
          h('legend', null, label),
          onLimit && h('label', null, h('input', { type: 'checkbox', checked: audience === null,
            onChange: event => onChange(event.target.checked ? null : selected) }), ' Actor chooses'),
          !onLimit && audience === null && h('button', { type: 'button', onClick: () => onChange([]) }, 'Use actor-only base'),
          ...form.cast.filter(item => item.token !== character).map(item => h('label', { key: item.token, style: { marginLeft: 8 } },
            h('input', { type: 'checkbox', checked: selected.includes(item.token),
              onChange: event => {
                const recipients = event.target.checked ? [...selected, item.token] : selected.filter(value => value !== item.token);
                (audience === null && onLimit ? onLimit : onChange)(recipients);
              } }),
            ' ', item.name)),
          audience === null && h('small', { style: { display: 'block' } },
            !onLimit ? 'No base selected. Shared text needs a turn audience or an explicit base selection.'
              : selected.length ? 'The actor can choose among the checked characters.' : 'No limit. Check characters to limit the choice.'));
      }

      function generationFields(prefix) {
        const locked = busy || retry === 'check';
        return [
          characterSelect(prefix + ' actor', form.actor, form.eligible, locked, actor => {
            const { character, configuration } = form.eligible.find(item => item.token === actor);
            update({ actor, character, actorConfiguration: configuration, unavailable: false,
              audience: form.audience?.filter(item => item !== character) ?? null,
              audienceLimit: form.audienceLimit?.filter(item => item !== character) });
          }),
          form.unavailable && h('p', { role: 'status' }, 'The original actor configuration is unavailable. Choose an actor to generate.'),
          audienceSelect(prefix + ' audience', form.character, form.audience, locked,
            audience => update({ audience, audienceLimit: undefined }), audienceLimit => update({ audienceLimit })),
          h('label', null, prefix + ' stage whisper', h('textarea', { style: { display: 'block', width: '100%' },
            'aria-label': prefix + ' stage whisper', value: form.whisper, disabled: locked, onChange: event => update({ whisper: event.target.value }) })),
        ];
      }

      const editLocked = busy || Boolean(retry);
      const routingChanged = form && (form.speaker !== form.originalActor ||
        (form.editedAudience === null || form.originalAudience === null ? form.editedAudience !== form.originalAudience
          : form.editedAudience.length !== form.originalAudience.length || form.editedAudience.some(item => !form.originalAudience.includes(item))));
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
              speaker => update({ speaker, editedAudience: form.editedAudience?.filter(item => item !== speaker) ?? null })),
            audienceSelect('Edited audience', form.speaker, form.editedAudience, editLocked,
              editedAudience => update({ editedAudience })),
            form.eligible.length > 0 && h('details', { open: retry || form.unavailable ? true : undefined },
              h('summary', null, 'Next turn direction'),
              h('div', { style: { display: 'grid', gap: 8, marginTop: 8 } }, ...generationFields('Next'))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h(Button, { type: 'submit', variant: routingChanged ? 'outline' : 'primary', disabled: editLocked || !validText || routingChanged || form.body.trim() === turn.body }, 'Save correction'),
              h(Button, { type: 'button', variant: routingChanged ? 'primary' : 'outline', disabled: busy || !validText || !form.actor,
                onClick: () => { void save('next'); } }, retry === 'next' ? 'Retry next turn'
                : retry === 'check' ? 'Check next turn' : 'Save & generate next turn'))),
          form && !savedPath && mode === 'generate' && h('form', {
            onSubmit: event => { event.preventDefault(); if (!busy && form.actor) void save('generate'); },
            style: { display: 'grid', gap: 8 },
          },
            ...generationFields('Revision'),
            h(Button, { type: 'submit', variant: 'primary', disabled: busy || !form.actor }, 'Generate and open new path')),
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

    function projectedTurn(event) {
      if (event.type !== 'command/done' || !event.data.commandId.startsWith('doxvelt:played-turn:')) return null;
      return JSON.parse(event.data.text);
    }

    function apply(ctx) {
      async function openEpisodeSession(sessionId, selection, keepDraft) {
        const workspaceId = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))?.workspaceId;
        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
        const next = await ctx.sessions.create(workspaceId ? { workspaceId } : { cwd });
        const result = await submit(next, { mode: 'open-saved', ...selection });
        if (result.kind !== 'success') throw new Error(result.text);
        routes.set(next, { ...defaultRoute }); performDefaults.set(next, { ...defaultRoute });
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
          if (episodeSessions.get(session.sessionId) !== true) return [];
          return castFor(session.sessionId).filter(actor => [actor.token, actor.name].some(value => value.toLowerCase().startsWith(query.toLowerCase())))
            .map(actor => ({ name: actor.token, description: actor.token === actor.name ? "Doxvelt character" : actor.name }));
        },
        onPick: ({ candidate }) => ({ text: '@' + candidate.name + ' ' }),
      }));

      function match(session, line) {
        if (episodeSessions.get(session.sessionId) !== true) return undefined;
        const mode = modes.find(name => new RegExp('^/' + name + '(?:\\s|$)').test(line));
        return mode ? claim(session, mode) : undefined;
      }
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '/', name: 'Doxvelt turns', order: -10,
        async candidates(session, { query }) {
          if (episodeSessions.get(session.sessionId) !== true) return [];
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
        match(event) {
          if (!['command/run', 'command/done'].includes(event.type) || !event.data.commandId.startsWith('doxvelt:')) return null;
          const row = projectedTurn(event);
          return { id: row?.id ?? event.data.commandId, role: 'start', exclusive: true };
        },
        start: (_context, match) => projectedTurn(match.event),
        update: (_context, match) => projectedTurn(match.event),
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
        props => props.node.data.sceneHeading ? h('h3', { 'data-doxvelt-scene': props.node.data.id,
          style: { fontSize: 'inherit', margin: '16px 0 8px', fontWeight: 600 } }, props.node.data.title)
          : props.node.data.saved
          ? h(SavedTurn, { turn: props.node.data, sessionId: props.sessionId,
            openEpisodeSession: (selection, keepDraft) => openEpisodeSession(props.sessionId, selection, keepDraft) })
          : h(Turn, props)));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'doxvelt-routing', order: -10,
        inject: sessionId => ({ getInputSnapshot() {
          const binding = ctx.sessions.binding(sessionId);
          return binding && ctx.conversation.input.for(binding.ctx).snapshot;
        },
        focusComposer() {
          const binding = ctx.sessions.binding(sessionId);
          if (binding) ctx.conversation.input.for(binding.ctx).focus();
        },
        openEpisodeSession: selection => openEpisodeSession(sessionId, selection) }),
      }, Routing));
    }

    return { inject: ['inputTriggers', 'uiConversation', 'slots', 'sessions', 'conversation', 'workspaces', 'uiWorkspace'], apply, parseDraft, formatDraft };
  },
});
