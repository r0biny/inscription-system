// Local fake Worker for browser tests. Never connects to Cloudflare or stores participant data.
import assert from "node:assert/strict";
import http from "node:http";
import {readFile} from "node:fs/promises";
import {createAppServer} from "../../server.mjs";
import {readConfig} from "../../lab_config.mjs";

const listen=async server=>{await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));return "http://127.0.0.1:"+server.address().port;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
export async function startFixture(){
  const practice=JSON.parse(await readFile(new URL("../../study-materials/online/practice-case.json",import.meta.url)));
  const tasks=["skeleton_no_llm","skeleton_llm_assisted","outline_no_llm"].map((condition,i)=>({
    taskId:"fixture-"+(i+1),taskOrder:i+1,caseId:"case_0"+(i+1),condition,status:"ready",revision:0,entry:null,completedAt:null,
    material:{...structuredClone(practice),id:"case_0"+(i+1)}
  }));
  let practiceCompleted=false;const receipts=new Map(),requests=[];
  const home=()=>({
    ok:true,status:"home",participantId:"P00001",sessionId:"lab-offline-fixture",caseSetId:"case_balanced_gaussian_v1",
    practice:{completed:practiceCompleted,completedAt:practiceCompleted?"2026-09-14T00:00:00Z":null,version:practiceCompleted?1:0,currentVersion:1},
    progress:{completed:tasks.filter(t=>t.status==="completed").length,total:3},allCompleted:tasks.every(t=>t.status==="completed"),canStartAnotherRun:false,
    tutorialAuthoring:null,history:[],tasks:tasks.map(t=>{
      const current=t===tasks.find(t=>t.status!=="completed"),visible=t.status==="completed"||practiceCompleted&&current;
      return {taskOrder:t.taskOrder,uiStatus:t.status==="completed"?"completed":practiceCompleted&&current?"ready":"locked",
        caseId:visible?t.caseId:null,condition:visible?t.condition:null,stage:visible?t.entry?.stage??1:null,completedAt:t.completedAt,
        coverImageUrl:"/study-data/home-covers/cover_0"+t.taskOrder+".jpg",preloadImageUrl:visible?t.material.pages[0].imageUrl:""};
    })
  });
  const upstream=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);
      const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):{};
      requests.push({path:req.url,method:req.method,raw,cookie:req.headers.cookie});
      res.setHeader("content-type","application/json");
      const send=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data));};
      if(req.url==="/api/status")return send(200,{ok:true,databaseReady:true,isOpen:true,canCreateSession:true,llmMaterialsReady:true});
      if(req.url==="/api/participant/start"){
        res.setHeader("set-cookie","paper1_session=fixture; Path=/; HttpOnly; Secure; SameSite=Lax");return send(201,home());
      }
      if(!req.headers.cookie?.includes("paper1_session=fixture"))return send(200,{ok:true,status:"anonymous"});
      if(req.url==="/api/participant/session")return send(200,home());
      if(req.url==="/api/practice/complete"){
        assert.deepEqual(body,{practiceVersion:1,completionMode:"walkthrough",viewedSteps:["roadmap","observation","judgment","outline","skeleton","review","survey"]});
        practiceCompleted=true;return send(200,home());
      }
      if(req.url==="/api/offline/bundle")return send(200,{ok:true,home:home(),tasks});
      if(req.url==="/api/offline/sync"){
        if(receipts.has(body.operationId)){
          const old=receipts.get(body.operationId);assert.equal(raw,old.raw,"Retry must preserve exact body");return send(200,old.reply);
        }
        const task=tasks.find(t=>t.status!=="completed");
        if(!task||body.taskId!==task.taskId||body.baseRevision!==task.revision)return send(409,{ok:false,message:"revision or order conflict"});
        task.entry=body.entry;task.revision++;task.status=body.kind==="complete"?"completed":"active";task.completedAt=task.status==="completed"?body.entry.questionnaireSubmittedAt:null;
        const reply={ok:true,operationId:body.operationId,revision:task.revision,completed:task.status==="completed"};
        receipts.set(body.operationId,{raw,reply});return send(200,reply);
      }
      if(req.url==="/api/participant/logout"){
        res.setHeader("set-cookie","paper1_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");return send(200,{ok:true});
      }
      if(req.url==="/api/session/heartbeat")return send(200,{ok:true});
      return send(404,{ok:false,message:"Unknown mock path"});
    }catch(e){res.statusCode=500;res.end(JSON.stringify({ok:false,message:e.message}));}
  });
  const upstreamOrigin=await listen(upstream),config={...readConfig(),upstreamOrigin};
  const built=JSON.parse(await readFile(new URL("../../dist/build_info.json",import.meta.url)));
  assert.equal(config.basePath,built.basePath);
  const lab=createAppServer(config),origin=await listen(lab);config.publicOrigin=origin;
  return {base:origin+config.basePath+"/",origin,config,tasks,requests,close:async()=>{await close(lab);await close(upstream);}};
}
