import { labMaterials, labStorageKey, labUrl } from "./lab_runtime";
import { OfflineStore, pending, retryDelay, type OfflineState } from "./offline_store";
export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function offlineApi<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(labUrl(path), { ...init, credentials: "same-origin", signal: AbortSignal.timeout(25_000),
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  } catch { throw new RequestError("网络暂时不可用", 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(body?.message || "实验服务暂时无法连接", response.status);
  if (!body || body.ok !== true) throw new RequestError("保存确认无法读取", 0);
  return labMaterials(body) as T;
}
export class OfflineSync {
  store: OfflineStore;
  notify: (error?: string) => void;
  timer: ReturnType<typeof setTimeout> | null = null;
  running = false; stopped = false; blocked = false; attempt = 0;
  constructor(store: OfflineStore, notify: (error?: string) => void) { this.store = store; this.notify = notify; }
  schedule(delay = 0, reconnect = false) {
    if (this.stopped || this.blocked || this.running) return;
    if (this.timer && this.attempt > 0 && !reconnect) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, delay);
  }
  async run() {
    if (this.running || this.stopped || this.blocked) return;
    this.running = true;
    let retry = false;
    try {
      while (!this.stopped) {
        const flight = await this.store.next();
        if (!flight) break;
        const result = await offlineApi<{ operationId: string; revision: number; completed: boolean }>("/api/offline/sync",
          { method: "POST", body: JSON.stringify(flight) });
        if (this.stopped) return;
        await this.store.acknowledge(flight.operationId, result);
        this.attempt = 0; this.notify();
      }
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof RequestError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)) retry = true;
      else { this.blocked = true; this.notify((error as Error).message + "。本机记录保留，请勿清除浏览器数据。"); }
    } finally {
      this.running = false;
      if (retry) this.schedule(retryDelay(this.attempt++));
      else if (!this.blocked && pending(this.store.state)) this.schedule(2000);
    }
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}

// Download allocated, condition-filtered materials plus the application shell.
// Limit concurrent downloads so preparation does not flood the connection.
export async function prepareOfflineAssets(state: OfflineState) {
  if (!("serviceWorker" in navigator) || !("caches" in window)) throw new Error("浏览器不支持离线材料缓存");
  await navigator.serviceWorker.register(labUrl("/offline_sw.js"), { scope: labUrl("/") });
  await navigator.serviceWorker.ready;
  await import("openseadragon");
  if (document.readyState !== "complete") await new Promise<void>(resolve => window.addEventListener("load", () => resolve(), { once: true }));
  const cache = await caches.open(labStorageKey("offline-static-v1"));
  const urls = new Set<string>([labUrl("/")]);
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith("Url") && typeof item === "string" && item.startsWith(labUrl("/study-data/"))) urls.add(item);
      else if (typeof item === "object") walk(item);
    }
  };
  state.tasks.forEach(t => walk(t.material)); walk(state.home);
  // Module resource timings can appear after hydration. DOM references are the
  // authoritative boot resources; wait for load before collecting dependencies.
  for (const element of document.querySelectorAll("script[src],link[rel=stylesheet],link[rel=modulepreload]")) {
    const path = element.getAttribute("src") || element.getAttribute("href");
    if (path) {
      const url = new URL(path, location.href);
      if (url.origin === location.origin && url.pathname.startsWith(labUrl("/"))) urls.add(url.pathname + url.search);
    }
  }
  for (const item of performance.getEntriesByType("resource")) {
    const url = new URL(item.name);
    if (url.origin === location.origin && url.pathname.startsWith(labUrl("/")) && /\.(js|css|woff2)$/.test(url.pathname)) urls.add(url.pathname + url.search);
  }
  const todo = [...urls];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (todo.length) {
      const url = todo.shift()!;
      if (url !== labUrl("/") && await cache.match(url)) continue;
      const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(25_000),
        ...(url === labUrl("/") ? { headers: { accept: "text/html" } } : {}) });
      if (!response.ok) throw new Error("部分离线材料尚未下载");
      await cache.put(url, response);
    }
  }));
}
