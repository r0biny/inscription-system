// Durable single-writer session outbox. No network request may mutate a live draft.
export type OfflineTask = {
  taskId: string; taskOrder: number; caseId: string; condition: string; material: any;
  revision: number; latest: any; seq: number; ackSeq: number;
  completed: boolean; frozen: boolean; submittedAt: string | null;
  flight: null | { operationId: string; sessionId: string; taskId: string; baseRevision: number; kind: string; entry: any; seq: number };
};
export type OfflineState = { home: any; tasks: OfflineTask[]; activeTaskId: string | null; assetsReady: boolean };
export type Persistence = { read(): Promise<OfflineState | null>; write(value: OfflineState | null): Promise<void> };
export function browserPersistence(databaseName: string): Persistence {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(databaseName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  return {
    async read() {
      const db = await open();
      try { return await new Promise<OfflineState | null>((resolve, reject) => {
        const r = db.transaction("state").objectStore("state").get("current");
        r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => reject(r.error);
      }); } finally { db.close(); }
    },
    async write(value) {
      const db = await open();
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("state", "readwrite", { durability: "strict" });
        if (value) tx.objectStore("state").put(value, "current"); else tx.objectStore("state").delete("current");
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("local_storage_failed"));
      }); } finally { db.close(); }
    },
  };
}
export class OfflineStore {
  persistence: Persistence;
  state: OfflineState | null = null;
  writes = 0;
  closed = false;
  queue: Promise<unknown> = Promise.resolve();
  constructor(persistence: Persistence) { this.persistence = persistence; }
  async load() { this.state = await this.persistence.read(); return this.state; }
  async change(update: (value: OfflineState | null) => OfflineState | null) {
    if (this.closed) throw new Error("本机记录已由其他页面接管");
    this.writes += 1;
    const operation = this.queue.then(async () => {
      const next = update(structuredClone(this.state));
      await this.persistence.write(next); // Publish only after durable commit.
      this.state = next;
    });
    this.queue = operation.catch(() => undefined);
    try { await operation; } finally { this.writes -= 1; }
  }
  async install(bundle: any) {
    await this.change((current) => {
      if (current && current.home.sessionId === bundle.home.sessionId) {
        current.home = bundle.home;
        // A local draft/frozen record wins; never silently replace it with server data.
        for (const remote of bundle.tasks) {
          const local = current.tasks.find(t => t.taskId === remote.taskId);
          if (!local) throw new Error("任务材料已变化，请联系研究者；本机记录保留。");
          if (!local.flight && local.seq === local.ackSeq && !local.frozen) {
            local.revision = remote.revision;
            local.latest = remote.entry;
            local.completed = remote.status === "completed";
          }
        }
        return current;
      }
      if (current && pending(current)) throw new Error("上一轮还有未上传记录，请先同步，不可切换身份或轮次。");
      return { home: bundle.home, activeTaskId: null, assetsReady: false, tasks: bundle.tasks.map((t: any) => ({
        ...t, latest: t.entry?.version ? t.entry : null, seq: 0, ackSeq: 0, flight: null,
        completed: t.status === "completed", frozen: false, submittedAt: t.completedAt ?? null,
      })) };
    });
  }
  async edit(taskId: string, draft: any) {
    const copy = structuredClone(draft);
    await this.change(state => {
      const task = state?.tasks.find(t => t.taskId === taskId);
      if (!state || !task) throw new Error("本机任务不存在");
      if (task.frozen || task.completed) return state; // Late debounce cannot unfreeze/overwrite.
      task.latest = copy; task.seq += 1; return state;
    });
  }
  async freeze(taskId: string, draft: any) {
    const copy = structuredClone(draft);
    await this.change(state => {
      const task = state?.tasks.find(t => t.taskId === taskId);
      if (!state || !task) throw new Error("本机任务不存在");
      if (!task.frozen && !task.completed) {
        task.latest = copy; task.seq += 1; task.frozen = true;
        task.submittedAt = copy.questionnaireSubmittedAt;
      }
      state.activeTaskId = null;
      return state;
    });
  }
  async next() {
    let flight: OfflineTask["flight"] = null;
    await this.change(state => {
      if (!state) return state;
      // First unfinished server task only. Later tasks never overtake it.
      const task = state.tasks.find(t => !t.completed);
      if (!task) return state;
      if (!task.flight && task.latest && (task.frozen || task.seq > task.ackSeq)) {
        task.flight = { operationId: crypto.randomUUID(), sessionId: state.home.sessionId,
          taskId: task.taskId, baseRevision: task.revision, kind: task.frozen ? "complete" : "draft",
          entry: structuredClone(task.latest), seq: task.seq };
      }
      flight = structuredClone(task.flight); return state;
    });
    return flight as OfflineTask["flight"];
  }
  async acknowledge(id: string, result: { operationId: string; revision: number; completed: boolean }) {
    await this.change(state => {
      const task = state?.tasks.find(t => t.flight?.operationId === id);
      if (!state || !task || !task.flight) return state;
      if (result.operationId !== id || result.revision !== task.flight.baseRevision + 1
        || result.completed !== (task.flight.kind === "complete")) throw new Error("保存确认不匹配，本机记录已保留");
      task.revision = result.revision; task.ackSeq = task.flight.seq;
      if (result.completed) task.completed = true;
      task.flight = null;
      // Keep frozen content locally for inherited survey answers and audit/recovery.
      return state;
    });
  }
}
export function pending(state: OfflineState | null) {
  return Boolean(state?.tasks.some(t => t.flight || (!t.completed && (t.frozen || t.seq > t.ackSeq))));
}
export function localHome(state: OfflineState) {
  const home = structuredClone(state.home);
  const done = state.tasks.filter(t => t.frozen || t.completed).length;
  const current = state.tasks.find(t => !t.frozen && !t.completed);
  home.progress.completed = done; home.allCompleted = done === state.tasks.length;
  home.canStartAnotherRun = home.canStartAnotherRun && !pending(state);
  home.tasks = home.tasks.map((card: any, i: number) => {
    const task = state.tasks[i], completed = task.frozen || task.completed;
    const unlocked = home.practice.completed && task === current;
    return { ...card, uiStatus: completed ? "completed" : unlocked ? task.latest ? "active" : "ready" : "locked",
      caseId: completed || unlocked ? task.caseId : null, condition: completed || unlocked ? task.condition : null,
      completedAt: task.submittedAt, preloadImageUrl: unlocked ? task.material.pages[0]?.imageUrl ?? "" : "" };
  });
  return home;
}
export function retryDelay(attempt: number) { return [2000, 5000, 10000, 20000, 30000][Math.min(attempt, 4)]; }
