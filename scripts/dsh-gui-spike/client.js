window.__ModuleLoader__.load({
  id: '@doxvelt/dsh-gui-spike',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react');
    const cast = ['Corin', 'Nell', 'Mara'];
    const modes = ['perform', 'generate'];
    const kind = 'doxvelt-performance';
    const defaultRoute = { mode: 'perform', character: 'Corin', audience: 'Nell' };
    const routes = new Map();

    async function submit(sessionId, command) {
      try {
        const response = await fetch('/api/doxvelt-fixture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ...command }),
        });
        const result = await response.json();
        return response.ok ? { kind: 'success', result } : { kind: 'error', text: result.error };
      } catch {
        return { kind: 'error', text: 'The scene could not save. Try again.' };
      }
    }

    function parseDraft(draft) {
      const match = /^\/(perform|generate)\s+@(\w+)\s+to\s+(@\w+|actor)\s*\|\s*([\s\S]*)$/i.exec(draft.trimStart());
      if (!match) return undefined;
      const resolve = name => cast.find(character => character.toLowerCase() === name.toLowerCase());
      return {
        mode: match[1].toLowerCase(),
        character: resolve(match[2]),
        audience: match[3].toLowerCase() === 'actor' ? 'actor' : resolve(match[3].slice(1)),
        body: match[4],
      };
    }

    function claim(session, mode) {
      return {
        name: mode,
        token: '/' + mode + ' ',
        submit(args) {
          const command = parseDraft('/' + mode + ' ' + args);
          if (!command?.character || !command.audience) {
            return Promise.resolve({ kind: 'error', text: 'Use /perform @Corin to @Nell | your performance.' });
          }
          return submit(session.sessionId, command);
        },
      };
    }

    function formatDraft({ mode, character, audience, body = '' }) {
      const recipients = audience === 'actor' ? 'actor' : '@' + audience;
      return '/' + mode + ' @' + character + ' to ' + recipients + ' | ' + body;
    }

    function Routing({ sessionId, useSession, useInput, inputActions, focusComposer }) {
      const draft = useInput(state => state.draft);
      const phase = useInput(state => state.phase);
      const openState = useSession(state => state.openState);
      const command = parseDraft(draft);
      const busy = phase === 'submitting' || phase === 'sending' || phase === 'adjudicating';
      const [saved, setSaved] = useState({ simulations: [], opened: null });
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
            inputActions.insertText(formatDraft(routes.get(sessionId) ?? defaultRoute), selection);
          });
          return () => cancelAnimationFrame(frame);
        }
      }, [draft, busy, openState, sessionId, inputActions]);

      useEffect(() => {
        if (!saved.opened || !command || command.body.trim()) return;
        // Opening history can remount the stock editor. Place its caret after the route in the new view.
        const span = { ...inputActions.captureInsertion(), start: 0, end: draft.length };
        const next = formatDraft(command.mode === 'perform' ? command : defaultRoute);
        const frame = requestAnimationFrame(() => {
          if (inputActions.insertText(next, span) && document.activeElement === document.body) focusComposer();
        });
        return () => cancelAnimationFrame(frame);
      }, [saved.opened, sessionId, inputActions]);

      async function openSaved(simulationId) {
        setOpening(true);
        setError('');
        const outcome = await submit(sessionId, { mode: 'open-saved', simulationId });
        if (outcome.kind === 'success') setSaved(previous => ({ ...previous, opened: outcome.result.opened }));
        else setError(outcome.text);
        setOpening(false);
      }

      function update(change) {
        const values = { ...defaultRoute, body: draft, ...command, ...change };
        if (values.mode === 'generate' && values.character === 'Corin') values.character = 'Nell';
        if (values.mode === 'perform' && values.audience === 'actor') values.audience = 'Nell';
        if (values.character === values.audience) {
          values.audience = cast.find(character => character !== values.character);
        }
        inputActions.setDraft(formatDraft(values));
      }
      function select(label, value, options, field) {
        return h('label', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, label, ' ',
          h('select', { 'aria-label': label, value: value ?? '', disabled: busy || opening,
            onChange: event => update({ [field]: event.target.value }) },
            h('option', { value: '', disabled: true }, 'Choose'),
            options.map(option => h('option', { value: option, key: option }, option === 'actor' ? 'Actor chooses' : option))));
      }

      return h('div', { 'aria-label': 'Doxvelt routing', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        select('Action', command?.mode, modes, 'mode'),
        select('Character', command?.character, command?.mode === 'generate' ? cast.slice(1) : cast, 'character'),
        select('Audience', command?.audience, command?.mode === 'generate' ? [...cast, 'actor'] : cast, 'audience'),
        h('select', {
          'aria-label': 'Saved episode',
          value: saved.opened?.simulationId ?? '',
          disabled: busy || opening || Boolean(saved.opened) || Boolean((command?.body ?? draft).trim()),
          onChange: event => { void openSaved(event.target.value); },
        },
          h('option', { value: '', disabled: true }, opening ? 'Opening episode…' : 'Open saved episode'),
          saved.simulations.map(item => h('option', { value: item.simulationId, key: item.simulationId }, item.scenarioName ?? item.simulationId))),
        error && h('span', { role: 'alert' }, error));
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
      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '@', name: 'Doxvelt characters', order: -10,
        async candidates(_session, { query }) {
          return cast.filter(name => name.toLowerCase().startsWith(query.toLowerCase())).map(name => ({ name, description: 'Doxvelt character' }));
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
          if (envelope.attachments) throw new Error('The fixture accepts text only.');
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
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: kind }, Turn));
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'doxvelt-routing', order: -10,
        inject: sessionId => ({ focusComposer() {
          const binding = ctx.sessions.binding(sessionId);
          if (binding) ctx.conversation.input.for(binding.ctx).focus();
        } }),
      }, Routing));
    }

    return { inject: ['inputTriggers', 'uiConversation', 'slots', 'sessions', 'conversation'], apply };
  },
});
