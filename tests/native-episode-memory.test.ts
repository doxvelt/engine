import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { EpisodeMemory } from "../src/memory/episodes.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { nativeRequest } from "./helpers/native-api.ts";

test("native episode dates, projections and catalog agree through HTTP and the native client", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"doxvelt-native-episode-catalog-"));
  const database=path.join(root,"story.sqlite");const directory=path.join(root,"memory");
  const memory=new EpisodeMemory({directory,executable:"unavailable-reverie",modelKey:"fixture",reflect:async()=>{throw new Error("No reflection expected");}});
  const callbacks={"host.features":()=>({episodeMemory:memory.nativeConfiguration})};
  try {
    const started=await nativeRequest("/simulations/start",{simulationId:"sim",branchId:"main",commandId:"start",workspacePath:path.resolve("examples/last-crossing")},database);
    const turn=await nativeRequest("/simulations/sim/turns",{branchId:"main",expectedHead:started.root.id,commandId:"turn",actorId:"corin",manualText:"A private occurrence.",audience:["corin"],stageWhisperIds:[],knowledgePolicy:"actor-knowledge-v1"},database);
    const base={branchId:"main",expectedHead:turn.commit.id,commandId:"date",slot:"first"};
    const store=await openBranchStore(database).open();
    try {
      const query={ownerScope:"local",simulationId:"sim",branchId:"main"};
      assert.deepEqual((await nativeRequest("/simulations/sim/episode-memory",undefined,database,200,callbacks)).episodes,await memory.inspect(store,query));
      const dated=await nativeRequest("/simulations/sim/episode-memory/date",{...base,date:"2000-02-29"},database,200,callbacks);
      assert.deepEqual(dated.episodes,await memory.inspect(store,query));
      await memory.setDate(store,query,"first","1999-01-01");
      assert.deepEqual((await nativeRequest("/simulations/sim/episode-memory",undefined,database,200,callbacks)).episodes,await memory.inspect(store,query));
      await nativeRequest("/simulations/sim/episode-memory/date",{...base,date:"2001-02-29"},database,400,callbacks);
      await nativeRequest("/simulations/sim/episode-memory/date",{...base,slot:"unavailable",date:"2000-01-01"},database,404,callbacks);
      await nativeRequest("/simulations/sim/episode-memory/date",{...base,expectedHead:started.root.id,date:"2000-01-01"},database,409,callbacks);
      const before=store.exportSimulation("local","sim");
      await nativeRequest("/simulations/sim/episode-memory/memorize",base,database,503,callbacks);
      assert.deepEqual(store.exportSimulation("local","sim"),before);
      for(let i=0;i<100 && (await readdir(directory)).some(f=>f!=="catalog.sqlite");i++) await new Promise(r=>setTimeout(r,10));
      assert.deepEqual(await readdir(directory),["catalog.sqlite"]);
    } finally {store.close();}
  } finally {memory.close();await rm(root,{recursive:true,force:true});}
});

const executable=process.env.DOXVELT_REVERIE_EXECUTABLE;
for(const mode of ["abort","race"] as const) test(`native Reverie ${mode} preserves publication ownership and accepted history`,{
  skip:!executable&&"Set DOXVELT_REVERIE_EXECUTABLE for the independent native engine.",timeout:30_000,
},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"doxvelt-native-memory-ownership-"));const database=path.join(root,"story.sqlite");const directory=path.join(root,"memory");
  let entered!:()=>void;const running=new Promise<void>(r=>{entered=r;});let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let calls=0;let retried=false;let aborted=false;
  const memory=new EpisodeMemory({directory,executable:executable!,modelKey:"fixture",async reflect(_request,signal){
    calls++;
    if(mode==="abort"&&!retried){entered();await new Promise<void>((_r,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(new Error("PRIVATE REFLECTION FAILURE"));},{once:true}));}
    if(mode==="race"){if(calls===2){entered();release();}await barrier;}
    return JSON.stringify({memories:[{gist:"I remember a private occurrence.",detail:"",feeling:"",cues:["occurrence"],salience:0.9,confidence:0.8,sourceMessageIds:["m1"]}],impressions:[]});
  }});
  const server=createLocalApiServer({dbPath:database,episodeMemory:memory});
  const request=(target:string,body:Record<string,unknown>)=>new Promise<{status:number;body:any}>(resolve=>{
    const incoming=new IncomingMessage(new Socket());incoming.method="POST";incoming.url=target;incoming.headers={"content-type":"application/json"};incoming.push(JSON.stringify(body));incoming.push(null);
    const response=new ServerResponse(incoming);response.end=((text:string)=>{resolve({status:response.statusCode,body:JSON.parse(text)});return response;}) as typeof response.end;server.emit("request",incoming,response);
  });
  try {
    const started=await request("/simulations/start",{simulationId:"sim",branchId:"main",commandId:"start",workspacePath:path.resolve("examples/last-crossing")});assert.equal(started.status,200);
    const performed=await request("/simulations/sim/turns",{branchId:"main",expectedHead:started.body.root.id,commandId:"turn",actorId:"corin",manualText:"A private occurrence.",audience:["corin"],stageWhisperIds:[],knowledgePolicy:"actor-knowledge-v1"});assert.equal(performed.status,200);
    const body={branchId:"main",expectedHead:performed.body.commit.id,commandId:"memorize",slot:"first"};
    assert.equal((await request("/simulations/sim/episode-memory/date",{...body,date:"2000-01-01"})).status,200);
    const store=await openBranchStore(database).open();const before=store.exportSimulation("local","sim");store.close();
    const first=request("/simulations/sim/episode-memory/memorize",body);
    if(mode==="abort"){
      await running;server.closeAllConnections();assert.equal((await first).status,503);
      for(let i=0;i<200&&(!aborted||(await readdir(directory)).some(f=>f!=="catalog.sqlite"));i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(aborted,true);assert.deepEqual(await readdir(directory),["catalog.sqlite"]);
      const catalog=new DatabaseSync(path.join(directory,"catalog.sqlite"));try{assert.equal(catalog.prepare("SELECT count(*) AS n FROM memory_versions").get()!.n,0);}finally{catalog.close();}
      retried=true;const retry=await request("/simulations/sim/episode-memory/memorize",body);assert.equal(retry.status,200);assert.equal(retry.body.status,"published");
    } else {
      const second=request("/simulations/sim/episode-memory/memorize",{...body,commandId:"competitor"});await running;
      const results=await Promise.all([first,second]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.deepEqual(results.map(r=>r.body.status).sort(),["current","published"]);
    }
    const catalog=new DatabaseSync(path.join(directory,"catalog.sqlite"));try{
      const rows=catalog.prepare("SELECT data FROM memory_versions").all();assert.equal(rows.length,1);
      const published=JSON.parse(String(rows[0]!.data));assert.equal(published.characters.length,1);
      assert.deepEqual((await readdir(directory)).sort(),["catalog.sqlite",published.characters[0].file].sort());
    }finally{catalog.close();}
    const after=await openBranchStore(database).open();try{assert.deepEqual(after.exportSimulation("local","sim"),before);}finally{after.close();}
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));memory.close();await rm(root,{recursive:true,force:true});}
});
