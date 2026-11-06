import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { playedTurn, savedEpisodeRequest } from './saved-episode.mjs';

export const inject = ['connection', 'sessions', 'workspaceRegistry'];

const cast = ['Corin', 'Nell', 'Mara'];
const actors = {
  Nell: { configuration: 'fixture-a', text: 'I will keep the letter safe.', audience: 'Corin' },
  Mara: { configuration: 'fixture-b', text: 'The wind is picking up.', audience: 'Nell' },
};

export async function apply(ctx) {
  const workspace = join(process.env.DOXVELT_SPIKE_ROOT, 'ferry-stage');
  const source = join(process.env.DOXVELT_SPIKE_ROOT, 'fixture.json');
  const fixture = JSON.parse(readFileSync(source, 'utf8'));
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
      if (!session) return Response.json({ error: 'Open the ferry scene first.' }, { status: 409 });

      try {
        const saved = await savedEpisodeRequest(process.env.DOXVELT_SPIKE_ENGINE, session, command);
        if (saved) return saved;
      } catch {
        return Response.json({ error: 'Doxvelt could not open or update the episode. Try again.' }, { status: 502 });
      }

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
        session.append(playedTurn, turn);
        return Response.json({ ok: true });
      }

      const { mode, character, audience } = command;
      if (!['perform', 'generate'].includes(mode) || !cast.includes(character) ||
          (audience !== 'actor' && (!cast.includes(audience) || character === audience)) ||
          (mode === 'perform' && (audience === 'actor' || !body)) ||
          (mode === 'generate' && !actors[character])) {
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
          perceived: fixture.turns.filter(turn => turn.character === character || turn.audience === character).map(turn => turn.id),
        });
      }

      const turn = {
        id: String(fixture.turns.length + 1),
        character,
        audience: audience === 'actor' ? actor.audience : audience,
        body: actor?.text ?? body,
        performer: actor?.configuration ?? 'player',
      };
      fixture.turns.push(turn);
      if (actor) fixture.whispers[turn.id] = body;
      writeFileSync(source, JSON.stringify(fixture, null, 2));
      // DSH gets a display receipt. The fixture file owns the played state.
      session.append(playedTurn, turn);
      return Response.json({ ok: true });
    },
  });
}
