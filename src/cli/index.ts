#!/usr/bin/env node
import { NativeApiServer } from "../local-api/native-server.ts";
import { generateDoxveltText,type DoxveltGenerationRequest } from "../ai/generate.ts";

const client=new NativeApiServer({cliGeneration:(params,signal)=>generateDoxveltText({...params as DoxveltGenerationRequest,signal})});
const controller=new AbortController();
const abort=()=>controller.abort();
process.once("SIGINT",abort);process.once("SIGTERM",abort);
try {
  const result=await client.cli(process.argv.slice(2),controller.signal);
  console.log(typeof result==="string"?result:JSON.stringify(result,null,2));
}catch(error){console.error(error instanceof Error?error.message:"Native CLI operation failed.");process.exitCode=1;}
finally{process.removeListener("SIGINT",abort);process.removeListener("SIGTERM",abort);await new Promise<void>((resolve,reject)=>client.close(error=>error?reject(error):resolve()));}
