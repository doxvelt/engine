import { randomUUID } from 'node:crypto';

export const playedTurn = 'doxvelt/played-turn';
const openedEpisode = 'doxvelt/episode-opened';

export async function engineRequest(origin, route, body, signal) {
  const response = await fetch(new URL(route, origin), body === undefined ? { signal } : {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error || 'Doxvelt request failed (' + response.status + ').');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function episodeState(session) {
  const rows = new Map();
  let opened;
  let ended = false;
  for (let index = 0; index < session.seq; index++) {
    const event = session.eventAt(index);
    if (event.type === openedEpisode) opened = event.data;
    if (event.type === "doxvelt/episode-ended") ended = true;
    if (event.type === playedTurn) rows.set(event.data.id, event.data);
  }
  return { opened, rows, ended };
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

export async function savedEpisodeRequest(origin, session, command, signal) {
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

  const { opened, ended } = episodeState(session);
  if (!opened) return undefined;
  if (command.mode.startsWith('memory-')) return episodeMemoryRequest(origin, session, opened, ended, command, signal);
  if (ended) return failure('This episode ended. Open a new DSH session to play the next episode.', 409);
  const generating = command.mode === 'generate';
  if (!generating && command.mode !== 'perform') return failure('Choose Perform or Generate.', 400);

  const stage = await engineRequest(origin, stageRoute(opened));
  const actor = stage.actors.find(item => item.name === command.character);
  const audience = stage.actors.find(item => item.name === command.audience);
  const delegateAudience = generating && command.audience === 'actor';
  const text = typeof command.body === 'string' ? command.body.trim() : '';
  if (!actor || (!delegateAudience && (!audience || audience.id === actor.id)) || (!generating && !text)) {
    return failure('Choose a valid performer and audience, and enter a performance for Perform.', 400);
  }
  if (!syncRows(session, episodeState(session).rows, displayRows(stage))) {
    return failure('Open this episode in a fresh DSH session to see the changed history.', 409);
  }

  const simulation = '/simulations/' + encodeURIComponent(opened.simulationId);
  const basis = { branchId: opened.branchId, expectedHead: stage.branch.headCommitId, commandId: randomUUID(),
    actorId: actor.id, stageWhisperIds: [] };
  if (generating) {
    const { draft } = await engineRequest(origin, simulation + '/drafts', {
      ...basis, draftingPolicy: 'actor-knowledge-v1', completeWhisper: text,
      audience: delegateAudience ? null : [audience.id], fixedAudience: !delegateAudience,
    });
    if (draft.status !== 'ready') return failure('Generation did not produce a valid turn. The direction is still in the composer.', 422);
    await engineRequest(origin, simulation + '/drafts/' + encodeURIComponent(draft.id) + '/accept', {
      commandId: basis.commandId + '-accept',
    });
    const updated = await engineRequest(origin, stageRoute(opened));
    if (!syncRows(session, episodeState(session).rows, displayRows(updated))) {
      return failure('The turn was saved. Reopen the episode to see the updated transcript.', 409);
    }
  } else {
    const { turn } = await engineRequest(origin, simulation + '/turns', {
      ...basis, audience: [audience.id], manualText: text, knowledgePolicy: 'actor-knowledge-v1',
    });
    const [row] = displayRows({ ...stage, transcript: [turn] });
    session.append(playedTurn, row);
  }
  return Response.json({ ok: true });
}

async function episodeMemoryRequest(origin, session, opened, ended, command, signal) {
  const simulation = '/simulations/' + encodeURIComponent(opened.simulationId);
  const endpoint = simulation + '/episode-memory';
  const read = async () => {
    try { return await engineRequest(origin, endpoint + '?branchId=' + encodeURIComponent(opened.branchId), undefined, signal); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  if (command.mode === 'memory-status') return Response.json({ ...await read(), ended });
  if (ended) return failure('Open the current episode to change its memory or date.', 409);
  const stage = await engineRequest(origin, stageRoute(opened), undefined, signal);
  const basis = { branchId: opened.branchId, expectedHead: stage.branch.headCommitId, commandId: randomUUID() };
  if (command.mode === 'memory-next') {
    await engineRequest(origin, simulation + '/episodes/request-closure', { ...basis, label: command.label || null }, signal);
    session.append('doxvelt/episode-ended', { head: stage.branch.headCommitId });
    return Response.json({ ...await read(), ended: true });
  }
  const slot = command.slot;
  if (command.mode === 'memory-date')
    return Response.json(await engineRequest(origin, endpoint + '/date', { ...basis, slot, date: command.date }, signal));
  if (command.mode === 'memory-memorize') {
    const result = await engineRequest(origin, endpoint + '/memorize', { ...basis, slot }, signal);
    return Response.json({ ...await read(), status: result.status });
  }
  return failure('Unknown episode memory action.', 400);
}
