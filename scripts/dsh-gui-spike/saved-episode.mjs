import { randomUUID } from 'node:crypto';

const playedTurn = 'played-turn';
const openedEpisode = 'episode-opened';
const endedEpisode = 'episode-ended';

function appendReceipt(session, type, data) {
  // DSH command results are presentation records outside the model's message history.
  const commandId = 'doxvelt:' + type + ':' + randomUUID();
  session.append('command/run', { commandId, name: 'doxvelt-' + type, source: { kind: 'user' } });
  session.append('command/done', { commandId, kind: 'success', text: JSON.stringify(data) });
}

export function appendPlayedTurn(session, row) {
  appendReceipt(session, playedTurn, row);
}

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
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue;
    const [namespace, type] = event.data.commandId.split(':', 2);
    if (namespace !== 'doxvelt') continue;
    const data = JSON.parse(event.data.text);
    if (type === openedEpisode) opened = data;
    if (type === endedEpisode) {
      ended = true;
      if (opened && data.episodeId) opened = { ...opened, episodeId: data.episodeId };
    }
    if (type === playedTurn) rows.set(data.id, data);
  }
  return { opened, rows, ended };
}

function stageRoute({ simulationId, branchId }) {
  return '/simulations/' + encodeURIComponent(simulationId) + '/stage?branchId=' + encodeURIComponent(branchId);
}

function simulationRoute(simulationId) {
  return '/simulations/' + encodeURIComponent(simulationId);
}

async function savedBranches(origin, selection) {
  const endpoint = simulationRoute(selection.simulationId) + '/branches?branchId=' + encodeURIComponent(selection.branchId);
  const { branches } = await engineRequest(origin, endpoint);
  return branches.map((branch, index) => ({
    id: branch.id,
    label: branch.origin.kind === 'root' ? 'Original' : (branch.name || 'Path') + ' (' + (index + 1) + ')',
  }));
}

async function rememberOpenedPath(origin, selection, signal) {
  const endpoint = simulationRoute(selection.simulationId) + '/navigation';
  const { version } = await engineRequest(origin, endpoint + '?branchId=' + encodeURIComponent(selection.branchId), undefined, signal);
  try {
    await engineRequest(origin, endpoint, { branchId: selection.branchId, operationId: randomUUID(), expectedVersion: version }, signal);
  } catch (error) {
    if (error.status !== 409) throw error;
  }
}

function mention(actor) {
  return actor.name.toLowerCase() === actor.id.toLowerCase() ? actor.name : actor.id;
}

function castFor(stage) {
  return stage.actors.map(actor => ({
    token: mention(actor), name: actor.name, canGenerate: Boolean(stage.generationActorIds?.includes(actor.id)),
    configurations: stage.actorConfigurations?.filter(configuration => configuration.characterId === actor.id) ?? [],
  }));
}

function displayRows(stage, episodeId = null) {
  const names = new Map(stage.actors.map(actor => [actor.id, actor.name]));
  return stage.transcript.filter(turn => turn.episodeId === episodeId).map(turn => ({
    id: turn.logicalMessageId ?? turn.id,
    character: names.get(turn.actorId) ?? turn.actorId,
    audience: turn.audience.filter(id => id !== turn.actorId).map(id => names.get(id) ?? id).join(', '),
    body: turn.text,
    version: turn.bodyRevisionId ?? turn.messageVersionId,
    saved: true,
  }));
}

function syncRows(session, current, next) {
  if ([...current.keys()].some((id, index) => next[index]?.id !== id)) {
    return false;
  }
  for (const row of next) {
    if (JSON.stringify(current.get(row.id)) !== JSON.stringify(row)) appendPlayedTurn(session, row);
  }
  return true;
}

export function resolvePlayAudience(selection, speaker, cast, generating) {
  if (typeof selection !== 'string') return undefined;
  const others = cast.filter(token => token !== speaker);
  if (selection === '!all') return { recipients: others };
  if (selection === '!self') return { recipients: [] };
  if (selection === '!actor') return generating ? { recipients: null } : undefined;
  const limited = selection.startsWith('!actor:');
  if (limited && !generating) return undefined;
  const tokens = (limited ? selection.slice(7) : selection).split(',');
  if (tokens.some(token => !others.includes(token)) || new Set(tokens).size !== tokens.length) return undefined;
  return limited ? { recipients: null, limit: tokens } : { recipients: tokens };
}

function failure(error, status) {
  return Response.json({ error }, { status });
}

export async function savedEpisodeRequest(origin, session, command, signal) {
  if (command.mode === 'saved') {
    const { simulations } = await engineRequest(origin, '/simulations');
    const opened = episodeState(session).opened;
    if (!opened) return Response.json({ simulations, opened: null, branches: [], episodes: [] });
    const [stage, branches] = await Promise.all([
      engineRequest(origin, stageRoute(opened)), savedBranches(origin, opened),
    ]);
    return Response.json({ simulations, opened: { ...opened, cast: castFor(stage) }, branches, episodes: stage.episodes });
  }

  if (command.mode === 'open-saved') {
    const { simulations } = await engineRequest(origin, '/simulations');
    const selected = simulations.find(item => item.simulationId === command.simulationId);
    if (!selected) return failure('That saved episode is unavailable.', 404);
    const branches = await savedBranches(origin, selected);
    const branchId = command.branchId ?? selected.branchId;
    if (!branches.some(branch => branch.id === branchId)) return failure('That saved path is unavailable.', 404);
    const selection = { simulationId: selected.simulationId, branchId };
    const stage = await engineRequest(origin, stageRoute(selection));
    const requestedEpisode = stage.episodes?.find(episode => episode.id === command.episodeId);
    if (command.episodeId && !requestedEpisode && !command.followPath) return failure('That episode is unavailable on this path.', 404);
    const episodeId = requestedEpisode?.id ?? null;
    const { opened, rows, ended } = episodeState(session);
    if ((!opened && rows.size) || (opened && (opened.simulationId !== selected.simulationId || opened.branchId !== branchId ||
        (opened.episodeId ?? null) !== episodeId || (ended && !opened.episodeId)))) {
      return failure('Start a new DSH session to open another episode.', 409);
    }
    const next = { ...selection, title: stage.scenarioName, ...(episodeId ? { episodeId } : {}) };
    if (!opened) await rememberOpenedPath(origin, selection, signal);
    if (JSON.stringify(opened) !== JSON.stringify(next)) appendReceipt(session, openedEpisode, next);
    if (!syncRows(session, rows, displayRows(stage, episodeId))) return failure('Open this episode in a fresh DSH session to see the changed history.', 409);
    return Response.json({ opened: { ...next, cast: castFor(stage) }, branches, episodes: stage.episodes });
  }

  const { opened, ended } = episodeState(session);
  if (!opened) return undefined;
  if (command.mode.startsWith('memory-')) return episodeMemoryRequest(origin, session, opened, ended || Boolean(opened.episodeId), command, signal);
  if (command.mode.startsWith('history-')) return historicalRequest(origin, opened, command, signal);
  if (ended || opened.episodeId) return failure('This episode ended. Open a new DSH session to play the next episode.', 409);
  const generating = command.mode === 'generate';
  if (!generating && command.mode !== 'perform') return failure('Choose Perform or Generate.', 400);

  const stage = await engineRequest(origin, stageRoute(opened));
  const cast = new Map(stage.actors.map(actor => [mention(actor), actor.id]));
  const actorId = cast.get(command.character);
  const route = resolvePlayAudience(command.audience, command.character, [...cast.keys()], generating);
  const text = typeof command.body === 'string' ? command.body.trim() : '';
  if (!actorId || !route || (!generating && !text)) {
    return failure('Choose a valid performer and audience, and enter a performance for Perform.', 400);
  }
  if (!syncRows(session, episodeState(session).rows, displayRows(stage))) {
    return failure('Open this episode in a fresh DSH session to see the changed history.', 409);
  }

  const simulation = simulationRoute(opened.simulationId);
  const basis = { branchId: opened.branchId, expectedHead: stage.branch.headCommitId, commandId: randomUUID(),
    actorId, stageWhisperIds: [] };
  const audience = route.recipients?.map(token => cast.get(token)) ?? null;
  if (generating) {
    const audienceLimit = route.limit?.map(token => cast.get(token));
    if (!await commitGeneratedTurn(origin, simulation, basis, audience, text, { audienceLimit, actorConfiguration: command.actorConfiguration }))
      return failure('Generation did not produce a valid turn. The direction is still in the composer.', 422);
    const updated = await engineRequest(origin, stageRoute(opened));
    if (!syncRows(session, episodeState(session).rows, displayRows(updated))) {
      return failure('The turn was saved. Reopen the episode to see the updated transcript.', 409);
    }
  } else {
    const { turn } = await engineRequest(origin, simulation + '/turns', {
      ...basis, audience, manualText: text, knowledgePolicy: 'actor-knowledge-v1',
    });
    const [row] = displayRows({ ...stage, transcript: [turn] });
    appendPlayedTurn(session, row);
  }
  return Response.json({ ok: true });
}

async function commitGeneratedTurn(origin, simulation, basis, audience, completeWhisper, { signal, audienceLimit, actorConfiguration } = {}) {
  const { draft } = await engineRequest(origin, simulation + '/drafts', {
    ...basis, draftingPolicy: 'actor-knowledge-v1', completeWhisper, audience, fixedAudience: audience !== null,
    ...(audienceLimit ? { audienceLimit } : {}),
    ...(actorConfiguration !== undefined ? { actorConfiguration } : {}),
  }, signal);
  if (draft.status === 'accepted') return true;
  if (draft.status !== 'ready') return false;
  await engineRequest(origin, simulation + '/drafts/' + encodeURIComponent(draft.id) + '/accept', {
    commandId: basis.commandId + '-accept',
  }, signal);
  return true;
}

function historyAudience(stage, actorId, tokens) {
  if (tokens === null) return null;
  if (!Array.isArray(tokens) ||
      tokens.some(token => !stage.actors.some(actor => actor.id !== actorId && mention(actor) === token))) return undefined;
  return stage.actors.filter(actor => tokens.includes(mention(actor))).map(actor => actor.id);
}

async function historicalRequest(origin, opened, command, signal) {
  const stage = await engineRequest(origin, stageRoute(opened), undefined, signal);
  const turn = stage.transcript.find(item => (item.episodeId === (opened.episodeId ?? null)) && item.logicalMessageId === command.id &&
    ((item.bodyRevisionId ?? item.messageVersionId) === command.version || (command.mode === 'history-origin' && command.version === undefined)));
  if (!turn) return failure('That version of the turn changed. Reopen the episode before editing it.', 409);

  const simulation = simulationRoute(opened.simulationId);
  const endpoint = simulation + '/alternatives';
  const selection = {
    sourceBranchId: opened.branchId, expectedHead: stage.branch.headCommitId,
    sourceCommitId: turn.commitId, messageVersionId: turn.messageVersionId,
    logicalMessageId: turn.logicalMessageId, actorId: turn.actorId,
  };
  if (command.mode === 'history-origin') {
    const next = stage.transcript[stage.transcript.indexOf(turn) + 1];
    const nextTurn = next?.episodeId === turn.episodeId ? next : null;
    const nextSelection = nextTurn && { ...selection, sourceCommitId: nextTurn.commitId, actorId: nextTurn.actorId,
      messageVersionId: nextTurn.messageVersionId, logicalMessageId: nextTurn.logicalMessageId };
    const [originInput, nextInput] = await Promise.all([
      engineRequest(origin, endpoint + '/origin', selection, signal),
      nextSelection ? engineRequest(origin, endpoint + '/origin', nextSelection, signal) : null,
    ]);
    const routing = item => ({
      actor: mention(stage.actors.find(actor => actor.id === item.actorId)),
      audience: stage.actors.filter(actor => actor.id !== item.actorId && item.audience.includes(actor.id)).map(mention),
    });
    return Response.json({
      whisper: originInput.completeWhisper ?? '', version: turn.bodyRevisionId ?? turn.messageVersionId,
      body: turn.text, expectedHead: stage.branch.headCommitId,
      ...routing(turn), actorProfile: originInput.actorProfile,
      next: nextTurn ? { ...routing(nextTurn), actorProfile: nextInput.actorProfile, whisper: nextInput.completeWhisper ?? '' } : null,
      cast: castFor(stage),
    });
  }
  if (command.expectedHead !== stage.branch.headCommitId)
    return failure('This path changed while the editor was open. Reopen the turn before saving.', 409);
  if (typeof command.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(command.requestId))
    return failure('Reopen the turn editor before submitting this revision.', 400);
  if (command.mode === 'history-correct') {
    const result = await engineRequest(origin, simulation + '/correct-turn-body', {
      sourceBranchId: opened.branchId, expectedHead: command.expectedHead, commandId: command.requestId,
      messageVersionId: turn.messageVersionId, text: command.body,
    }, signal);
    return Response.json({ selection: { simulationId: opened.simulationId, branchId: result.branch.id, episodeId: opened.episodeId } });
  }
  if (command.mode === 'history-edit-next')
    return editAndGenerateNext(origin, simulation, stage, selection, opened.simulationId, command, signal);
  if (command.mode !== 'history-generate') return failure('Choose a revision action.', 400);
  const replacement = stage.actors.find(item => mention(item) === command.character);
  if (!replacement || !stage.generationActorIds?.includes(replacement.id)) return failure('Choose a character with a model.', 400);
  const audience = historyAudience(stage, replacement.id, command.audience);
  const audienceLimit = command.audienceLimit === undefined ? undefined : historyAudience(stage, replacement.id, command.audienceLimit);
  if (audience === undefined || (command.audienceLimit !== undefined && (!audienceLimit || audience !== null)))
    return failure('Choose recipients from the cast.', 400);
  const { operation } = await engineRequest(origin, endpoint, {
    ...selection, commandId: command.requestId, action: 'generate', audience,
    ...(audienceLimit ? { audienceLimit } : {}),
    ...(command.actorConfiguration !== undefined ? { actorConfiguration: command.actorConfiguration } : {}),
    ...(replacement.id === turn.actorId ? {} : { replacementActorId: replacement.id }),
    completeWhisper: command.whisper,
  }, signal);
  if (operation.status !== 'saved') return failure('Generation did not save a new path. You can edit the direction and try again.', 422);
  return Response.json({ selection: { simulationId: opened.simulationId, branchId: operation.outcome.branchId } });
}

async function editAndGenerateNext(origin, simulation, stage, selection, simulationId, command, signal) {
  const performer = stage.actors.find(actor => mention(actor) === command.speaker);
  const next = stage.actors.find(actor => mention(actor) === command.character);
  if (!performer || !next || !stage.generationActorIds?.includes(next.id)) return failure('Choose a speaking character and a next actor with a model.', 400);
  if (command.actorConfiguration !== undefined && !stage.actorConfigurations?.some(
    item => item.characterId === next.id && item.key === command.actorConfiguration))
    return failure('That actor configuration is unavailable for this character.', 409);
  const editedAudience = historyAudience(stage, performer.id, command.editedAudience);
  const nextAudience = historyAudience(stage, next.id, command.audience);
  const audienceLimit = command.audienceLimit === undefined ? undefined : historyAudience(stage, next.id, command.audienceLimit);
  if (!editedAudience || nextAudience === undefined || (command.audienceLimit !== undefined && (!audienceLimit || nextAudience !== null)))
    return failure('Choose recipients from the cast.', 400);
  if (!Number.isSafeInteger(command.attempt) || command.attempt < 0 ||
      typeof command.whisper !== 'string' || command.whisper.length > 100_000)
    return failure('The turn editor could not submit that request. Reopen the turn and try again.', 400);

  const { operation } = await engineRequest(origin, simulation + '/alternatives', {
    ...selection, commandId: command.requestId, action: 'manual',
    ...(performer.id === selection.actorId ? {} : { replacementActorId: performer.id }),
    audience: editedAudience, manualText: command.body,
  }, signal);
  if (operation.status !== 'saved') return failure('The edit could not save a new path.', 422);
  const { branchId, commitId } = operation.outcome;
  const nextPath = { simulationId, branchId };
  try {
    const generated = await commitGeneratedTurn(origin, simulation, {
      branchId, expectedHead: commitId, commandId: command.requestId + '-next-' + command.attempt,
      actorId: next.id, stageWhisperIds: [],
    }, nextAudience, command.whisper, { signal, audienceLimit, actorConfiguration: command.actorConfiguration });
    return Response.json({ selection: nextPath, retry: generated ? null : 'next' });
  } catch {
    // A dropped response can follow acceptance. Retry with the same command identity.
    return Response.json({ selection: nextPath, retry: 'check' });
  }
}

async function episodeMemoryRequest(origin, session, opened, ended, command, signal) {
  const simulation = simulationRoute(opened.simulationId);
  const endpoint = simulation + '/episode-memory';
  const read = async () => {
    try { return await engineRequest(origin, endpoint + '?branchId=' + encodeURIComponent(opened.branchId), undefined, signal); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const viewed = () => ({ ended, episodeId: opened.episodeId ?? null });
  if (command.mode === 'memory-status') return Response.json({ ...await read(), ...viewed() });
  const stage = await engineRequest(origin, stageRoute(opened), undefined, signal);
  const basis = { branchId: opened.branchId, expectedHead: stage.branch.headCommitId, commandId: randomUUID() };
  if (command.mode === 'memory-next') {
    if (ended) return failure('This episode is already closed.', 409);
    const { commit } = await engineRequest(origin, simulation + '/episodes/request-closure', { ...basis, label: command.label || null }, signal);
    const episodeId = commit.events.find(event => event.type === 'episode_closed').closure.episode.id;
    appendReceipt(session, endedEpisode, { episodeId });
    return Response.json({ ...await read(), ended: true, episodeId });
  }
  const slot = command.slot;
  if (command.mode === 'memory-date')
    return Response.json({ ...await engineRequest(origin, endpoint + '/date', { ...basis, slot, date: command.date }, signal), ...viewed() });
  if (command.mode === 'memory-memorize') {
    const result = await engineRequest(origin, endpoint + '/memorize', { ...basis, slot }, signal);
    return Response.json({ ...await read(), ...viewed(), status: result.status });
  }
  return failure('Unknown episode memory action.', 400);
}
