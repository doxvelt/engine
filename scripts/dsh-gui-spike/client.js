window.__ModuleLoader__.load({
  id: '@doxvelt/dsh-gui-spike',
  factory(require) {
    const { createElement: h, useState } = require('react');
    const cast = ['Corin', 'Nell', 'Mara'];
    const modes = ['perform', 'generate'];
    const kind = 'doxvelt-performance';

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

    function Routing({ useInput, inputActions }) {
      const draft = useInput(state => state.draft);
      const phase = useInput(state => state.phase);
      const command = parseDraft(draft);
      const busy = phase === 'submitting' || phase === 'sending' || phase === 'adjudicating';
      function update(change) {
        const values = { mode: 'perform', character: 'Corin', audience: 'Nell', body: draft, ...command, ...change };
        if (values.mode === 'perform' && values.audience === 'actor') values.audience = 'Nell';
        const audience = values.audience === 'actor' ? 'actor' : '@' + values.audience;
        inputActions.setDraft('/' + values.mode + ' @' + values.character + ' to ' + audience + ' | ' + values.body);
      }
      function select(label, value, options, field) {
        return h('label', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, label, ' ',
          h('select', { 'aria-label': label, value: value ?? '', disabled: busy, onChange: event => update({ [field]: event.target.value }) },
            h('option', { value: '', disabled: true }, 'Choose'),
            options.map(option => h('option', { value: option, key: option }, option === 'actor' ? 'Actor chooses' : option))));
      }
      return h('div', { 'aria-label': 'Doxvelt routing', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        select('Action', command?.mode, modes, 'mode'),
        select('Character', command?.character, cast, 'character'),
        select('Audience', command?.audience, [...cast, 'actor'], 'audience'));
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
          : h('p', null, turn.body, ' ', h('button', {
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
      }, Routing));
    }

    return { inject: ['inputTriggers', 'uiConversation', 'slots'], apply };
  },
});
