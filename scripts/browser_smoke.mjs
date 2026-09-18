import {startFixture} from "../tests/fixtures/mock_worker.mjs";
// Standalone Music X Lab browser regression with local fake Worker only.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
let fixture=await startFixture();
if(process.env.NGINX_BINARY){
  const {startNginxFixture}=await import('../tests/fixtures/nginx_static.mjs');
  const original=fixture;
  let nginx;
  try { nginx=await startNginxFixture(original.config); }
  catch(error) { await original.close(); throw error; }
  fixture={...original,...nginx,close:async()=>{await nginx.close();await original.close();}};
}
const base=fixture.base;
assert.ok(["127.0.0.1","localhost"].includes(new URL(base).hostname));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1100}});
let blockWrites=true, loseFirstReply=true;
await context.route("**/api/offline/sync",async route=>{
  if(blockWrites)return route.abort("internetdisconnected");
  if(loseFirstReply){loseFirstReply=false;await route.fetch();return route.abort("connectionreset");}
  return route.continue();
});
const email="offline-browser-"+randomUUID()+"@example.test";
const page=await context.newPage();page.setDefaultTimeout(20000);
let leaveWarnings=0;
page.on("dialog", async dialog => { if (dialog.type()==="beforeunload")leaveWarnings++; await dialog.accept(); });
const wrongRequests=[];page.on("request",r=>{const u=new URL(r.url());if(["http:","https:"].includes(u.protocol)&&(u.origin!==fixture.origin||!u.pathname.startsWith(fixture.config.basePath+"/")))wrongRequests.push(r.url());});
const errors=[];page.on("pageerror",error=>errors.push(error.message));
const failed=[];page.on("requestfailed",r=>failed.push({url:r.url(),error:r.failure()?.errorText}));
const readState=()=>page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("paper1_lab:"+new URL("./",location.href).pathname+":offline-outbox-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const r=db.transaction("state").objectStore("state").get("current");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}
});
const waitState=async predicate=>{
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    if(predicate(await readState()))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("Timed out waiting for durable local state");
};
try{
  await page.goto(base);
  await page.getByRole("button",{name:"查看参与说明"}).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator("#identity-consent").check();
  await page.getByRole("button",{name:"进入 Dashboard"}).click();
  await page.getByRole("heading",{name:"Dashboard",exact:true}).waitFor();
  await page.getByRole("button",{name:"开始新手引导"}).click();
  const guide=page.getByRole("dialog",{name:"新手引导步骤说明"});
  for(let i=0;i<6;i++)await guide.getByRole("button",{name:"下一步"}).click();
  await guide.getByRole("button",{name:"完成新手引导"}).click();
  await page.getByRole("heading",{name:"Dashboard",exact:true}).waitFor();
  await waitState(s=>s?.assetsReady);
  const scopes=await page.evaluate(async()=> (await navigator.serviceWorker.getRegistrations()).map(r=>r.scope));
  assert.deepEqual(scopes,[base],"Worker scope stays in the experiment subdirectory");
  const cacheKeys=await page.evaluate(async()=>{const cache=await caches.open("paper1_lab:"+new URL("./",location.href).pathname+":offline-static-v1");return (await cache.keys()).map(r=>r.url);});
  assert.ok(cacheKeys.every(k=>k.startsWith(base)&&!k.includes("/api/")),"Only experiment static resources are cached");
  const second=await context.newPage();await second.goto(base);
  await second.getByText("实验已在另一个标签页打开，请关闭其他实验页面后刷新。").waitFor();await second.close();
  await page.getByRole("button",{name:"开始任务",exact:true}).click();
  await page.getByRole("navigation",{name:"任务进度"}).waitFor();
  await waitState(s=>!!s?.tasks[0].latest?.version);
  await context.setOffline(true);
  // Fill synthetic stage-5 records to exercise the real submit buttons without repeating the full tutorial.
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open("paper1_lab:"+new URL("./",location.href).pathname+":offline-outbox-v1",1);r.onsuccess=()=>resolve(r.result);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("state","readwrite"),os=tx.objectStore("state"),r=os.get("current");
      r.onsuccess=()=>{
        const s=r.result,template=s.tasks[0].latest,at=new Date().toISOString();
        s.tasks.forEach(t=>{
          const d=structuredClone(template);
          d.config={participantId:s.home.participantId,sessionId:s.home.sessionId,taskOrder:t.taskOrder,caseId:t.caseId,condition:t.condition};
          d.caseId=t.caseId;d.stage=5;d.pauseStartedAt=null;d.pausePeriods=[];d.restorationSubmittedAt=at;
          d.activePageId=t.material.pages[0].id;d.activeCharacterId=t.material.targets[0].id;
          d.reviewNote="/study-data/do-not-rewrite-user-content";d.difficulty=3;d.aiHelpfulness=3;d.inputReport={device:"computer",inputMethod:"mouse",deviceOther:"",inputMethodOther:"",prefilledFromTaskOrder:null};
          d.answers=Object.fromEntries(t.material.targets.map(g=>[g.id,{hypothesis:"测",selectionSource:"custom",candidateRank:null,rejectedAll:true,
            characterConfidence:3,drawingConfidence:3,finalDrawingPng:null,
            strokes:[{id:"synthetic-"+g.id,tool:"brush",width:4,pointerType:"mouse",points:[{x:50,y:50},{x:70,y:80}]}]}]));
          t.latest=d;t.seq++;t.flight=null;
        });os.put(s,"current");
      };tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });db.close();
  });
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("navigation",{name:"任务进度"}).waitFor();
  for(let i=0;i<3;i++){
    // Reload/open is paused by design; resume locally before submitting.
    await page.getByRole("button",{name:"继续任务",exact:true}).click();
    await page.getByRole("button",{name:i<2?/提交问卷并完成本项任务/:/提交问卷并完成全部任务/}).click();
    await page.getByRole("heading",{name:"Dashboard",exact:true}).waitFor();
    const state=await readState();assert.equal(state.tasks.filter(t=>t.frozen).length,i+1);
    assert.equal(state.tasks.filter(t=>t.completed).length,0);
    if(i<2){
      await page.reload({waitUntil:"domcontentloaded"});
      await page.getByRole("heading",{name:"Dashboard",exact:true}).waitFor();
      await page.getByRole("button",{name:"继续任务",exact:true}).click();
      await page.getByRole("navigation",{name:"任务进度"}).waitFor();
    }
  }
  await page.getByText("任务已在本机完成，记录仍在后台上传。离开前请保持联网，等待此提示消失。").waitFor();
  await page.getByRole("button",{name:"退出当前身份"}).click();
  await page.getByText(/还有记录正在等待上传/).waitFor();
  const frozen=(await readState()).tasks.map(t=>JSON.stringify(t.latest));
  blockWrites=false;await context.setOffline(false);
  await waitState(s=>s?.tasks.every(t=>t.completed));
  assert.deepEqual((await readState()).tasks.map(t=>JSON.stringify(t.latest)),frozen);
  assert.ok(leaveWarnings>0,"Pending records should trigger the browser leave confirmation");
  const remote=await page.evaluate(async()=> (await fetch(new URL("api/participant/session",location.href))).json());assert.equal(remote.allCompleted,true);
  const saved=await page.evaluate(async()=> (await fetch(new URL("api/offline/bundle",location.href))).json());
  assert.deepEqual(saved.tasks.map(t=>JSON.stringify(t.entry)),frozen);
  assert.deepEqual(errors,[]);
  assert.deepEqual(wrongRequests,[],"Browser never bypasses lab proxy or accesses another site path");
  await page.getByRole("button",{name:"退出当前身份"}).click();
  await page.getByRole("button",{name:"查看参与说明"}).waitFor();
  assert.equal((await context.cookies()).filter(c=>c.name===fixture.config.cookieName).length,0);
  console.log("Browser offline test passed: single tab lock, cached reload, three local submits/unlocks, exit warning, ordered reconnect, lost reply retry, frozen records unchanged.");
}catch(error){
  console.log(JSON.stringify({errors,failed}));
  console.log(await page.evaluate(async()=>{const c=await caches.open("paper1_lab:"+new URL("./",location.href).pathname+":offline-static-v1");const keys=await c.keys();return Promise.all(keys.filter(k=>k.url.includes("/assets/")).slice(0,12).map(async k=>({url:k.url,vary:(await c.match(k,{ignoreVary:true}))?.headers.get("vary")})));}));
  console.log((await page.locator("body").innerText()).slice(-2500));
  console.log(JSON.stringify((await readState())?.tasks.map(t=>({order:t.taskOrder,stage:t.latest?.stage,frozen:t.frozen}))));
  throw error;
}finally{await browser.close();await fixture.close();}
