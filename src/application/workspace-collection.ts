import { createHash } from "node:crypto";
import { NativeApiServer, NativeOperationError } from "../local-api/native-server.ts";
import type { EpisodeMemory } from "../memory/episodes.ts";
import type { DiagnosticRecord } from "../core/types.ts";
import type { SourceFileSummary } from "../core/source.ts";

export class WorkspaceCollectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {super(message);this.code=code;this.status=status;}
}
export type HarnessModel = { provider: string; model: string };
export type WorkspaceConfiguration = {version:1;actorModel?:HarnessModel;reflectionModel?:HarnessModel};
export type StorySetup = {operationId:string;collectionRevision:string;worldId:string;scenarioId:string;formatId:string;characterIds:string[];date:string};
export type WorkspaceLocation = {root:string;data:string;configuration:string;database:string};
export type Collection = {revision:string;worlds:{id:string;name:string}[];scenarios:{id:string;name:string}[];formats:{id:string;name:string}[];characters:{id:string;name:string}[];files:(SourceFileSummary&{revision:string})[];diagnostics:DiagnosticRecord[]};
type SavedStory = {status:"complete"|"partial";simulationId:string;branchId:string;pending?:"date";message?:string};

/** Transport only. The registered DSH host supplies the workspace directory. */
async function native<T>(directory:string,action:string,body:unknown={},signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  const client=new NativeApiServer({});
  try{return await client.workspace<T>(directory,action,body,signal);}
  catch(error){if(error instanceof NativeOperationError)throw new WorkspaceCollectionError(error.code,error.message,error.status);throw error;}
  finally{await new Promise<void>((resolve,reject)=>client.close(error=>error?reject(error):resolve()));}
}
export const configurationRevision=(config:WorkspaceConfiguration)=>createHash("sha256").update(JSON.stringify(config)).digest("hex");
export const workspaceLocation=(directory:string)=>native<WorkspaceLocation>(directory,"location");
export const readWorkspaceConfiguration=(directory:string)=>native<WorkspaceConfiguration|null>(directory,"configuration.read");
export const activateWorkspace=(directory:string,signal?:AbortSignal)=>native<WorkspaceConfiguration>(directory,"activate",{},signal);
export const saveWorkspaceConfiguration=(directory:string,configuration:WorkspaceConfiguration,expectedRevision:string,signal?:AbortSignal)=>native<{configuration:WorkspaceConfiguration;configurationRevision:string}>(directory,"configuration.save",{configuration,expectedRevision},signal);
export const workspaceCollection=(directory:string)=>native<Collection>(directory,"collection");
export const createCollectionObject=(directory:string,input:{kind:"world"|"scenario"|"character"|"format";id:string;name:string;body:string},signal?:AbortSignal)=>native<{path:string;revision:string}>(directory,"source.create",input,signal);
export const readCollectionSource=(directory:string,path:string)=>native<{root:string;path:string;text:string}>(directory,"source.read",{path});
export const saveCollectionSource=(directory:string,input:{path:string;text:string;expectedRevision:string|null},signal?:AbortSignal)=>native<{path:string;revision:string}>(directory,"source.save",input,signal);
export const startCollectionStory=(directory:string,setup:StorySetup,memory:Pick<EpisodeMemory,"nativeConfiguration">,signal?:AbortSignal)=>native<SavedStory>(directory,"story.start",{setup,memoryDirectory:memory.nativeConfiguration.directory},signal);
