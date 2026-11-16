// Release entry point: excludes development launchers and scripted fixtures.
export const inject = ['connection', 'sessions', 'workspaceRegistry', 'llm'];
export { applyWorkspaceHost as apply } from './workspace-host.mjs';
