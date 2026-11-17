import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { EpisodeMemory } from "../src/memory/episodes.ts";
import { activateWorkspace, createCollectionObject, startCollectionStory, workspaceCollection, workspaceLocation,
  exportWorkspaceArchive, previewWorkspaceImport, importWorkspaceArchive, readWorkspaceConfiguration,
} from "../src/application/workspace-collection.ts";
import { fingerprintCommand as fingerprint } from "../src/core/domain-rules.ts";

const executable=process.env.DOXVELT_REVERIE_EXECUTABLE;
const available={skip:!executable&&"Set DOXVELT_REVERIE_EXECUTABLE for native archive integration."};
async function fixture(t: any){
  const parent=await mkdtemp(path.join(tmpdir(),"doxvelt-archive-"));const root=path.join(parent,"original");await mkdir(root);
  await activateWorkspace(root);
  for(const [kind,id,body] of [["world","river","A river valley."],["scenario","crossing","A ferry crossing."],["format","script","Short prose."],["character","corin","A ferryman. :+3"],["character","nell","A traveller. :+3"]] as const)
    await createCollectionObject(root,{kind,id,name:id,body});
  let modelCalls=0;
  const memoryFor=(folder:string)=>new EpisodeMemory({directory:path.join(folder,".doxvelt/memory"),executable:executable??"",modelKey:"scripted",
    async reflect(){modelCalls++;return JSON.stringify({memories:[{gist:"I remember a warm coat.",detail:"At the ferry landing.",feeling:"Safe.",cues:["coat"],salience:0.8,confidence:0.9,sourceMessageIds:["m1"]}],impressions:[{text:"I trust the ferryman.",sourceEpisodeIds:["e1"]}]});}});
  const memory=memoryFor(root);const location=await workspaceLocation(root);
  const setup={operationId:"first",collectionRevision:(await workspaceCollection(root)).revision,worldId:"river",scenarioId:"crossing",formatId:"script",characterIds:["corin","nell"],date:"2000-01-01"};
  const started=await startCollectionStory(root,setup,memory);
  const server=createLocalApiServer({dbPath:location.database,episodeMemory:memory,sceneHeadings:{nativeDatabase:path.join(location.data,"scene-headings.sqlite")}});
  async function api(url:string,body?:Record<string,unknown>){
    const req=new IncomingMessage(new Socket());req.url=url;req.method=body?"POST":"GET";req.headers={"content-type":"application/json"};if(body)req.push(JSON.stringify(body));req.push(null);
    const result=await new Promise<{code:number;value:any}>(resolve=>{const res=new ServerResponse(req);res.end=((text:string)=>{resolve({code:res.statusCode,value:JSON.parse(text)});return res;}) as typeof res.end;server.emit("request",req,res);});
    assert.equal(result.code,200,JSON.stringify(result.value));return result.value;
  }
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));memory.close();await rm(parent,{recursive:true,force:true});});
  return {parent,root,memory,memoryFor,location,started,setup,api,calls:()=>modelCalls};
}
test("workspace archives preserve accepted branches, authored collection, dates, annotations and exact native memories",available,async t=>{
  const f=await fixture(t);const base="/simulations/"+f.started.simulationId;
  let head=(await f.api(base+"/stage")).branch.headCommitId;
  await f.api(base+"/scene-headings",{branchId:"main",expectedHead:head,commandId:"heading",title:"  At the landing  "});
  const turn=await f.api(base+"/turns",{branchId:"main",expectedHead:head,commandId:"turn",actorId:"corin",audience:["nell"],manualText:"Take my warm coat.",stageWhisperIds:[],knowledgePolicy:"actor-knowledge-v1"});head=turn.branch.headCommitId;
  await f.api(base+"/episode-memory/memorize",{branchId:"main",expectedHead:head,commandId:"memorize",slot:"first"});
  assert.equal(f.calls(),2);
  // Preserve an older, drifted publication too, independent of the latest dates.
  await f.api(base+"/episode-memory/date",{branchId:"main",expectedHead:head,commandId:"redate",slot:"first",date:"2000-02-01"});
  await f.api(base+"/episode-memory/memorize",{branchId:"main",expectedHead:head,commandId:"rememorize",slot:"first"});
  await f.api(base+"/fork",{branchId:"main",expectedHead:head,commandId:"fork",atCommitId:head,newBranchId:"alternate"});
  await startCollectionStory(f.root,{...f.setup,operationId:"second"},f.memory);
  await writeFile(path.join(f.root,".env"),"PRIVATE_CREDENTIAL");await mkdir(path.join(f.root,".dsh"));await writeFile(path.join(f.root,".dsh/session.json"),"PRIVATE_DSH_CHAT");
  await writeFile(path.join(f.root,"notes.txt"),"api_key: PRIVATE_KEY\nordinary: keep\n");
  const calls=f.calls();const packageDir=path.join(f.parent,"archive");
  const exported=await exportWorkspaceArchive(f.root,packageDir,f.memory);
  assert.equal(exported.summary.stories,2);assert.equal(exported.summary.branches,3);assert.equal(exported.summary.characterMemories,4);
  const data=JSON.parse(await readFile(path.join(packageDir,"workspace.json"),"utf8"));
  assert.equal(data.memories.length,4);assert.equal(data.stories[0].sceneHeadings.length,1);
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE_CREDENTIAL|PRIVATE_KEY|PRIVATE_DSH_CHAT/);
  assert.doesNotMatch(JSON.stringify(data),new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  await assert.rejects(access(path.join(packageDir,"source/.env")));await assert.rejects(access(path.join(packageDir,"source/.dsh")));
  assert.match(await readFile(path.join(packageDir,"source/notes.txt"),"utf8"),/\[redacted\]/);
  const restored=path.join(f.parent,"restored");const preview=await previewWorkspaceImport(f.root,packageDir,restored,f.memory);
  assert.equal(preview.summary.archiveHash,exported.summary.archiveHash);assert.equal(preview.summary.modelCalls,0);
  assert.equal((await importWorkspaceArchive(f.root,packageDir,restored,preview.summary.archiveHash,f.memory)).status,"imported");
  assert.equal((await importWorkspaceArchive(f.root,packageDir,restored,preview.summary.archiveHash,f.memory)).status,"current");
  assert.deepEqual(await readWorkspaceConfiguration(restored),{version:1});
  const restoredMemory=f.memoryFor(restored);
  const reexport=path.join(f.parent,"reexport");await exportWorkspaceArchive(restored,reexport,restoredMemory);
  const roundTrip=JSON.parse(await readFile(path.join(reexport,"workspace.json"),"utf8"));
  assert.deepEqual(roundTrip,data);assert.equal(f.calls(),calls,"Export, validation, import and restart never call a model");
});

test("damaged archives, source changes, occupied destinations and pre-cancelled transfers cannot publish",async t=>{
  const f=await fixture(t);const packageDir=path.join(f.parent,"archive");await exportWorkspaceArchive(f.root,packageDir,f.memory);
  const target=path.join(f.parent,"restored");const preview=await previewWorkspaceImport(f.root,packageDir,target,f.memory);
  await assert.rejects(importWorkspaceArchive(f.root,packageDir,target,"unreviewed",f.memory),/changed after review/);
  await assert.rejects(importWorkspaceArchive(f.root,packageDir,target,preview.summary.archiveHash,f.memory,AbortSignal.abort()));
  await assert.rejects(access(target));
  const source=path.join(packageDir,"source/worlds/river.md");const original=await readFile(source,"utf8");await writeFile(source,original+"\nChanged after export.");
  await assert.rejects(importWorkspaceArchive(f.root,packageDir,target,preview.summary.archiveHash,f.memory),/integrity/);await assert.rejects(access(target));await writeFile(source,original);
  await mkdir(target);await writeFile(path.join(target,"keep.txt"),"Keep existing workspace");
  await assert.rejects(importWorkspaceArchive(f.root,packageDir,target,preview.summary.archiveHash,f.memory),/already exists/);
  assert.equal(await readFile(path.join(target,"keep.txt"),"utf8"),"Keep existing workspace");
  const another=path.join(f.parent,"cancelled-export");await assert.rejects(exportWorkspaceArchive(f.root,another,f.memory,AbortSignal.abort()));await assert.rejects(access(another));
  // A self-consistent outer package still cannot substitute forged native data.
  const forged=path.join(f.parent,"forged");await cp(packageDir,forged,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(forged,"workspace.json"),"utf8"));manifest.version=999;delete manifest.checksum;manifest.checksum=fingerprint(manifest);
  await writeFile(path.join(forged,"workspace.json"),JSON.stringify(manifest));
  await assert.rejects(previewWorkspaceImport(f.root,forged,path.join(f.parent,"forged-target"),f.memory),/Unsupported/);
});

test("native-memory failure leaves no restored workspace and the same reviewed archive can be retried",available,async t=>{
  const f=await fixture(t);const base="/simulations/"+f.started.simulationId;
  const head=(await f.api(base+"/stage")).branch.headCommitId;
  const turn=await f.api(base+"/turns",{branchId:"main",expectedHead:head,commandId:"turn",actorId:"corin",audience:["nell"],manualText:"Take my coat.",stageWhisperIds:[],knowledgePolicy:"actor-knowledge-v1"});
  await f.api(base+"/episode-memory/memorize",{branchId:"main",expectedHead:turn.branch.headCommitId,commandId:"memorize",slot:"first"});
  const packageDir=path.join(f.parent,"archive");await exportWorkspaceArchive(f.root,packageDir,f.memory);
  const target=path.join(f.parent,"restored");const preview=await previewWorkspaceImport(f.root,packageDir,target,f.memory);
  const unavailable={nativeConfiguration:{...f.memory.nativeConfiguration,executable:path.join(f.parent,"missing-reverie.exe")}};
  await assert.rejects(importWorkspaceArchive(f.root,packageDir,target,preview.summary.archiveHash,unavailable),/Could not start Reverie/);
  await assert.rejects(access(target));
  assert.equal((await importWorkspaceArchive(f.root,packageDir,target,preview.summary.archiveHash,f.memory)).status,"imported");
  assert.equal((await f.api(base+"/episode-memory?branchId=main")).episodes[0].status,"current");
  assert.equal(f.calls(),2);
});
