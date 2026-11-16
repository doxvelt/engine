import { NativeApiServer } from "../local-api/native-server.ts";
import type { ProjectionQuery } from "../core/types.ts";
import type { ReflectionRequest, ReverieSource } from "./reverie.ts";

export type EpisodeMemoryOptions = {
  directory:string;executable:string;modelKey:string;
  reflect:(request:ReflectionRequest,signal:AbortSignal)=>Promise<string>;
};
type CharacterMemory={characterId:string;memories:{gist:string;detail:string;feeling:string;sourceMessageIds:string[]}[];impressions:{text:string;sourceEpisodeIds:string[]}[]};
type Inspection={slot:string;episodeId:string|null;label:string;date:string|null;revision:string;canMemorize:boolean;status:"current"|"drifted"|"unmemorized";memories:CharacterMemory[]};
type SourceScene={slot:string;episodeId:string|null;label:string;date:string|null;revision:string;sources:{characterId:string;name:string;observation:ReverieSource}[]};
type Publication={status:"current"|"published";memories:CharacterMemory[]};
type DatabaseLocation={readonly dbPath:string};

/** Deployment configuration and model callback only. All episode rules,
 * publication storage and Reverie processes run in the native engine. */
export class EpisodeMemory {
  private readonly options:EpisodeMemoryOptions;
  constructor(options:EpisodeMemoryOptions){this.options=options;}
  get nativeConfiguration(){const {directory,executable,modelKey}=this.options;return {directory,executable,modelKey};}
  reflectForNative(request:ReflectionRequest,signal:AbortSignal){
    signal.throwIfAborted();
    if(!request||typeof request.system!=="string"||!Object.hasOwn(request,"input")||!Number.isSafeInteger(request.maxTokens)||request.maxTokens<1)throw new Error("Invalid native reflection request.");
    return this.options.reflect(request,signal);
  }
  close(){/* Native operations own and close their storage and subprocesses. */}
  private async native<T>(repository:DatabaseLocation,query:ProjectionQuery,action:string,fields:Record<string,unknown>={},signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    const client=new NativeApiServer({dbPath:repository.dbPath,episodeMemory:this});
    try{return await client.episode<T>(action,query,fields,signal);}
    finally{await new Promise<void>((resolve,reject)=>client.close(error=>error?reject(error):resolve()));}
  }
  inspect(repository:DatabaseLocation,query:ProjectionQuery){return this.native<Inspection[]>(repository,query,"inspect");}
  scenes(repository:DatabaseLocation,query:ProjectionQuery){return this.native<SourceScene[]>(repository,query,"scenes");}
  setDate(repository:DatabaseLocation,query:ProjectionQuery,slot:string,date:string){return this.native<Inspection[]>(repository,query,"date",{slot,date});}
  memorize(repository:DatabaseLocation,query:ProjectionQuery,slot:string,signal?:AbortSignal){return this.native<Publication>(repository,query,"memorize",{slot},signal);}
  recall(repository:DatabaseLocation,query:ProjectionQuery,actorId:string,cue:string,signal?:AbortSignal){return this.native<{publicationId:string;label:string;text:string}[]>(repository,query,"recall",{actorId,cue},signal);}
}
