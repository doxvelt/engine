import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appendPlayedTurn, resolvePlayAudience, savedEpisodeRequest } from './saved-episode.mjs';

export const inject = ['connection', 'sessions', 'workspaceRegistry'];

const cast = ['Corin', 'Nell', 'Mara'];
const actors = {
  Nell: { configuration: 'fixture-a', text: 'I will keep the letter safe.', audience: 'Corin' },
  Mara: { configuration: 'fixture-b', text: 'The wind is picking up.', audience: 'Nell' },
};

export async function apply(ctx) {
  const fixtureRoot = process.env.DOXVELT_SPIKE_ROOT;
  const workspace = process.env.DOXVELT_STAGE_WORKSPACE ?? join(fixtureRoot, 'ferry-stage');
  const origin = process.env.DOXVELT_STAGE_ENGINE ?? process.env.DOXVELT_SPIKE_ENGINE;
  const source = fixtureRoot ? join(fixtureRoot, 'fixture.json') : null;
  const fixture = source ? JSON.parse(readFileSync(source, 'utf8')) : null;
  await ctx.workspaceRegistry.create(workspace);

  // An ordinary DSH prompt is never allowed to reach a model in this profile.
  ctx.on('agent/pre-step', () => ({ kind: 'reject' }), true);
  ctx.connection.fetch.register({
    path: '/api/doxvelt-fixture',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const command = await request.json();
      const session = ctx.sessions.get(command.sessionId);
      if (!session) return Response.json({ error: 'Open a story first.' }, { status: 409 });

      try {
        const previousSeq = session.seq;
        const saved = await savedEpisodeRequest(origin, session, command, request.signal);
        if (saved) {
          if (session.seq !== previousSeq) await ctx.sessions.flush(session);
          return saved;
        }
      } catch (error) {
        return Response.json({ error: error.status ? error.message : 'Doxvelt could not open or update the episode. Try again.' }, { status: 502 });
      }

      if (!fixture) return Response.json({ error: 'Choose Open saved episode to begin playing.' }, { status: 409 });

      const body = typeof command.body === 'string' ? command.body.trim() : '';
      if (command.mode === 'inspect') {
        const whisper = fixture.whispers[command.id];
        return Response.json({ whisper: typeof whisper === 'string' ? whisper : null });
      }
      if (command.mode === 'correct') {
        const index = fixture.turns.findIndex(turn => turn.id === command.id);
        if (index < 0 || !body) return Response.json({ error: 'Choose a turn and enter the correction.' }, { status: 400 });
        const turn = { ...fixture.turns[index], body };
        fixture.turns[index] = turn;
        writeFileSync(source, JSON.stringify(fixture, null, 2));
        appendPlayedTurn(session, turn);
        await ctx.sessions.flush(session);
        return Response.json({ ok: true });
      }

      const { mode, character } = command;
      const route = resolvePlayAudience(command.audience, character, cast, mode === 'generate');
      if (!['perform', 'generate'].includes(mode) || !cast.includes(character) || !route ||
          (mode === 'perform' && !body) || (mode === 'generate' && !actors[character])) {
        return Response.json({ error: 'Choose a valid performer and audience.' }, { status: 400 });
      }

      const actor = mode === 'generate' ? actors[character] : undefined;
      if (actor) {
        await delay(350, undefined, { signal: request.signal });
        if (body === 'force failure' && !fixture.failedOnce) {
          fixture.failedOnce = true;
          writeFileSync(source, JSON.stringify(fixture, null, 2));
          return Response.json({ error: 'Scripted generation failed. Try again.' }, { status: 503 });
        }
        fixture.calls.push({
          configuration: actor.configuration,
          whisper: body,
          perceived: fixture.turns.filter(turn => turn.character === character || turn.audience.split(', ').includes(character)).map(turn => turn.id),
        });
      }

      const recipients = route.recipients ?? (route.limit?.includes(actor.audience) || !route.limit ? [actor.audience] : route.limit.slice(0, 1));
      const turn = {
        id: String(fixture.turns.length + 1),
        character,
        audience: recipients.join(', '),
        body: actor?.text ?? body,
        performer: actor?.configuration ?? 'player',
      };
      fixture.turns.push(turn);
      if (actor) fixture.whispers[turn.id] = body;
      writeFileSync(source, JSON.stringify(fixture, null, 2));
      // DSH gets a display receipt. The fixture file owns the played state.
      appendPlayedTurn(session, turn);
      await ctx.sessions.flush(session);
      return Response.json({ ok: true });
    },
  });
}
