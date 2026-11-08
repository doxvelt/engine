import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { DshActorTurnRuntime } from '../../src/agent-runtime/dsh.ts';
import { createLocalApiServer } from '../../src/local-api/server.ts';
import { EpisodeMemory } from '../../src/memory/episodes.ts';
import { SceneHeadingStore } from '../../src/store/scene-headings.ts';
import { readSourceText } from '../../src/core/source.ts';
import {
  activateWorkspace, createCollectionObject, readWorkspaceConfiguration,
  saveCollectionSource, startCollectionStory, workspaceCollection, workspaceLocation,
  WorkspaceCollectionError, configurationRevision, saveWorkspaceConfiguration,
} from '../../src/local-api/workspace-collection.ts';
import { savedEpisodeRequest } from './saved-episode.mjs';

export function isEpisodeSession(session) {
  for (let index = 0; index < session.seq; index++) {
    const event = session.eventAt(index);
    if (event.type === 'command/done' && event.data.kind === 'success' &&
        event.data.commandId.startsWith('doxvelt:episode-opened:')) return true;
  }
  return false;
}

/** Resolve the immutable session header against DSH's registered workspaces. */
export async function registeredSessionWorkspace(ctx, session) {
  if (!session.header.cwd) throw new WorkspaceCollectionError('workspace-required', 'Choose a DSH workspace first.', 409);
  const root = await realpath(session.header.cwd);
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (await realpath(workspace.path) === root) return root;
  }
  throw new WorkspaceCollectionError('workspace-unregistered', 'This chat is not in a registered DSH workspace.', 409);
}

export async function applyWorkspaceHost(ctx, options = {}) {
  const services = new Map();
  const tails = new Map();
  const lifecycle = new AbortController();
  let disposing = false;
  async function closeService(service) {
    service.engine.closeIdleConnections();
    await new Promise(resolve => service.engine.close(resolve));
    service.memory.close();
    service.headings.close();
  }
  ctx.on('dispose', async () => {
    disposing = true;
    lifecycle.abort();
    await Promise.allSettled([...tails.values()]);
    await Promise.all([...services.values()].map(closeService));
  });
  ctx.on('agent/pre-step', ({ agent }, next) => isEpisodeSession(agent.session) ? { kind: 'reject' } : next(), true);

  async function serviceFor(root, config) {
    if (disposing) throw new WorkspaceCollectionError('host-stopping', 'DSH is stopping. Reopen the workspace to continue.', 503);
    const version = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const previous = services.get(root);
    if (previous?.version === version) return previous;
    if (previous) { services.delete(root); await closeService(previous); }
    const location = await workspaceLocation(root);
    const reflection = config.reflectionModel ?? config.actorModel;
    const memory = new EpisodeMemory({
      directory: path.join(location.data, 'memory'), executable: options.reverie ?? process.env.DOXVELT_REVERIE_EXECUTABLE ?? '',
      modelKey: reflection ? reflection.provider + ':' + reflection.model : 'unconfigured',
      async reflect(request, signal) {
        if (!reflection) throw new Error('Choose a reflection model in Doxvelt workspace settings before memorizing.');
        const assembled = new BlockAssembler();
        let finished = false;
        for await (const chunk of ctx.llm.stream({ ...reflection, system: request.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(request.input) }] }],
          maxTokens: request.maxTokens, signal })) {
          assembled.push(chunk);
          if (chunk.type === 'finish') { finished = true; break; }
        }
        const blocks = assembled.blocks();
        const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
        if (!finished || assembled.finish.kind !== 'stop' || blocks.some(block => block.type === 'tool-call') || !text.trim())
          throw new Error('The reflection model did not return a complete response.');
        return text;
      },
    });
    const actor = config.actorModel;
    const actorConfigurations = actor ? [{
      characterId: null, key: 'default', label: actor.model,
      profile: { id: 'harness-model', version: createHash('sha256').update(JSON.stringify(actor)).digest('hex') }, runtime: new DshActorTurnRuntime(ctx.llm, actor),
    }] : [];
    const headings = new SceneHeadingStore(path.join(location.data, 'scene-headings.sqlite'));
    const engine = createLocalApiServer({ dbPath: location.database, episodeMemory: memory, actorConfigurations, sceneHeadings: headings });
    try {
      engine.listen(0, '127.0.0.1');
      await once(engine, 'listening');
    } catch (error) { memory.close(); headings.close(); throw error; }
    const service = { engine, memory, headings, version, origin: 'http://127.0.0.1:' + engine.address().port };
    services.set(root, service);
    return service;
  }

  async function handle(root, session, command, signal) {
    let config = await readWorkspaceConfiguration(root);
    if (command.mode === 'workspace-activate') config = await activateWorkspace(root, signal);
    const workspace = { active: Boolean(config), folder: root, memoryConfigured: Boolean(config?.reflectionModel ?? config?.actorModel) };
    if (!config) {
      if (command.mode !== 'saved') throw new WorkspaceCollectionError('inactive-workspace', 'Activate Doxvelt in this workspace first.', 409);
      return Response.json({ workspace, simulations: [], opened: null, branches: [], episodes: [] });
    }
    if (command.mode === 'workspace-activate') return Response.json({ workspace });
    if (command.mode === 'collection') return Response.json({ ...await workspaceCollection(root), configuration: config, configurationRevision: configurationRevision(config) });
    if (command.mode === 'workspace-models') {
      const catalog = (await Promise.all(ctx.llm.listProviders().map(async provider => {
        try { return (await ctx.llm.listModels(provider.id)).map(model => ({ provider: provider.id, model: model.id, label: provider.name + ' · ' + model.name })); }
        catch { return []; }
      }))).flat();
      return Response.json({ models: catalog, configuration: config, configurationRevision: configurationRevision(config) });
    }
    if (command.mode === 'workspace-save-models') {
      for (const model of [command.configuration?.actorModel, command.configuration?.reflectionModel]) {
        if (model && !(await ctx.llm.listModels(model.provider)).some(item => item.id === model.model))
          throw new WorkspaceCollectionError('model-unavailable', 'Choose a model available in DSH settings.');
      }
      return Response.json(await saveWorkspaceConfiguration(root, command.configuration, command.expectedRevision, signal));
    }
    if (command.mode === 'collection-create') return Response.json(await createCollectionObject(root, command.object, signal));
    if (command.mode === 'collection-read') return Response.json(await readSourceText(root, command.path));
    if (command.mode === 'collection-save') return Response.json(await saveCollectionSource(root, command.source, signal));
    const service = await serviceFor(root, config);
    if (command.mode === 'create-story') return Response.json(await startCollectionStory(root, command.setup, service.memory, signal));
    const response = await savedEpisodeRequest(service.origin, session, command, signal);
    if (!response) throw new WorkspaceCollectionError('episode-required', 'Create or open a Doxvelt episode first.', 409);
    if (command.mode === 'open-saved' && response.ok && !ctx.get('sessionTitle')?.get(session)) {
      const opened = (await response.clone().json()).opened;
      ctx.get('sessionTitle')?.rename(session, opened.title);
    }
    if (command.mode !== 'saved') return response;
    return Response.json({ ...await response.json(), workspace });
  }

  ctx.connection.fetch.register({ path: '/api/doxvelt-fixture', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let session;
      let previous;
      try {
        const command = await request.json();
        if (!command || typeof command.sessionId !== 'string' || typeof command.mode !== 'string')
          throw new WorkspaceCollectionError('invalid-request', 'Choose a Doxvelt workspace operation.');
        session = ctx.sessions.get(command.sessionId);
        if (!session) throw new WorkspaceCollectionError('chat-unavailable', 'Open a chat in the workspace first.', 409);
        const root = await registeredSessionWorkspace(ctx, session);
        const signal = AbortSignal.any([request.signal, lifecycle.signal]);
        const pending = (tails.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => {
          signal.throwIfAborted();
          previous = session.seq;
          return handle(root, session, command, signal);
        });
        const tail = pending.then(() => {}, () => {});
        tails.set(root, tail);
        try { return await pending; }
        finally { if (tails.get(root) === tail) tails.delete(root); }
      } catch (error) {
        const known = error instanceof WorkspaceCollectionError;
        return Response.json({ error: known ? error.message : 'Doxvelt could not complete this operation. Reopen the workspace and try again.',
          code: known ? error.code : 'workspace-operation-failed' }, { status: known ? error.status : 500 });
      } finally {
        if (session && previous !== undefined && session.seq !== previous) await ctx.sessions.flush(session);
      }
    },
  });
}
