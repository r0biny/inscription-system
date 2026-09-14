import { DEFAULT_CASE_ID, normalizeStudyCondition, type StudyCondition } from "./study-data";
import { labStorageKey } from "./lab_runtime";

export const CONFIG_KEY = labStorageKey("config");
export const DRAFT_KEY = labStorageKey("active-draft");
const ARCHIVE_DB_NAME = labStorageKey("local-archive");
const ARCHIVE_STORE_NAME = "handles";
const ARCHIVE_ROOT_KEY = "paper1-root-v2";

type DirectoryPermissionMode = "read" | "readwrite";
type PermissionedDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (options: { mode: DirectoryPermissionMode }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: DirectoryPermissionMode }) => Promise<PermissionState>;
};
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: DirectoryPermissionMode;
      startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export type DraftArchiveResult = "saved" | "not_configured" | "permission_required" | "unsupported" | "error";

export type LocalDraftArchive = {
  folderName: string;
  entryKind: "file" | "legacy_directory";
  directoryHandle: FileSystemDirectoryHandle;
  archivedAt: string;
  draft: Record<string, unknown>;
};

export type DiscardDraftResult = "discarded" | "not_found" | "permission_required" | "completed" | "error";

export type StudyConfig = {
  participantId: string;
  sessionId: string;
  condition: StudyCondition;
  caseId: string;
  taskOrder: number;
};

const padTwoDigits = (value: number) => String(value).padStart(2, "0");

export function createSessionId(date = new Date()) {
  const datePart = [date.getFullYear() % 100, date.getMonth() + 1, date.getDate()].map(padTwoDigits).join("");
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map(padTwoDigits).join("");
  return `S-${datePart}-${timePart}`;
}

export const defaultConfig: StudyConfig = {
  participantId: "P001",
  sessionId: "",
  condition: "skeleton_no_llm",
  caseId: DEFAULT_CASE_ID,
  taskOrder: 1,
};

function openArchiveDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(ARCHIVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ARCHIVE_STORE_NAME)) database.createObjectStore(ARCHIVE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeArchiveRoot(handle: FileSystemDirectoryHandle) {
  const database = await openArchiveDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ARCHIVE_STORE_NAME, "readwrite");
    transaction.objectStore(ARCHIVE_STORE_NAME).put(handle, ARCHIVE_ROOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function getDraftArchiveRoot() {
  if (typeof window === "undefined" || !window.indexedDB) return null;
  try {
    const database = await openArchiveDatabase();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const transaction = database.transaction(ARCHIVE_STORE_NAME, "readonly");
      const request = transaction.objectStore(ARCHIVE_STORE_NAME).get(ARCHIVE_ROOT_KEY);
      request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return handle;
  } catch {
    return null;
  }
}

async function directoryPermission(handle: FileSystemDirectoryHandle, mode: DirectoryPermissionMode) {
  const permissioned = handle as PermissionedDirectoryHandle;
  if (!permissioned.queryPermission) return "prompt" as PermissionState;
  return permissioned.queryPermission({ mode });
}

export function getDraftArchivePermission(handle: FileSystemDirectoryHandle, mode: DirectoryPermissionMode = "read") {
  return directoryPermission(handle, mode);
}

export async function chooseDraftArchiveRoot() {
  if (!window.showDirectoryPicker) return null;
  const existing = await getDraftArchiveRoot();
  const handle = await window.showDirectoryPicker({
    id: "paper1-mvp-study-root-v2",
    mode: "readwrite",
    startIn: existing ?? "documents",
  });
  if (handle.name !== "paper1") throw new Error("paper1_root_required");
  await handle.getDirectoryHandle("drafts", { create: true });
  await handle.getDirectoryHandle("completed", { create: true });
  await handle.getDirectoryHandle("discarded", { create: true });
  await storeArchiveRoot(handle);
  return handle;
}

export async function requestDraftArchivePermission(handle: FileSystemDirectoryHandle) {
  const permissioned = handle as PermissionedDirectoryHandle;
  const current = await directoryPermission(handle, "readwrite");
  if (current === "granted") return true;
  if (!permissioned.requestPermission) return false;
  return (await permissioned.requestPermission({ mode: "readwrite" })) === "granted";
}

const safeFileSegment = (value: unknown) => String(value ?? "unknown").trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

export function draftRecordFileName(draft: Record<string, unknown>) {
  const config = (draft.config ?? {}) as Partial<StudyConfig>;
  return `${[config.participantId, config.sessionId, config.caseId].map(safeFileSegment).join("__")}.json`;
}

async function writeJsonFile(directory: FileSystemDirectoryHandle, filename: string, value: unknown) {
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

async function writeDraftArchive(draft: Record<string, unknown>): Promise<DraftArchiveResult> {
  if (typeof window === "undefined" || !window.showDirectoryPicker) return "unsupported";
  const root = await getDraftArchiveRoot();
  if (!root) return "not_configured";
  if (await directoryPermission(root, "readwrite") !== "granted") return "permission_required";

  try {
    const archivedAt = new Date().toISOString();
    const archive = { archiveVersion: 1, archivedAt, draft };
    const filename = draftRecordFileName(draft);
    const draftsDirectory = await root.getDirectoryHandle("drafts", { create: true });
    await writeJsonFile(draftsDirectory, filename, archive);

    if (Number(draft.stage) >= 6) {
      const completedDirectory = await root.getDirectoryHandle("completed", { create: true });
      await writeJsonFile(completedDirectory, filename, archive);
    }
    return "saved";
  } catch {
    return "error";
  }
}

let archiveQueue: Promise<DraftArchiveResult> = Promise.resolve("not_configured");

export function archiveDraftToLocalFolder(draft: Record<string, unknown>) {
  archiveQueue = archiveQueue.then(() => writeDraftArchive(draft), () => writeDraftArchive(draft));
  return archiveQueue;
}

export async function listLocalDraftArchives(root: FileSystemDirectoryHandle) {
  if (await directoryPermission(root, "read") !== "granted") return [];
  const archives: LocalDraftArchive[] = [];
  let draftsDirectory: FileSystemDirectoryHandle;

  try {
    draftsDirectory = await root.getDirectoryHandle("drafts");
  } catch {
    return [];
  }

  for await (const [folderName, handle] of (draftsDirectory as IterableDirectoryHandle).entries()) {
    try {
      const fileHandle = handle.kind === "file"
        ? handle as FileSystemFileHandle
        : await (handle as FileSystemDirectoryHandle).getFileHandle("draft.json");
      if (!fileHandle.name.endsWith(".json")) continue;
      const file = await fileHandle.getFile();
      const parsed = JSON.parse(await file.text()) as { archivedAt?: string; draft?: Record<string, unknown> };
      if (!parsed.draft) continue;
      archives.push({
        folderName,
        entryKind: handle.kind === "file" ? "file" : "legacy_directory",
        directoryHandle: handle.kind === "directory" ? handle as FileSystemDirectoryHandle : draftsDirectory,
        archivedAt: parsed.archivedAt ?? new Date(file.lastModified).toISOString(),
        draft: parsed.draft,
      });
    } catch {
      // Keep legacy task-folder/draft.json entries readable while new saves use flat JSON files.
    }
  }

  return archives.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

export async function discardLocalDraft(root: FileSystemDirectoryHandle, archive: LocalDraftArchive): Promise<DiscardDraftResult> {
  if (Number(archive.draft.stage) >= 6) return "completed";
  if (await directoryPermission(root, "readwrite") !== "granted") return "permission_required";

  try {
    const draftsDirectory = await root.getDirectoryHandle("drafts");
    const discardedDirectory = await root.getDirectoryHandle("discarded", { create: true });
    const discardedAt = new Date().toISOString();
    const filename = archive.entryKind === "file"
      ? archive.folderName
      : `${safeFileSegment(archive.folderName)}.json`;
    await writeJsonFile(discardedDirectory, filename, {
      archiveVersion: 1,
      archivedAt: archive.archivedAt,
      discardedAt,
      draft: archive.draft,
    });
    await draftsDirectory.removeEntry(archive.folderName, { recursive: archive.entryKind === "legacy_directory" });
    return "discarded";
  } catch (error) {
    return (error as DOMException).name === "NotFoundError" ? "not_found" : "error";
  }
}

export async function revealLocalDraftFolder(handle: FileSystemDirectoryHandle) {
  if (!window.showDirectoryPicker) return false;
  await window.showDirectoryPicker({ id: "paper1-mvp-draft-location", mode: "read", startIn: handle });
  return true;
}

export function readConfig(): StudyConfig {
  const freshConfig = { ...defaultConfig, sessionId: createSessionId() };
  if (typeof window === "undefined") return freshConfig;
  try {
    const saved = window.localStorage.getItem(CONFIG_KEY);
    if (!saved) return freshConfig;
    const parsed = JSON.parse(saved) as Partial<StudyConfig> & { condition?: unknown };
    return { ...freshConfig, ...parsed, condition: normalizeStudyCondition(parsed.condition) };
  } catch {
    return freshConfig;
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
