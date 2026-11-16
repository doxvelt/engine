import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeApiServer } from "../src/local-api/native-server.ts";

const root=await mkdtemp(path.join(os.tmpdir(),"doxvelt-native-smoke-"));
const client=new NativeApiServer({});
const common=["--db",path.join(root,"runtime.sqlite"),"--simulation","smoke","--branch","main","--json"];
const cli=(...args:string[])=>client.cli([...args,...common]) as Promise<Record<string,any>>;
try {
  const started=await cli("start",path.resolve("examples/executive-interviews"),"--scenario","executive-interviews","--command","smoke-start");
  const turn=await cli("turn","ceo","--manual","We need to understand what is really going on.","--audience","student-team","--expected-head",started.head,"--command","smoke-turn");
  const context=await cli("context","student-team");
  if(!context.promptPreview.includes("really going on"))throw new Error("Subjective transcript projection failed.");
  const closure=await cli("close-episode","--label","Smoke episode","--expected-head",turn.commit.id,"--command","smoke-close");
  if(!closure.memories.length||!closure.extractedBeliefs.length)throw new Error("Branch closure projection failed.");
}finally{await new Promise<void>((resolve,reject)=>client.close(error=>error?reject(error):resolve()));await rm(root,{recursive:true,force:true});}
console.log("smoke ok (native branch-aware manual engine)");
