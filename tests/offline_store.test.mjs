import test from "node:test";
import assert from "node:assert/strict";
import { OfflineStore, localHome, pending, retryDelay } from "../app/offline_store.ts";
const draft = (value = "a", stage = 2) => ({ version: 4, stage, value, questionnaireSubmittedAt: stage === 6 ? "2026-09-14T00:00:00Z" : null });
function setup() {
  let disk = null, fail = false;
  const persistence = { read: async () => structuredClone(disk), write: async value => { if (fail) throw Error("quota"); disk = structuredClone(value); } };
  const store = new OfflineStore(persistence);
  const bundle = { home: { sessionId: "s1", participantId: "P00001", practice: { completed: true }, progress: { completed: 0 },
    tasks: [1,2,3].map(taskOrder => ({ taskOrder })), canStartAnotherRun: false }, tasks: [1,2,3].map(i => ({
      taskId: "t"+i, taskOrder: i, caseId: "case"+i, condition: "skeleton_no_llm", revision: 0,
      entry: null, status: "pending", material: { pages: [{ imageUrl: "/page.jpg" }] },
    })) };
  return { store, bundle, persistence, fail: () => { fail = true; } };
}
const ack = flight => ({ operationId: flight.operationId, revision: flight.baseRevision + 1, completed: flight.kind === "complete" });
test("a late save ack cannot acknowledge newer work; its retry body stays immutable", async () => {
  const {store,bundle}=setup(); await store.install(bundle);
  await store.edit("t1",draft("old")); const flight=await store.next();
  await store.edit("t1",draft("new"));
  assert.deepEqual(await store.next(),flight);
  await store.acknowledge(flight.operationId,ack(flight));
  assert.equal(store.state.tasks[0].latest.value,"new"); assert.ok(pending(store.state));
  const next=await store.next(); assert.equal(next.entry.value,"new"); assert.notEqual(next.operationId,flight.operationId);
});
test("local submission unlocks immediately; frozen content survives refresh and late edits", async () => {
  const {store,bundle,persistence}=setup(); await store.install(bundle);
  await store.freeze("t1",draft("final",6)); await store.edit("t1",draft("stale"));
  assert.equal(localHome(store.state).tasks[0].uiStatus,"completed");
  assert.equal(localHome(store.state).tasks[1].uiStatus,"ready");
  const restored=new OfflineStore(persistence);await restored.load();await restored.install(bundle);
  assert.equal(restored.state.tasks[0].latest.value,"final");
  assert.equal((await restored.next()).kind,"complete");
});
test("three offline submissions drain in order; no active task replaces an older submission", async () => {
  const {store,bundle}=setup();await store.install(bundle);
  for(const id of ["t1","t2","t3"])await store.freeze(id,draft(id,6));
  assert.equal(localHome(store.state).allCompleted,true);assert.ok(pending(store.state));
  for(const id of ["t1","t2","t3"]) {
    const f=await store.next();assert.equal(f.taskId,id);
    await store.acknowledge(f.operationId,ack(f));
  }
  assert.equal(pending(store.state),false);
});
test("freezing during an in-flight autosave waits for its ack then uploads the final content", async () => {
  const {store,bundle}=setup();await store.install(bundle);await store.edit("t1",draft("old"));
  const old=await store.next();await store.freeze("t1",draft("final",6));
  assert.deepEqual(await store.next(),old);await store.acknowledge(old.operationId,ack(old));
  const final=await store.next();assert.equal(final.kind,"complete");assert.equal(final.entry.value,"final");
});
test("quota failure never shows local completion or discards the durable draft",async()=>{
  const {store,bundle,fail}=setup();await store.install(bundle);await store.edit("t1",draft("kept"));fail();
  await assert.rejects(store.freeze("t1",draft("final",6)));
  assert.equal(localHome(store.state).tasks[0].uiStatus,"active");assert.equal(store.state.tasks[0].latest.value,"kept");
  assert.equal(store.writes,0);
});
test("another identity/session cannot discard a pending outbox",async()=>{
  const {store,bundle}=setup();await store.install(bundle);await store.freeze("t1",draft("final",6));
  await assert.rejects(store.install({...bundle,home:{...bundle.home,sessionId:"other"}}));
  assert.equal(store.state.home.sessionId,"s1");
});
test("wrong acknowledgements preserve the frozen record and retry schedule is bounded",async()=>{
  const {store,bundle}=setup();await store.install(bundle);await store.freeze("t1",draft("final",6));
  const f=await store.next();await assert.rejects(store.acknowledge(f.operationId,{...ack(f),completed:false}));
  assert.deepEqual(await store.next(),f);
  assert.deepEqual([0,1,2,3,4,100].map(retryDelay),[2000,5000,10000,20000,30000,30000]);
});
