import { randomUUID } from 'node:crypto';

export const playedTurn = 'doxvelt/played-turn';
const openedEpisode = 'doxvelt/episode-opened';

export async function engineRequest(origin, route, body) {
  const response = await fetch(new URL(route, origin), body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Doxvelt request failed (' + response.status + ').');
  return response.json();
}

function episodeState(session) {
  const rows = new Map();
  let opened;
  for (let index = 0; index < session.seq; index++) {
    const event = session.eventAt(index);
    if (event.type === openedEpisode) opened = event.data;
    if (event.type === playedTurn) rows.set(event.data.id, event.data);
  }
  return { opened, rows };
}

function stageRoute({ simulationId, branchId }) {
  return '/simulations/' + encodeURIComponent(simulationId) + '/stage?branchId=' + encodeURIComponent(branchId);
}

function displayRows(stage) {
  const names = new Map(stage.actors.map(actor => [actor.id, actor.name]));
  return stage.transcript.filter(turn => turn.episodeId === null).map(turn => ({
    id: turn.logicalMessageId ?? turn.id,
    character: names.get(turn.actorId) ?? turn.actorId,
    audience: turn.audience.filter(id => id !== turn.actorId).map(id => names.get(id) ?? id).join(', '),
    body: turn.text,
    saved: true,
  }));
}

function syncRows(session, current, next) {
  if ([...current.keys()].some((id, index) => next[index]?.id !== id)) {
    return false;
  }
  for (const row of next) {
    if (JSON.stringify(current.get(row.id)) !== JSON.stringify(row)) session.append(playedTurn, row);
  }
  return true;
}

function failure(error, status) {
  return Response.json({ error }, { status });
}

export async function savedEpisodeRequest(origin, session, command) {
  if (command.mode === 'saved') {
    const { simulations } = await engineRequest(origin, '/simulations');
    return Response.json({ simulations, opened: episodeState(session).opened ?? null });
  }

  if (command.mode === 'open-saved') {
    const { simulations } = await engineRequest(origin, '/simulations');
    const selected = simulations.find(item => item.simulationId === command.simulationId);
    if (!selected) return failure('That saved episode is unavailable.', 404);
    const stage = await engineRequest(origin, stageRoute(selected));
    const { opened, rows } = episodeState(session);
    if ((!opened && rows.size) || (opened && (opened.simulationId !== selected.simulationId || opened.branchId !== selected.branchId))) {
      return failure('Start a new DSH session to open another episode.', 409);
    }
    const next = { simulationId: selected.simulationId, branchId: selected.branchId, title: stage.scenarioName };
    if (!opened) session.append(openedEpisode, next);
    if (!syncRows(session, rows, displayRows(stage))) return failure('Open this episode in a fresh DSH session to see the changed history.', 409);
    return Response.json({ opened: next });
  }

  const { opened } = episodeState(session);
  if (!opened) return undefined;
  if (command.mode !== 'perform') return failure('Use Perform to continue this saved episode in the spike.', 400);

  const stage = await engineRequest(origin, stageRoute(opened));
  const actor = stage.actors.find(item => item.name === command.character);
  const audience = stage.actors.find(item => item.name === command.audience);
  const text = typeof command.body === 'string' ? command.body.trim() : '';
  if (!actor || !audience || audience.id === actor.id || !text) return failure('Choose a performer and audience and enter a performance.', 400);
  if (!syncRows(session, episodeState(session).rows, displayRows(stage))) {
    return failure('Open this episode in a fresh DSH session to see the changed history.', 409);
  }

  const route = '/simulations/' + encodeURIComponent(opened.simulationId) + '/turns';
  const { turn } = await engineRequest(origin, route, {
    branchId: opened.branchId, expectedHead: stage.branch.headCommitId, commandId: randomUUID(),
    actorId: actor.id, audience: [audience.id], manualText: text, stageWhisperIds: [],
    knowledgePolicy: 'actor-knowledge-v1',
  });
  const [row] = displayRows({ ...stage, transcript: [turn] });
  session.append(playedTurn, row);
  return Response.json({ ok: true });
}
