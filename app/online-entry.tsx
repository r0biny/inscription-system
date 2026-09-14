"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Lock, LogOut, MessageCircle, RotateCcw, X } from "lucide-react";
import { StudyApp, type OnlineStudyTask, type PreviousInputReport, type StudyDraft } from "./study-app";
import { getConditionLabel, type StudyCase, type StudyCondition } from "./study-data";
import { CONFIG_KEY, DRAFT_KEY, type StudyConfig } from "./study-storage";
import { OfflineStore, browserPersistence, pending, localHome } from "./offline_store";
import { OfflineSync, offlineApi, prepareOfflineAssets } from "./offline_runtime";
import practiceMaterialSource from "../study-materials/online/practice-case.json";
import { labMaterials, labStorageKey } from "./lab_runtime";
const practiceMaterialJson = labMaterials(practiceMaterialSource);

type OnlineTaskPayload = {
  taskId: string;
  taskOrder: number;
  caseId: string;
  condition: StudyCondition;
  stage: number;
  revision: number;
  lastSavedAt: string | null;
  entry: Record<string, unknown> | null;
  requiresStartConfirmation: boolean;
  previousInputReport: PreviousInputReport | null;
  material: StudyCase;
};

type ActiveSession = {
  ok: true;
  status: "active";
  participantId: string;
  caseSetId: string;
  sessionId: string;
  pausedAt: string | null;
  pausedTotalMs: number;
  progress: { completed: number; total: number };
  task: OnlineTaskPayload;
};

type HomeTaskPayload = {
  taskOrder: number;
  uiStatus: "locked" | "ready" | "active" | "completed";
  caseId: string | null;
  coverImageUrl: string;
  condition: StudyCondition | null;
  stage: number | null;
  completedAt: string | null;
  preloadImageUrl: string;
};

type HomeSession = {
  ok: true;
  status: "home";
  participantId: string;
  caseSetId: string;
  sessionId: string;
  practice: { completed: boolean; completedAt: string | null; version: number; currentVersion: number };
  progress: { completed: number; total: number };
  allCompleted: boolean;
  canStartAnotherRun: boolean;
  tutorialAuthoring: { available: true; completedAt: string | null } | null;
  history: Array<{
    caseSetId: string;
    runNumber: number;
    completedAt: string | null;
    tasks: Array<{ taskOrder: number; caseId: string; coverImageUrl: string; condition: StudyCondition; completedAt: string | null }>;
  }>;
  tasks: HomeTaskPayload[];
};

type TutorialAuthoringSession = {
  ok: true;
  status: "tutorial_authoring";
  participantId: string;
  sessionId: string;
  task: OnlineTaskPayload & {
    pausedAt: null;
    targetDrawingModes: Record<string, "skeleton" | "outline">;
    skipQuestionnaire: true;
  };
};

type AnonymousSession = { ok: true; status: "anonymous" };
type SessionPayload = ActiveSession | HomeSession | AnonymousSession;
type StudyStatus = {
  ok: true;
  databaseReady: boolean;
  caseSetId: string;
  isOpen: boolean;
  llmMaterialsReady: boolean;
  canCreateSession: boolean;
};

type ApiFailure = { ok?: false; error?: string; message?: string };
type DraftSyncState = { taskId: string; serverRevision: number; pending: boolean };
type PendingResume = { taskId: string; resumedAt: string };
type EntryScreen = "welcome" | "identity";

const DRAFT_SYNC_KEY = labStorageKey("active-draft-sync-v1");
let workspaceModulePreload: Promise<unknown> | null = null;
const pendingImagePreloads = new Map<string, HTMLImageElement>();

function preloadStudyWorkspace(imageUrl: string) {
  workspaceModulePreload ??= import("openseadragon").catch(() => {
    workspaceModulePreload = null;
  });
  if (!imageUrl || pendingImagePreloads.has(imageUrl)) return;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "low";
  pendingImagePreloads.set(imageUrl, image);
  const release = () => pendingImagePreloads.delete(imageUrl);
  image.addEventListener("load", release, { once: true });
  image.addEventListener("error", release, { once: true });
  image.src = imageUrl;
}

const api = offlineApi;

function normalizeMaterial(material: StudyCase) {
  return {
    ...material,
    transcription: material.transcription ?? "",
    aiPredictionMetadata: material.aiPredictionMetadata ?? { model: "none", generatedAt: "", isDummy: false, availability: "unavailable" },
    pages: material.pages.map((page) => ({ ...page, transcription: page.transcription ?? "" })),
    targets: material.targets.map((target) => ({ ...target, transcription: target.transcription ?? "", candidates: target.candidates ?? [] })),
    extraDamage: material.extraDamage.map((damage) => ({ ...damage, transcription: damage.transcription ?? "" })),
  } satisfies StudyCase;
}

function configFor(session: ActiveSession): StudyConfig {
  return {
    participantId: session.participantId,
    sessionId: session.sessionId,
    condition: session.task.condition,
    caseId: session.task.caseId,
    taskOrder: session.task.taskOrder,
  };
}

function pauseMarkerKey(sessionId: string, taskId: string) {
  return labStorageKey("pause:" + sessionId + ":" + taskId);
}

function clearLocalTask() {
  window.localStorage.removeItem(CONFIG_KEY);
  window.localStorage.removeItem(DRAFT_KEY);
  window.localStorage.removeItem(DRAFT_SYNC_KEY);
}

function RubbingCover({ imageUrl, locked = false }: { imageUrl: string; locked?: boolean }) {
  return (
    <div className={`home-card-cover ${locked ? "is-locked" : ""}`} aria-hidden="true">
      {imageUrl && <img src={imageUrl} alt="" />}
      {locked && <span className="home-card-mystery">?</span>}
    </div>
  );
}

function TaskCard({ task, busy, onOpen }: { task: HomeTaskPayload; busy: boolean; onOpen: (task: HomeTaskPayload) => void }) {
  const completed = task.uiStatus === "completed";
  const locked = task.uiStatus === "locked";
  const active = task.uiStatus === "active";
  return (
    <article className={`home-gallery-card is-${task.uiStatus}`}>
      <RubbingCover imageUrl={task.coverImageUrl} locked={locked} />
      <div className="home-card-body">
        <div className="home-card-status">
          <h3>任务{String(task.taskOrder).padStart(2, "0")}</h3>
          {completed ? <span className="status-pill completed"><Check size={13} />已完成</span>
            : locked ? <span className="status-pill locked"><Lock size={13} />尚未解锁</span>
              : <span className="status-pill ready">待完成</span>}
        </div>
        {!locked && task.condition && <p className="home-card-condition">{getConditionLabel(task.condition)}</p>}
        {completed ? null
          : locked ? null
            : <button className="home-card-button" disabled={busy} onClick={() => onOpen(task)}>{active ? "继续任务" : "开始任务"}<ArrowRight size={16} /></button>}
      </div>
    </article>
  );
}

function FeedbackDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (message: string) => Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, submitting]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = feedback.trim();
    if (!message) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(message);
      onClose();
    } catch (submissionError) {
      setError((submissionError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="feedback-dialog-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title">
        <button className="feedback-dialog-close" type="button" onClick={onClose} disabled={submitting} aria-label="关闭反馈窗口"><X size={17} /></button>
        <h2 id="feedback-dialog-title">提交反馈</h2>
        <p>如果你遇到操作问题，或对界面有建议，可以在这里告诉我们。</p>
        <form onSubmit={submit}>
          <label htmlFor="dashboard-feedback">反馈内容</label>
          <textarea id="dashboard-feedback" autoFocus required maxLength={1000} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="请描述你遇到的问题或建议……" />
          <div className="feedback-dialog-meta"><span>{Array.from(feedback).length} / 1000</span></div>
          {error && <p className="feedback-dialog-error" role="alert">{error}</p>}
          <div className="feedback-dialog-actions">
            <button type="button" className="feedback-cancel-button" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="feedback-submit-button" disabled={submitting || !feedback.trim()}>{submitting ? "正在提交…" : "提交反馈"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DataRightsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div className="data-rights-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <article className="data-rights-dialog" role="dialog" aria-modal="true" aria-labelledby="data-rights-title">
        <header>
          <h2 id="data-rights-title">数据与参与权利说明</h2>
          <button type="button" onClick={onClose} autoFocus aria-label="关闭数据与参与权利说明"><X size={18} /></button>
        </header>
        <div className="data-rights-content">
          <section><h3>1. 研究性质</h3><p>本网站用于一项关于数字化碑刻字符修复交互的学术研究。参与本研究完全自愿。你可以拒绝参与，也可以在任务过程中随时停止，不会因此受到不利影响。</p></section>
      <section><h3>2. 收集的信息</h3><p>参与过程中，系统将保存以下信息：</p><ul><li>用于识别参与身份和恢复进度的邮箱；</li><li>任务中的字符判断、绘图结果和问卷回答；</li><li>你自报的作答设备与绘制输入方式，以及浏览器提供的基础 pointer 类型和笔画数；</li><li>任务步骤、暂停、保存、提交和完成时间；</li><li>为分析任务过程所需的必要操作记录。</li></ul><p>请不要在作答或问卷中填写与本研究无关的敏感个人信息。</p></section>
          <section><h3>3. 信息用途</h3><p>邮箱仅用于识别参与身份、保存和恢复任务进度，以及在新的拓片材料开放后支持你继续参与。</p><p>任务作答、绘图、问卷和操作记录将用于本研究的学术分析，包括比较不同任务条件下的判断结果、绘制方式、完成过程和参与体验。未经另行说明和同意，这些信息不会用于与本研究无关的目的。原始参与者信息和实验记录仅供本研究授权人员访问，并将采取合理措施防止未经授权的访问、修改或传播。</p></section>
      <section><h3>4. 去标识化处理</h3><p>邮箱属于可以识别参与者的信息。进行研究分析和成果整理时，该信息将与实验记录分开处理，并使用参与者编号代替。</p><p>论文、报告、演示或其他公开研究成果中，不会公开你的邮箱或其他可以直接识别你身份的信息。公开结果将以去标识化的个体记录、汇总统计或经过筛选的任务示例呈现。</p><p>因此，本研究在数据收集阶段并非完全匿名，但研究分析与公开成果会进行去标识化处理。</p></section>
          <section><h3>5. 联系方式</h3><p>如果你对研究内容、个人信息使用方式或数据撤回有任何疑问，请联系：</p><ul><li>研究负责人：Ruohan Yu</li><li>所属机构：Zhejiang Univerisity, MBZUAI</li><li>联系邮箱：yuruohan27@gmail.com</li></ul></section>
        </div>
        <footer><button type="button" className="primary-button" onClick={onClose}>我已阅读</button></footer>
      </article>
    </div>
  );
}

function HomeView({ session, busy, notice, preloadImageUrl, onPractice, onTutorialAuthoring, onOpenTask, onFeedback, onRepeat, onLogout }: {
  session: HomeSession;
  busy: boolean;
  notice: string;
  preloadImageUrl: string;
  onPractice: () => void;
  onTutorialAuthoring: () => void;
  onOpenTask: (task: HomeTaskPayload) => void;
  onFeedback: (message: string) => Promise<void>;
  onRepeat: () => void;
  onLogout: () => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  useEffect(() => {
    if (preloadImageUrl) preloadStudyWorkspace(preloadImageUrl);
  }, [preloadImageUrl]);
  const percent = Math.round((session.progress.completed / session.progress.total) * 100);
  return (
    <main className="home-shell">
      <header className="site-header dashboard-site-header">
        <div className="identity"><span className="seal" aria-hidden="true">修</span><div><p className="eyebrow">INSCRIPTION RESTORATION STUDY</p><p className="brand">碑刻字符修复工作台</p></div></div>
        <div className="home-participant"><span>参与者</span><strong>{session.participantId}</strong><button className="feedback-trigger" type="button" onClick={() => setFeedbackOpen(true)} aria-haspopup="dialog" aria-label="提交反馈"><MessageCircle size={15} /><span>反馈</span></button><button className="logout-trigger" type="button" onClick={onLogout} aria-label="退出当前身份"><LogOut size={15} /></button></div>
      </header>
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} onSubmit={onFeedback} />}
      <section className="home-intro">
        <div><h1>Dashboard</h1><p>{session.practice.completed
          ? "「拓片档案 · 一」中的三项任务会呈现不同的拓片材料、绘制方式与辅助条件；具体组合与顺序由系统预先随机安排，任务按顺序解锁。建议尽量连续完成；需要离开时，请暂停任务。"
          : "请先完成新手引导。完成后，「拓片档案 · 一」中的三项正式任务将按顺序解锁。"}</p></div>
        <div className="home-progress" aria-label={`正式任务进度 ${session.progress.completed} / ${session.progress.total}`}><div><span>正式任务进度</span><strong>{session.progress.completed} / {session.progress.total}</strong></div><div className="home-progress-track"><span style={{ width: `${percent}%` }} /></div></div>
      </section>
      {notice && <p className="home-notice" role="status"><Check size={17} />{notice}</p>}
      {session.tutorialAuthoring && (
        <section className="tutorial-authoring-card">
          <div><span>本地研究者任务</span><h2>新手引导素材制作</h2><p>已载入当前示例笔画：为“郷”补画 outline，为“述”补画 skeleton。直接进入绘制，完成检查后保存，无需问卷。</p></div>
          <button type="button" disabled={busy} onClick={onTutorialAuthoring}>继续补画示例<ArrowRight size={16} /></button>
        </section>
      )}

      <section className="home-gallery-section">
        <div className="home-section-heading"><h2>新手引导</h2></div>
        <div className="home-gallery is-practice-row">
          <article className={`home-gallery-card practice-card ${session.practice.completed ? "is-completed" : "is-required"}`}>
            <div className="practice-card-cover"><img src={practiceMaterialJson.coverImageUrl} alt="" aria-hidden="true" /></div>
            <div className="home-card-body">
              <div className="home-card-status"><h3>新手引导</h3><span className={`status-pill ${session.practice.completed ? "completed" : "ready"}`}>{session.practice.completed ? <><Check size={13} />已完成</> : "待完成"}</span></div>
              <button className="home-card-button" disabled={busy} onClick={onPractice}>{session.practice.completed ? <><RotateCcw size={15} />重新查看</> : <>开始新手引导<ArrowRight size={16} /></>}</button>
            </div>
          </article>
        </div>
      </section>

      <section className="home-gallery-section">
        <div className="home-section-heading"><h2>拓片档案 · 一</h2></div>
        <div className="home-gallery task-row">{session.tasks.map((task) => <TaskCard key={task.taskOrder} task={task} busy={busy} onOpen={onOpenTask} />)}</div>
      </section>

      {session.history.map((past, historyIndex) => (
        <section className="home-gallery-section history-section" key={`${past.caseSetId}-${past.runNumber}-${historyIndex}`}>
          <div className="home-section-heading"><h2>拓片档案 · 一 · 历史记录</h2></div>
          <div className="home-gallery task-row">{past.tasks.map((task) => <TaskCard key={task.taskOrder} busy={false} onOpen={() => undefined} task={{ ...task, uiStatus: "completed", stage: 6, preloadImageUrl: "" }} />)}</div>
        </section>
      ))}

      <section className="home-gallery-section coming-soon-section">
        <div className="home-section-heading"><h2>拓片档案 · 二</h2></div>
        <article className="coming-soon-card"><span>更多拓片，准备中</span><p>新的拓片材料开放后，你可以继续使用本次邮箱登录并参与。</p></article>
      </section>
      {session.canStartAnotherRun && <button className="researcher-repeat-button" disabled={busy} onClick={onRepeat}><RotateCcw size={15} />研究者验收：创建新一轮</button>}
    </main>
  );
}

export function OnlineEntry() {
  const [status, setStatus] = useState<StudyStatus | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [tutorialAuthoringSession, setTutorialAuthoringSession] = useState<TutorialAuthoringSession | null>(null);
  const [screen, setScreen] = useState<EntryScreen>("welcome");
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [dataRightsOpen, setDataRightsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState("正在连接实验服务器");

  const storeRef = useRef<OfflineStore | null>(null);
  const syncRef = useRef<OfflineSync | null>(null);
  const preparingRef = useRef(false);
  const localWriteFailed = useRef(false);
  const [syncProblem, setSyncProblem] = useState("");
  const [offlinePending, setOfflinePending] = useState(false);
  const [storageReady, setStorageReady] = useState(false);

  const refreshLocalHome = useCallback(() => {
    const state = storeRef.current?.state;
    setOfflinePending(pending(state ?? null));
    if (state) setSession(current => current?.status === "home" ? localHome(state) as HomeSession : current);
  }, []);

  const prepareMaterials = useCallback(async () => {
    const store = storeRef.current, state = store?.state;
    if (!store || !state || state.assetsReady || preparingRef.current) return;
    preparingRef.current = true;
    const sessionId = state.home.sessionId;
    try {
      await prepareOfflineAssets(state);
      await store.change(current => {
        if (current && current.home.sessionId === sessionId) current.assetsReady = true;
        return current;
      });
    } catch { /* Retry on the next connection event; never block already cached tasks. */ }
    finally { preparingRef.current = false; }
  }, []);

  const showLocalTask = useCallback((taskId: string) => {
    const state = storeRef.current?.state;
    const task = state?.tasks.find(t => t.taskId === taskId);
    if (!state || !task || task.frozen || task.completed) return;
    const previous = state.tasks.filter(t => t.taskOrder < task.taskOrder && (t.frozen || t.completed)).at(-1);
    const input = previous?.latest?.inputReport;
    let pausedAt = task.latest?.pauseStartedAt ?? new Date().toISOString();
    try {
      const marker = localStorage.getItem(pauseMarkerKey(state.home.sessionId, task.taskId));
      if (!task.latest?.pauseStartedAt && marker && Number.isFinite(Date.parse(marker))) pausedAt = marker;
    } catch { /* The durable draft remains authoritative if localStorage is unavailable. */ }
    setSession({
      ok: true, status: "active", participantId: state.home.participantId, caseSetId: state.home.caseSetId,
      sessionId: state.home.sessionId, pausedAt, pausedTotalMs: 0,
      progress: { completed: task.taskOrder - 1, total: 3 },
      task: { taskId: task.taskId, taskOrder: task.taskOrder, caseId: task.caseId, condition: task.condition as StudyCondition,
        stage: task.latest?.stage ?? 1, revision: task.revision, lastSavedAt: null, entry: task.latest,
        requiresStartConfirmation: !task.latest?.startedAt,
        previousInputReport: input ? { ...input, sourceTaskOrder: previous!.taskOrder } : null,
        material: normalizeMaterial(task.material) },
    });
    setSaveState("已保存到本机");
  }, []);

  const loadBundle = useCallback(async () => {
    const store = storeRef.current;
    if (!store) throw new Error("本机存储尚未准备好");
    const bundle = await api<any>("/api/offline/bundle");
    const migrating = store.state?.home.sessionId !== bundle.home.sessionId;
    await store.install(bundle);
    // Import a compatible pre-upgrade draft without replacing a newer outbox.
    const legacy = localStorage.getItem(DRAFT_KEY);
    if (legacy && migrating) {
      try {
        const draft = JSON.parse(legacy);
        const legacyPending = JSON.parse(localStorage.getItem(DRAFT_SYNC_KEY) ?? "null")?.pending;
        const task = store.state?.tasks.find(t => t.caseId === draft.config?.caseId);
        if (task && (!task.latest || legacyPending) && !task.completed && draft.config?.sessionId === bundle.home.sessionId) {
          if (draft.stage === 6) await store.freeze(task.taskId, draft);
          else await store.edit(task.taskId, draft);
        }
      } catch {
        localWriteFailed.current = true;
        setSyncProblem("旧版本机草稿暂未成功迁移，请勿清除浏览器数据，请联系研究者。");
        throw new Error("请先处理旧版本机草稿，再开始任务。");
      }
    }
    setSession(localHome(store.state!) as HomeSession);
    refreshLocalHome();
    syncRef.current?.schedule();
    void prepareMaterials();
  }, [prepareMaterials, refreshLocalHome]);

  const acceptSession = useCallback((next: SessionPayload) => {
    const cached = storeRef.current?.state;
    if (cached && pending(cached) && "sessionId" in next && next.sessionId !== cached.home.sessionId) {
      setSyncProblem("还有原参与身份的记录未上传，请重新确认原邮箱，不要切换身份。");
      if (syncRef.current) syncRef.current.blocked = true;
      setSession(localHome(cached) as HomeSession);
      return;
    }
    setSession(next);
    if (next.status === "active" || (next.status === "home" && next.practice.completed)) {
      void loadBundle().catch(error => setMessage((error as Error).message));
    }
  }, [loadBundle]);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    if (!navigator.locks) {
      setMessage("当前浏览器不支持可靠的本机草稿管理，请使用新版 Chrome、Edge 或 Safari。");
      return;
    }
    void navigator.locks.request(labStorageKey("single-writer"), { ifAvailable: true }, async lock => {
      if (!lock) { setMessage("实验已在另一个标签页打开，请关闭其他实验页面后刷新。"); return; }
      if (cancelled) return;
      const held = new Promise<void>(resolve => { release = resolve; });
      try {
        const store = new OfflineStore(browserPersistence(labStorageKey("offline-outbox-v1")));
        storeRef.current = store;
        const cached = await store.load();
        if (cancelled) return;
        syncRef.current = new OfflineSync(store, error => {
          if (cancelled) return;
          if (error) setSyncProblem(error);
          refreshLocalHome();
        });
        setStorageReady(true);
        if (cached) {
          setStatus({ ok: true, databaseReady: true, caseSetId: cached.home.caseSetId, isOpen: true, llmMaterialsReady: true, canCreateSession: true });
          setSession(localHome(cached) as HomeSession);
          if (cached.activeTaskId) showLocalTask(cached.activeTaskId);
          refreshLocalHome();
          syncRef.current.schedule();
          void prepareMaterials();
        }
        try {
          const [nextStatus, next] = await Promise.all([api<StudyStatus>("/api/status"), api<SessionPayload>("/api/participant/session")]);
          if (cancelled) return;
          setStatus(nextStatus);
          if (!cached) acceptSession(next);
          else if (next.status === "anonymous" || ("sessionId" in next && next.sessionId !== cached.home.sessionId)) {
            setSyncProblem("需要重新确认原参与邮箱；本机记录仍保留。");
          }
          // Never overwrite an offline draft/view merely because the server is behind.
        } catch {
          if (!cached && !cancelled) setMessage("首次进入需要联网。请恢复网络后刷新；本机记录不会被清除。");
        }
      } catch {
        if (!cancelled) setMessage("本机存储无法使用，请勿开始实验或清除已有记录，请联系研究者。");
      }
      await held;
    });
    return () => {
      cancelled = true; syncRef.current?.stop();
      const store = storeRef.current;
      if (store) { store.closed = true; void store.queue.finally(() => release?.()); }
      else release?.();
    };
  }, [acceptSession, prepareMaterials, refreshLocalHome, showLocalTask]);

  const onDraftChange = useCallback(async (draft: StudyDraft) => {
    const store = storeRef.current;
    const task = store?.state?.tasks.find(t => t.caseId === draft.config.caseId && store.state?.home.sessionId === draft.config.sessionId);
    if (!store || !task) throw new Error("本机任务尚未准备好");
    try {
      await store.edit(task.taskId, draft);
      localWriteFailed.current = false;
      setSaveState("已保存到本机");
      refreshLocalHome();
      syncRef.current?.schedule(2000);
    } catch (error) {
      localWriteFailed.current = true;
      setSaveState("本机保存失败，请勿关闭页面");
      throw error;
    }
  }, [refreshLocalHome]);

  useEffect(() => {
    const reconnect = () => { syncRef.current?.schedule(0, true); void prepareMaterials(); };
    const visible = () => { if (document.visibilityState === "visible") reconnect(); };
    const markPause = () => {
      const state = storeRef.current?.state;
      const task = state?.tasks.find(t => t.taskId === state.activeTaskId);
      if (state && task && !task.frozen && !task.completed) {
        try { localStorage.setItem(pauseMarkerKey(state.home.sessionId, task.taskId), task.latest?.pauseStartedAt ?? new Date().toISOString()); } catch {}
      }
    };
    const leaving = (event: BeforeUnloadEvent) => {
      const store = storeRef.current;
      if (localWriteFailed.current || store?.writes || pending(store?.state ?? null)) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("beforeunload", leaving);
    window.addEventListener("pagehide", markPause);
    document.addEventListener("visibilitychange", visible);
    const heartbeat = window.setInterval(() => {
      if (!pending(storeRef.current?.state ?? null) && storeRef.current?.state?.activeTaskId) {
        void api("/api/session/heartbeat", { method: "POST", body: "{}" }).catch(() => undefined);
      }
      void prepareMaterials();
    }, 30_000);
    return () => { window.removeEventListener("online", reconnect); window.removeEventListener("beforeunload", leaving); window.removeEventListener("pagehide", markPause);
      document.removeEventListener("visibilitychange", visible); clearInterval(heartbeat); };
  }, [prepareMaterials]);

  const identify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      if (!storageReady) throw new Error("本机存储尚未准备好");
      syncRef.current?.stop();
      const next = await api<SessionPayload>("/api/participant/start", { method: "POST", body: JSON.stringify({ email, acceptedRules }) });
      syncRef.current = new OfflineSync(storeRef.current!, error => {
        if (error) setSyncProblem(error);
        refreshLocalHome();
      });
      setSyncProblem("");
      acceptSession(next);
      window.scrollTo({ top: 0, behavior: "auto" });
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    } catch (error) { setMessage(error instanceof TypeError ? "暂时无法连接实验服务，请检查网络后重试。" : (error as Error).message); } finally { setBusy(false); }
  };

  const completePractice = async () => {
    setBusy(true); setMessage("");
    try {
      const next = await api<HomeSession>("/api/practice/complete", { method: "POST", body: JSON.stringify({ practiceVersion: 1, completionMode: "walkthrough", viewedSteps: ["roadmap", "observation", "judgment", "outline", "skeleton", "review", "survey"] }) });
      setPracticeOpen(false);
      setNotice("新手引导已完成，你解锁了「拓片档案 · 一」！");
      acceptSession(next);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) { setMessage((error as Error).message); throw error; } finally { setBusy(false); }
  };

  const openTask = async (card: HomeTaskPayload) => {
    if (card.uiStatus === "locked" || card.uiStatus === "completed") return;
    setBusy(true); setMessage(""); setNotice("");
    try {
      if (localWriteFailed.current) throw new Error("本机记录尚未可靠保存，请勿关闭页面，请先联系研究者。");
      if (!storeRef.current?.state) await loadBundle();
      const store = storeRef.current!;
      const currentCard = localHome(store.state!).tasks.find((t: HomeTaskPayload) => t.taskOrder === card.taskOrder);
      if (!["ready", "active"].includes(currentCard?.uiStatus)) throw new Error("该任务尚未解锁");
      if (!navigator.onLine && !store.state!.assetsReady) throw new Error("这项任务的离线材料尚未准备完整，请联网后再打开。");
      const task = store.state!.tasks.find(t => t.taskOrder === card.taskOrder)!;
      await store.change(state => { if (state) state.activeTaskId = task.taskId; return state; });
      showLocalTask(task.taskId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  const openTutorialAuthoring = async () => {
    setBusy(true); setMessage(""); setNotice("");
    try {
      const next = await api<TutorialAuthoringSession>("/api/tutorial-authoring/open", { method: "POST", body: "{}" });
      setTutorialAuthoringSession({ ...next, task: { ...next.task, material: normalizeMaterial(next.task.material) } });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };

  const completeTutorialAuthoring = async (draft: StudyDraft) => {
    const next = await api<HomeSession>("/api/tutorial-authoring/complete", {
      method: "POST",
      body: JSON.stringify({ entry: draft }),
    });
    setTutorialAuthoringSession(null);
    setNotice("两个字符的素材绘制已保存到本地 D1。");
    acceptSession(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const pause = useCallback(async () => {
    // Timing is in the local draft; background uploads never change the user's clock.
  }, []);
  const resume = useCallback(async (_resumedAt: string) => {
    const state = storeRef.current?.state;
    if (state?.activeTaskId) {
      try { localStorage.removeItem(pauseMarkerKey(state.home.sessionId, state.activeTaskId)); } catch {}
    }
  }, []);

  const completeTask = useCallback(async (draft: StudyDraft) => {
    const store = storeRef.current;
    const task = store?.state?.tasks.find(t => t.caseId === draft.config.caseId && store.state?.home.sessionId === draft.config.sessionId);
    if (!store || !task) throw new Error("本机任务不存在，请保留页面");
    try {
      await store.freeze(task.taskId, draft);
      localWriteFailed.current = false;
    } catch (error) {
      localWriteFailed.current = true;
      setSaveState("本机提交保存失败，请勿关闭页面");
      throw error;
    }
    const home = localHome(store.state!) as HomeSession;
    setSession(home); refreshLocalHome();
    setNotice(home.allCompleted ? "「拓片档案 · 一」已全部完成！请期待「拓片档案 · 二」" : "「拓片档案 · 一」中有新任务已解锁，请继续完成");
    syncRef.current?.schedule();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [refreshLocalHome]);

  const logout = async () => {
    if (localWriteFailed.current || storeRef.current?.writes || pending(storeRef.current?.state ?? null)) {
      setMessage("还有记录正在等待上传，请保持页面打开并联网。确认上传后再退出；请勿清除浏览器数据。");
      syncRef.current?.schedule();
      return;
    }
    setBusy(true);
    try {
      await api("/api/participant/logout", { method: "POST", body: "{}" });
      await storeRef.current?.change(() => null);
      clearLocalTask();
      setEmail(""); setAcceptedRules(false); setNotice(""); setMessage(""); setScreen("welcome");
      setSession({ ok: true, status: "anonymous" });
    } catch { setMessage("暂时无法退出，请联网后重试。"); } finally { setBusy(false); }
  };

  const submitFeedback = async (feedbackMessage: string) => {
    await api<{ ok: true; feedbackId: string; submittedAt: string }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        message: feedbackMessage,
        pagePath: window.location.pathname,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    });
    setMessage("");
    setNotice("反馈已提交，谢谢。");
  };

  if (!storageReady || !status || !session) return <main className="online-entry-shell"><section className="online-entry-card"><h1>正在连接实验服务器</h1><p>{message || "请稍候…"}</p></section></main>;

  const syncBanner = syncProblem ? <div className="online-message" role="alert">{syncProblem}
    <button type="button" onClick={() => { setSession({ ok: true, status: "anonymous" }); setScreen("identity"); }}>重新确认邮箱</button>
  </div> : null;

  if (tutorialAuthoringSession) {
    const authoringTask: OnlineStudyTask = {
      taskId: tutorialAuthoringSession.task.taskId,
      config: {
        participantId: tutorialAuthoringSession.participantId,
        sessionId: tutorialAuthoringSession.sessionId,
        condition: tutorialAuthoringSession.task.condition,
        caseId: tutorialAuthoringSession.task.caseId,
        taskOrder: 0,
      },
      material: tutorialAuthoringSession.task.material,
      entry: null,
      pausedAt: null,
      requiresStartConfirmation: false,
      previousInputReport: null,
      targetDrawingModes: tutorialAuthoringSession.task.targetDrawingModes,
      skipQuestionnaire: true,
      authoringFromGuides: true,
    };
    return <StudyApp key={authoringTask.taskId} onlineTask={authoringTask} onTaskComplete={completeTutorialAuthoring} />;
  }

  if (session.status === "active") {
    const onlineTask: OnlineStudyTask = { taskId: session.task.taskId, config: configFor(session), material: session.task.material, entry: session.task.entry, pausedAt: session.pausedAt, requiresStartConfirmation: session.task.requiresStartConfirmation, previousInputReport: session.task.previousInputReport };
    return <>{syncBanner}<StudyApp key={session.task.taskId} localFirst onlineTask={onlineTask} onlineSaveState={saveState} onDraftChange={onDraftChange} onPause={pause} onResume={resume} onTaskComplete={completeTask} /></>;
  }

  if (session.status === "home") {
    if (practiceOpen) {
      const practiceMaterial = normalizeMaterial(practiceMaterialJson as unknown as StudyCase);
      const practiceTask: OnlineStudyTask = {
        taskId: `practice-v1-${session.participantId}`,
        config: {
          participantId: session.participantId,
          sessionId: `practice-${session.participantId}`,
          condition: "skeleton_no_llm",
          caseId: practiceMaterial.id,
          taskOrder: 0,
        },
        material: practiceMaterial,
        entry: null,
        pausedAt: null,
        requiresStartConfirmation: false,
        targetDrawingModes: { T01: "outline", T02: "skeleton" },
      };
      return <StudyApp key={practiceTask.taskId} mode="practice" onlineTask={practiceTask} onlineSaveState="流程预览 · 无需作答" onPracticeExit={() => { setPracticeOpen(false); setMessage(""); window.scrollTo({ top: 0, behavior: "smooth" }); }} onTaskComplete={async () => completePractice()} />;
    }
    const preloadImageUrl = session.practice.completed
      ? session.tasks.find((task) => task.uiStatus === "ready" || task.uiStatus === "active")?.preloadImageUrl ?? ""
      : practiceMaterialJson.pages[0]?.imageUrl ?? "";
    return <>{syncBanner}<HomeView session={session} busy={busy} notice={message || notice} preloadImageUrl={preloadImageUrl} onPractice={() => { setPracticeOpen(true); setMessage(""); setNotice(""); window.scrollTo({ top: 0 }); }} onTutorialAuthoring={() => void openTutorialAuthoring()} onOpenTask={openTask} onFeedback={submitFeedback} onRepeat={() => void logout()} onLogout={() => void logout()} />
      {offlinePending && session.allCompleted && <p className="online-message" role="status">任务已在本机完成，记录仍在后台上传。离开前请保持联网，等待此提示消失。</p>}</>;
  }

  const unavailable = !status.databaseReady ? "实验服务暂时不可用，请稍后重试或联系研究者。" : !status.isOpen ? "当前实验尚未开放，请联系研究者。" : !status.canCreateSession ? "实验材料正在准备中，暂时无法开始新任务。" : "";

  if (screen === "welcome") return (
    <main className="welcome-shell"><section className="welcome-card">
      <div className="welcome-mark" aria-hidden="true">碑</div>
      <h1>碑刻字符修复实验</h1>
      <p className="welcome-lead">这是一项关于数字化碑刻修复交互的学术研究。你将观察拓片、判断残损字符，并根据任务要求绘制字符的结构骨架（skeleton）或外轮廓（outline）。</p>
      <div className="welcome-facts"><span><strong>约 5–10 分钟</strong>完成全部内容</span><span><strong>3 项</strong>正式修复任务</span><span><strong>建议连续完成</strong>中断后可继续</span></div>
      <button className="welcome-start-button" disabled={Boolean(unavailable)} onClick={() => setScreen("identity")}>查看参与说明<ArrowRight size={18} /></button>
      {unavailable && <p className="online-message" role="status">{unavailable}</p>}
      <p className="welcome-note">本网站仅供受邀参与者使用。请勿转发实验材料或任务记录。</p>
    </section></main>
  );

  return (
    <main className="online-entry-shell"><section className="online-entry-card join-card">
      <button className="join-back" onClick={() => { setScreen("welcome"); setMessage(""); }}>← 返回</button>
      <h1>开始前，请阅读参与说明</h1>
      <div className="online-rules"><h2>参与规则</h2><ul><li>进入 Dashboard 后，请先完成一次 <strong>新手引导</strong>，再按顺序完成三项正式任务。三项任务会呈现不同的拓片材料、绘制方式与辅助条件；具体组合和顺序由系统预先随机安排。</li><li>请按自然节奏作答，不必刻意加快或等待。建议预留完整的5-10分钟，尽量连续完成三项正式任务。</li><li>页面会 <strong>自动保存</strong>。如需离开，请使用“暂停任务”，返回后可以继续完成。</li><li>请独立完成任务，不要使用搜索引擎、OCR、字典、其他模型或纸笔临摹，也请勿转发实验材料。</li></ul></div>
      <form className="online-identity-form" onSubmit={identify}>
        <label><span className="identity-field-label">邮箱</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /><small className="identity-field-help">请始终使用同一个邮箱。该邮箱是识别参与身份、恢复进度以及今后继续参与新拓片任务的唯一依据。</small></label>
        <div className="online-rule-consent"><input id="identity-consent" type="checkbox" checked={acceptedRules} onChange={(event) => setAcceptedRules(event.target.checked)} required /><span><label htmlFor="identity-consent">我已阅读并同意遵守参与规则，并已阅读</label><button type="button" onClick={() => setDataRightsOpen(true)}>《数据与参与权利说明》</button>。</span></div>
        <button className="primary-button" disabled={busy || !acceptedRules}>{busy ? "正在确认身份…" : "进入 Dashboard"}<span>→</span></button>
      </form>
      {message && <p className="online-message" role="alert">{message}</p>}
      {dataRightsOpen && <DataRightsDialog onClose={() => setDataRightsOpen(false)} />}
    </section></main>
  );
}
