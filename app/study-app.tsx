"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import { ArrowLeft, Bug, Download, ImageIcon, Pause, Play, Redo2, Trash2, Undo2, X, type LucideIcon } from "lucide-react";
import { labStorageKey } from "./lab_runtime";
import {
  getConditionLabel,
  getStudyCondition,
  getStudyPage,
  normalizeStudyCondition,
  type AssistanceMode,
  type DrawingMode,
  type StudyCase,
  type TargetCharacter,
} from "./study-data";
import { archiveDraftToLocalFolder, downloadJson, draftRecordFileName, DRAFT_KEY, readConfig, type StudyConfig } from "./study-storage";
import {
  HeritageViewer,
  type HeritageViewerEvent,
  type HeritageViewportState,
} from "./components/heritage-viewer";
import practiceDrawingGuidesJson from "../study-materials/practice-drawing-guides.json";

type Stage = 1 | 2 | 3 | 4 | 5 | 6;
type Tool = "brush" | "eraser";
type Point = { x: number; y: number };
type DetectedPointerType = "mouse" | "pen" | "touch" | "unknown";
type Stroke = { id?: string; tool: Tool; width: number; points: Point[]; pointerType?: DetectedPointerType };
type SelectionSource = "ranked" | "custom" | null;
export type ReportedDevice = "computer" | "tablet" | "other";
export type ReportedInputMethod = "mouse" | "trackpad" | "touch" | "stylus" | "other";
export type PreviousInputReport = {
  device: ReportedDevice;
  deviceOther: string;
  inputMethod: ReportedInputMethod;
  inputMethodOther: string;
  sourceTaskOrder: number;
};
type TaskInputReport = {
  device: ReportedDevice | null;
  deviceOther: string;
  inputMethod: ReportedInputMethod | null;
  inputMethodOther: string;
  prefilledFromTaskOrder: number | null;
};
type PointerSummary = {
  mouse: number;
  pen: number;
  touch: number;
  unknown: number;
  totalBrushStrokes: number;
};

type CharacterAnswer = {
  hypothesis: string;
  selectionSource: SelectionSource;
  candidateRank: number | null;
  rejectedAll: boolean;
  strokes: Stroke[];
  characterConfidence: number | null;
  drawingConfidence: number | null;
  finalDrawingPng: string | null;
};

type StudyEvent = { at: string; type: string; characterId?: string; detail?: string };
type PausePeriod = { startedAt: string; endedAt: string; durationMs: number };
type DrawingSettings = { brushWidth: number; sourceOpacity: number; strokeOpacity: number };
type PracticeDrawingPhase = "skeleton" | "outline";

export type StudyDraft = {
  version: 4;
  config: StudyConfig;
  experimentalSetting: {
    id: StudyConfig["condition"];
    name: string;
    drawingMode: DrawingMode;
    assistanceMode: AssistanceMode;
  };
  caseId: string;
  stage: Stage;
  activeCharacterId: string;
  activePageId: number;
  startedAt: string;
  restorationSubmittedAt: string | null;
  questionnaireSubmittedAt: string | null;
  restorationDurationMs: number | null;
  questionnaireDurationMs: number | null;
  pauseStartedAt: string | null;
  pausePeriods: PausePeriod[];
  referenceId: string;
  displayedAiAssistance: null | {
    transcription: string;
    rankedCandidates: Record<string, TargetCharacter["candidates"]>;
  };
  stageEnteredAt: Partial<Record<Stage, string>>;
  stageCompletedAt: Partial<Record<Stage, string>>;
  answers: Record<string, CharacterAnswer>;
  drawingSettings: DrawingSettings;
  reviewNote: string;
  difficulty: number | null;
  aiHelpfulness: number | null;
  inputReport: TaskInputReport;
  pointerSummary: PointerSummary;
  events: StudyEvent[];
};

type LegacyCharacterAnswer = Omit<CharacterAnswer, "drawingConfidence" | "finalDrawingPng"> & {
  skeletonConfidence: number | null;
  finalSkeletonPng: string | null;
};

type LegacyStudyDraft = Omit<StudyDraft, "version" | "config" | "experimentalSetting" | "answers" | "drawingSettings" | "inputReport" | "pointerSummary"> & {
  version: 3;
  config: Omit<StudyConfig, "condition"> & { condition: "human_only" | "ai_assisted" };
  answers: Record<string, LegacyCharacterAnswer>;
};

type Transition = { target: Stage; title: string; body: string; confirm: string };

const now = () => new Date().toISOString();
const DEFAULT_DRAWING_SETTINGS: DrawingSettings = { brushWidth: 8, sourceOpacity: 72, strokeOpacity: 92 };
const EMPTY_POINTER_SUMMARY: PointerSummary = { mouse: 0, pen: 0, touch: 0, unknown: 0, totalBrushStrokes: 0 };
const defaultBrushWidth = (drawingMode: DrawingMode) => drawingMode === "outline" ? 4 : 8;
const PARTIAL_ERASER_WIDTH = 28;
const PARTIAL_ERASER_SAMPLE_SPACING = 2;
const practiceDrawingGuides = practiceDrawingGuidesJson as {
  placeholder: boolean;
  targetOrder: string[];
  targets: Record<string, { character: string; drawingMode: PracticeDrawingPhase; brushWidth: number; strokes: Stroke[] }>;
};
const practiceGuideForTarget = (targetId: string) => practiceDrawingGuides.targets[targetId];
const practiceTargetForPhase = (phase: PracticeDrawingPhase) => practiceDrawingGuides.targetOrder.find(
  (targetId) => practiceGuideForTarget(targetId)?.drawingMode === phase,
) ?? practiceDrawingGuides.targetOrder[0];
const clonePracticeStrokes = (targetId: string) => practiceGuideForTarget(targetId).strokes.map((stroke) => ({
  ...stroke,
  points: stroke.points.map((point) => ({ ...point })),
}));

const createStrokeId = () => `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const normalizeDetectedPointerType = (value: string): DetectedPointerType =>
  value === "mouse" || value === "pen" || value === "touch" ? value : "unknown";

function inputReportFromPreset(preset: PreviousInputReport | null): TaskInputReport {
  return preset ? {
    device: preset.device,
    deviceOther: preset.deviceOther,
    inputMethod: preset.inputMethod,
    inputMethodOther: preset.inputMethodOther,
    prefilledFromTaskOrder: preset.sourceTaskOrder,
  } : { device: null, deviceOther: "", inputMethod: null, inputMethodOther: "", prefilledFromTaskOrder: null };
}

function normalizeInputReport(value: unknown, preset: PreviousInputReport | null): TaskInputReport {
  const report = value && typeof value === "object" ? value as Partial<TaskInputReport> : {};
  const device = report.device === "computer" || report.device === "tablet" || report.device === "other" ? report.device : null;
  const inputMethod = report.inputMethod === "mouse" || report.inputMethod === "trackpad" || report.inputMethod === "touch" || report.inputMethod === "stylus" || report.inputMethod === "other" ? report.inputMethod : null;
  if (!device && !inputMethod && preset) return inputReportFromPreset(preset);
  return {
    device,
    deviceOther: String(report.deviceOther ?? "").slice(0, 50),
    inputMethod,
    inputMethodOther: String(report.inputMethodOther ?? "").slice(0, 50),
    prefilledFromTaskOrder: Number.isInteger(report.prefilledFromTaskOrder) ? Number(report.prefilledFromTaskOrder) : null,
  };
}

function summarizePointerUsage(answers: Record<string, CharacterAnswer>): PointerSummary {
  const summary = { ...EMPTY_POINTER_SUMMARY };
  const logicalStrokes = new Set<string>();
  Object.entries(answers).forEach(([characterId, answer]) => {
    answer.strokes.forEach((stroke, index) => {
      if (stroke.tool !== "brush") return;
      const logicalId = stroke.id ? `${characterId}:${stroke.id}` : `${characterId}:legacy:${index}`;
      if (logicalStrokes.has(logicalId)) return;
      logicalStrokes.add(logicalId);
      summary[stroke.pointerType ?? "unknown"] += 1;
      summary.totalBrushStrokes += 1;
    });
  });
  return summary;
}

function squaredDistanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const projection = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx ** 2 + dy ** 2)));
  const nearestX = start.x + projection * dx;
  const nearestY = start.y + projection * dy;
  return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}

function squaredDistanceToPath(point: Point, path: Point[]) {
  if (!path.length) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return (point.x - path[0].x) ** 2 + (point.y - path[0].y) ** 2;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    distance = Math.min(distance, squaredDistanceToSegment(point, path[index - 1], path[index]));
  }
  return distance;
}

function resamplePath(points: Point[], spacing = PARTIAL_ERASER_SAMPLE_SPACING) {
  if (points.length < 2) return [...points];
  const sampled: Point[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (!length) continue;
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      sampled.push({ x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress });
    }
  }
  return sampled;
}

function pathLength(points: Point[]) {
  return points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
}

function splitBrushStrokeByEraser(stroke: Stroke, eraserPath: Point[], eraserWidth: number) {
  if (stroke.tool !== "brush" || stroke.points.length < 2 || !eraserPath.length) return { fragments: [stroke], changed: false };
  const sampled = resamplePath(stroke.points);
  const hitRadius = (eraserWidth + stroke.width) / 2;
  const erased = sampled.map((point) => squaredDistanceToPath(point, eraserPath) <= hitRadius ** 2);
  if (!erased.some(Boolean)) return { fragments: [stroke], changed: false };

  const survivingRuns: Point[][] = [];
  let currentRun: Point[] = [];
  sampled.forEach((point, index) => {
    if (erased[index]) {
      if (currentRun.length) survivingRuns.push(currentRun);
      currentRun = [];
    } else {
      currentRun.push(point);
    }
  });
  if (currentRun.length) survivingRuns.push(currentRun);

  const logicalStrokeId = stroke.id ?? createStrokeId();
  const fragments = survivingRuns
    .filter((points) => points.length >= 2 && pathLength(points) >= PARTIAL_ERASER_SAMPLE_SPACING)
    .map((points) => ({ ...stroke, id: logicalStrokeId, points }));
  return { fragments, changed: true };
}

function applyPartialStrokeEraser(strokes: Stroke[], eraserPath: Point[], eraserWidth: number) {
  let changed = false;
  const nextStrokes = strokes.flatMap((stroke) => {
    const result = splitBrushStrokeByEraser(stroke, eraserPath, eraserWidth);
    changed ||= result.changed;
    return result.fragments;
  });
  return { nextStrokes, changed };
}

function countBrushStrokes(strokes: Stroke[]) {
  const logicalIds = new Set<string>();
  let legacyStrokeCount = 0;
  strokes.forEach((stroke) => {
    if (stroke.tool !== "brush") return;
    if (stroke.id) logicalIds.add(stroke.id);
    else legacyStrokeCount += 1;
  });
  return logicalIds.size + legacyStrokeCount;
}

const normalizeDrawingSetting = (value: unknown, min: number, max: number, fallback: number) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.min(max, Math.max(min, Math.round(numericValue))) : fallback;
};

const blankAnswer = (): CharacterAnswer => ({
  hypothesis: "",
  selectionSource: null,
  candidateRank: null,
  rejectedAll: false,
  strokes: [],
  characterConfidence: null,
  drawingConfidence: null,
  finalDrawingPng: null,
});

function createDraft(config: StudyConfig, studyCase: StudyCase, previousInputReport: PreviousInputReport | null = null): StudyDraft {
  const startedAt = now();
  const setting = getStudyCondition(config.condition);
  return {
    version: 4,
    config,
    experimentalSetting: {
      id: setting.id,
      name: setting.label,
      drawingMode: setting.drawingMode,
      assistanceMode: setting.assistanceMode,
    },
    caseId: studyCase.id,
    stage: 1,
    activeCharacterId: studyCase.targets[0].id,
    activePageId: studyCase.pages[0].id,
    startedAt,
    restorationSubmittedAt: null,
    questionnaireSubmittedAt: null,
    restorationDurationMs: null,
    questionnaireDurationMs: null,
    pauseStartedAt: null,
    pausePeriods: [],
    referenceId: studyCase.referenceId,
    displayedAiAssistance: setting.assistanceMode === "llm" ? {
      transcription: studyCase.transcription,
      rankedCandidates: Object.fromEntries(studyCase.targets.map((target) => [target.id, target.candidates])),
    } : null,
    stageEnteredAt: { 1: startedAt },
    stageCompletedAt: {},
    answers: Object.fromEntries(studyCase.targets.map((target) => [target.id, blankAnswer()])),
    drawingSettings: { ...DEFAULT_DRAWING_SETTINGS, brushWidth: defaultBrushWidth(setting.drawingMode) },
    reviewNote: "",
    difficulty: null,
    aiHelpfulness: null,
    inputReport: inputReportFromPreset(previousInputReport),
    pointerSummary: { ...EMPTY_POINTER_SUMMARY },
    events: [{ at: startedAt, type: "task_started" }],
  };
}

function authoringDraftFromGuides(config: StudyConfig, studyCase: StudyCase): StudyDraft {
  const draft = createDraft(config, studyCase);
  const firstTarget = studyCase.targets[0];
  return {
    ...draft,
    stage: 3,
    drawingSettings: { ...draft.drawingSettings, brushWidth: practiceGuideForTarget(firstTarget.id).brushWidth },
    stageEnteredAt: { 3: draft.startedAt },
    answers: Object.fromEntries(studyCase.targets.map(target => [target.id, {
      ...blankAnswer(),
      hypothesis: practiceGuideForTarget(target.id).character,
      selectionSource: "custom" as const,
      strokes: clonePracticeStrokes(target.id),
    }])),
    events: [{ at: draft.startedAt, type: "tutorial_authoring_seeded_from_guides" }],
  };
}

function migrateDraft(raw: StudyDraft | LegacyStudyDraft, previousInputReport: PreviousInputReport | null = null): StudyDraft {
  const condition = normalizeStudyCondition(raw.config.condition);
  const setting = getStudyCondition(condition);
  const storedDrawingSettings = "drawingSettings" in raw ? raw.drawingSettings : undefined;
  const previousBrushWidths = Object.values(raw.answers).flatMap((value) =>
    (value.strokes as Stroke[]).filter((stroke) => stroke.tool === "brush" && Number.isFinite(stroke.width)).map((stroke) => stroke.width),
  );
  const brushWidth = normalizeDrawingSetting(
    storedDrawingSettings?.brushWidth,
    2,
    20,
    previousBrushWidths.at(-1) ?? defaultBrushWidth(setting.drawingMode),
  );
  const sourceOpacity = normalizeDrawingSetting(
    storedDrawingSettings?.sourceOpacity,
    20,
    100,
    DEFAULT_DRAWING_SETTINGS.sourceOpacity,
  );
  const strokeOpacity = normalizeDrawingSetting(
    storedDrawingSettings?.strokeOpacity,
    20,
    100,
    DEFAULT_DRAWING_SETTINGS.strokeOpacity,
  );
  const answers = Object.fromEntries(Object.entries(raw.answers).map(([id, value]) => {
    const legacy = value as Partial<CharacterAnswer> & { skeletonConfidence?: number | null; finalSkeletonPng?: string | null };
    const answer = Object.fromEntries(
      Object.entries(legacy).filter(([key]) => key !== "skeletonConfidence" && key !== "finalSkeletonPng"),
    ) as Partial<CharacterAnswer>;
    return [id, {
      ...blankAnswer(),
      ...answer,
      strokes: (answer.strokes ?? []).map((stroke) => stroke.tool === "brush"
        ? { ...stroke, width: brushWidth }
        : { ...stroke, width: Number.isFinite(stroke.width) ? stroke.width : 28 }),
      drawingConfidence: answer.drawingConfidence ?? legacy.skeletonConfidence ?? null,
      finalDrawingPng: answer.finalDrawingPng ?? legacy.finalSkeletonPng ?? null,
    }];
  }));
  return {
    ...raw,
    version: 4,
    config: { ...raw.config, condition },
    experimentalSetting: {
      id: setting.id,
      name: setting.label,
      drawingMode: setting.drawingMode,
      assistanceMode: setting.assistanceMode,
    },
    answers,
    drawingSettings: { brushWidth, sourceOpacity, strokeOpacity },
    reviewNote: raw.reviewNote ?? "",
    inputReport: normalizeInputReport("inputReport" in raw ? raw.inputReport : null, previousInputReport),
    pointerSummary: summarizePointerUsage(answers),
  };
}

function sameConfig(left: StudyConfig, right: StudyConfig) {
  return left.participantId === right.participantId && left.sessionId === right.sessionId && left.caseId === right.caseId && left.condition === right.condition;
}

function pausedDurationBetween(draft: StudyDraft, startedAt: string, endedAt: string) {
  const rangeStart = Date.parse(startedAt);
  const rangeEnd = Date.parse(endedAt);
  const periods = draft.pauseStartedAt
    ? [...draft.pausePeriods, { startedAt: draft.pauseStartedAt, endedAt, durationMs: Math.max(0, rangeEnd - Date.parse(draft.pauseStartedAt)) }]
    : draft.pausePeriods;
  return periods.reduce((total, period) => {
    const overlapStart = Math.max(rangeStart, Date.parse(period.startedAt));
    const overlapEnd = Math.min(rangeEnd, Date.parse(period.endedAt));
    return total + Math.max(0, overlapEnd - overlapStart);
  }, 0);
}

function renderDrawing(strokes: Stroke[], mode: "screen" | "export") {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const context = canvas.getContext("2d");
  if (!context) return "";
  if (mode === "export") {
    context.fillStyle = "white";
    context.fillRect(0, 0, 480, 480);
  }
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue;
    context.save();
    context.globalCompositeOperation = stroke.tool === "eraser" && mode === "screen" ? "destination-out" : "source-over";
    context.strokeStyle = stroke.tool === "eraser" ? "white" : mode === "screen" ? "rgba(176, 50, 42, .86)" : "black";
    context.lineWidth = stroke.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
    context.restore();
  }
  context.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

function DrawingOverlay({ strokes }: { strokes: Stroke[] }) {
  const src = useMemo(() => (strokes.length ? renderDrawing(strokes, "screen") : ""), [strokes]);
  return src ? <img className="skeleton-overlay-image" src={src} alt="" aria-hidden="true" /> : null;
}

function SourceViewer({
  studyCase,
  activeId,
  activePageId,
  onPageChange,
  onSelect,
  answers,
  showDrawings = false,
  compact = false,
  focusActiveTarget = false,
  focusRequestKey,
  initialView = "fill",
  defaultPageDrawerOpen = false,
  viewportStateCache,
  onInteraction,
}: {
  studyCase: StudyCase;
  activeId: string;
  activePageId: number;
  onPageChange: (pageId: number) => void;
  onSelect?: (id: string) => void;
  answers: Record<string, CharacterAnswer>;
  showDrawings?: boolean;
  compact?: boolean;
  focusActiveTarget?: boolean;
  focusRequestKey?: number;
  initialView?: "fill" | "global";
  defaultPageDrawerOpen?: boolean;
  viewportStateCache: MutableRefObject<Record<number, HeritageViewportState>>;
  onInteraction?: (type: HeritageViewerEvent) => void;
}) {
  const [pageDrawerOpen, setPageDrawerOpen] = useState(defaultPageDrawerOpen && studyCase.pages.length > 1);
  const page = getStudyPage(studyCase, activePageId);
  const pageTargets = useMemo(
    () => studyCase.targets.filter((target) => target.pageId === page.id),
    [page.id, studyCase.targets],
  );
  const pageExtraDamage = useMemo(
    () => studyCase.extraDamage.filter((damage) => damage.pageId === page.id),
    [page.id, studyCase.extraDamage],
  );
  const viewerPages = useMemo(
    () => studyCase.pages.map((item) => ({
      ...item,
      damagePatches: [
        ...studyCase.targets.filter((target) => target.pageId === item.id).map((target) => ({ id: target.id, imageUrl: target.glyphUrl, crop: target.crop })),
        ...studyCase.extraDamage.filter((damage) => damage.pageId === item.id).map((damage) => ({ id: damage.id, imageUrl: damage.glyphUrl, crop: damage.crop })),
      ],
    })),
    [studyCase.extraDamage, studyCase.pages, studyCase.targets],
  );
  const drawingSources = useMemo(
    () => showDrawings
      ? Object.fromEntries(pageTargets.map((target) => [target.id, renderDrawing(answers[target.id].strokes, "screen")]))
      : undefined,
    [answers, pageTargets, showDrawings],
  );

  return (
    <HeritageViewer
      key={studyCase.id}
      imageUrl={page.imageUrl}
      imageWidth={page.width}
      imageHeight={page.height}
      targets={pageTargets}
      damagePatches={[
        ...pageTargets.map((target) => ({ id: target.id, imageUrl: target.glyphUrl, crop: target.crop })),
        ...pageExtraDamage.map((damage) => ({ id: damage.id, imageUrl: damage.glyphUrl, crop: damage.crop })),
      ]}
      activeId={activeId}
      onSelect={onSelect}
      skeletonSources={drawingSources}
      compact={compact}
      onInteraction={onInteraction}
      initialView={initialView}
      controlsVariant="public"
      focusTargetId={focusActiveTarget ? activeId : undefined}
      focusRequestKey={focusRequestKey}
      pages={viewerPages}
      activePageId={page.id}
      onPageChange={onPageChange}
      pageDrawerOpen={pageDrawerOpen}
      onPageDrawerOpenChange={setPageDrawerOpen}
      initialViewportState={viewportStateCache.current[page.id]}
      onViewportStateChange={(state) => {
        viewportStateCache.current[page.id] = state;
      }}
    />
  );
}

function DrawingIconAction({
  label,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  const tooltipId = useId();

  return (
    <span className="drawing-icon-action">
      <button
        type="button"
        className="drawing-icon-button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-describedby={tooltipId}
      >
        <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <span className="drawing-action-tooltip" id={tooltipId} role="tooltip">{label}</span>
    </span>
  );
}

function DrawingCanvas({
  target,
  strokes,
  drawingMode,
  brushWidth,
  sourceOpacity,
  strokeOpacity,
  onChange,
  onBrushWidthChange,
  onSourceOpacityChange,
  onStrokeOpacityChange,
}: {
  target: TargetCharacter;
  strokes: Stroke[];
  drawingMode: DrawingMode;
  brushWidth: number;
  sourceOpacity: number;
  strokeOpacity: number;
  onChange: (strokes: Stroke[]) => void;
  onBrushWidthChange: (width: number) => void;
  onSourceOpacityChange: (opacity: number) => void;
  onStrokeOpacityChange: (opacity: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentRef = useRef<Stroke | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [eraserCursor, setEraserCursor] = useState<{ x: number; y: number; size: number } | null>(null);
  const [undoHistory, setUndoHistory] = useState<Stroke[][]>([]);
  const [redoHistory, setRedoHistory] = useState<Stroke[][]>([]);
  const [openSetting, setOpenSetting] = useState<"brushWidth" | "sourceOpacity" | null>(null);

  const replay = useCallback(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 480, 480);
    for (const stroke of strokes) {
      context.save();
      context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
      context.strokeStyle = `rgba(176, 50, 42, ${strokeOpacity / 100})`;
      context.lineWidth = stroke.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.stroke();
      context.restore();
    }
    context.globalCompositeOperation = "source-over";
  }, [strokeOpacity, strokes]);

  useEffect(replay, [replay]);
  useEffect(() => {
    setUndoHistory([]);
    setRedoHistory([]);
    setOpenSetting(null);
  }, [target.id]);

  useEffect(() => {
    if (!openSetting) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setOpenSetting(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSetting(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openSetting]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * 480, y: ((event.clientY - rect.top) / rect.height) * 480 };
  };

  const updateEraserCursor = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool !== "eraser" || event.pointerType === "touch") {
      setEraserCursor(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setEraserCursor({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      size: (PARTIAL_ERASER_WIDTH / 480) * rect.width,
    });
  };

  const withCurrentBrushWidth = (snapshot: Stroke[]) => snapshot.map((stroke) =>
    stroke.tool === "brush" ? { ...stroke, width: brushWidth } : stroke,
  );

  const commitStrokes = (nextStrokes: Stroke[]) => {
    setUndoHistory((history) => [...history, strokes]);
    setRedoHistory([]);
    onChange(nextStrokes);
  };

  const drawSegment = (from: Point, to: Point, activeTool: Tool, width: number) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = activeTool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = `rgba(176, 50, 42, ${strokeOpacity / 100})`;
    context.lineWidth = width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
  };

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    updateEraserCursor(event);
    const point = pointFromEvent(event);
    currentRef.current = {
      id: tool === "brush" ? createStrokeId() : undefined,
      tool,
      width: tool === "brush" ? brushWidth : PARTIAL_ERASER_WIDTH,
      points: [point],
      pointerType: normalizeDetectedPointerType(event.pointerType),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    updateEraserCursor(event);
    const active = currentRef.current;
    if (!active) return;
    const point = pointFromEvent(event);
    drawSegment(active.points[active.points.length - 1], point, active.tool, active.width);
    active.points.push(point);
  };

  const pointerUp = () => {
    const active = currentRef.current;
    currentRef.current = null;
    if (!active) return;
    if (active.tool === "eraser") {
      const result = applyPartialStrokeEraser(strokes, active.points, active.width);
      if (result.changed) commitStrokes(result.nextStrokes);
      else replay();
      return;
    }
    if (active.points.length < 2) return;
    commitStrokes([...strokes, active]);

    /*
     * Previous Pixel Eraser persistence, retained here for comparison and rollback:
     * onChange([...strokes, active]);
     * setRedo([]);
     * Existing saved eraser strokes are still replayed by renderDrawing() and replay().
     */
  };

  const undo = () => {
    const previousSnapshot = undoHistory.at(-1);
    if (previousSnapshot) {
      setUndoHistory((history) => history.slice(0, -1));
      setRedoHistory((history) => [...history, strokes]);
      onChange(withCurrentBrushWidth(previousSnapshot));
      return;
    }

    // Drafts saved before operation history existed still support logical-stroke undo.
    const last = strokes.at(-1);
    if (!last) return;
    const previous = last.id ? strokes.filter((stroke) => stroke.id !== last.id) : strokes.slice(0, -1);
    setRedoHistory((history) => [...history, strokes]);
    onChange(previous);
  };

  const redoStroke = () => {
    const nextSnapshot = redoHistory.at(-1);
    if (!nextSnapshot) return;
    setRedoHistory((history) => history.slice(0, -1));
    setUndoHistory((history) => [...history, strokes]);
    onChange(withCurrentBrushWidth(nextSnapshot));
  };

  return (
    <div className="drawing-module">
      <div className="drawing-canvas-wrap">
        <div className="drawing-zoom-plane">
          <img src={target.glyphUrl} alt={`${target.label}局部图`} style={{ opacity: sourceOpacity / 100 }} draggable={false} />
          <canvas
            ref={canvasRef}
            className={tool === "eraser" ? "is-eraser-active" : undefined}
            width={480}
            height={480}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onPointerEnter={updateEraserCursor}
            onPointerLeave={() => setEraserCursor(null)}
            aria-label={`为${target.label}绘制${drawingMode === "outline" ? "轮廓" : "骨架"}`}
          />
          {tool === "eraser" && eraserCursor && (
            <span
              className="eraser-cursor-preview"
              style={{ left: eraserCursor.x, top: eraserCursor.y, width: eraserCursor.size, height: eraserCursor.size }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <div className="drawing-toolbar">
        <div className="tool-group primary-tools">
          <button className={tool === "brush" ? "is-selected" : ""} onClick={() => { setTool("brush"); setEraserCursor(null); }} aria-label="画笔" title="画笔"><span className="tool-mark brush-mark" /><span className="primary-tool-label">画笔</span></button>
          <button className={tool === "eraser" ? "is-selected" : ""} onClick={() => setTool("eraser")} aria-label="橡皮" title="橡皮"><span className="tool-mark eraser-mark" /><span className="primary-tool-label">橡皮</span></button>
        </div>
        <div className="tool-group secondary-tools">
          <DrawingIconAction label="撤销" icon={Undo2} onClick={undo} disabled={!undoHistory.length && !strokes.length} />
          <DrawingIconAction label="重做" icon={Redo2} onClick={redoStroke} disabled={!redoHistory.length} />
          <DrawingIconAction label="清空" icon={Trash2} onClick={() => commitStrokes([])} disabled={!strokes.length} />
        </div>
        <div className="drawing-settings" ref={settingsRef}>
          <button
            type="button"
            className={`drawing-setting-trigger ${openSetting === "brushWidth" ? "is-open" : ""}`}
            onClick={() => setOpenSetting((value) => value === "brushWidth" ? null : "brushWidth")}
            aria-label={`笔画粗细，当前 ${brushWidth}px`}
            aria-expanded={openSetting === "brushWidth"}
            aria-haspopup="dialog"
          >
            <span className="line-thickness-icon" aria-hidden="true"><i /><i /><i /></span><span className="drawing-setting-label">笔画粗细</span><b>{brushWidth}px</b><i role="tooltip">调节笔画粗细</i>
          </button>
          <button
            type="button"
            className={`drawing-setting-trigger ${openSetting === "sourceOpacity" ? "is-open" : ""}`}
            onClick={() => setOpenSetting((value) => value === "sourceOpacity" ? null : "sourceOpacity")}
            aria-label={`图层透明度，底图 ${sourceOpacity}%，绘制笔画 ${strokeOpacity}%`}
            aria-expanded={openSetting === "sourceOpacity"}
            aria-haspopup="dialog"
          >
            <ImageIcon size={16} strokeWidth={1.7} aria-hidden="true" /><span className="drawing-setting-label">图层透明度</span><b>{sourceOpacity}% / {strokeOpacity}%</b><i role="tooltip">调节底图与绘制笔画透明度</i>
          </button>
          {openSetting && (
            <div className={`drawing-setting-popover ${openSetting === "brushWidth" ? "is-brush-width" : "is-opacity"}`} role="dialog" aria-label={openSetting === "brushWidth" ? "调节笔画粗细" : "调节图层透明度"}>
              {openSetting === "brushWidth" ? (
                <label>
                  <span>笔画粗细</span><output>{brushWidth} px</output>
                  <input type="range" min="2" max="20" step="1" value={brushWidth} onChange={(event) => onBrushWidthChange(Number(event.target.value))} />
                </label>
              ) : (
                <>
                  <label>
                    <span>底图透明度</span><output>{sourceOpacity}%</output>
                    <input type="range" min="20" max="100" step="1" value={sourceOpacity} onChange={(event) => onSourceOpacityChange(Number(event.target.value))} />
                  </label>
                  <label>
                    <span>绘制笔画透明度</span><output>{strokeOpacity}%</output>
                    <input type="range" min="20" max="100" step="1" value={strokeOpacity} onChange={(event) => onStrokeOpacityChange(Number(event.target.value))} />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CharacterNav({ studyCase, activeId, answers, mode, onSelect }: { studyCase: StudyCase; activeId: string; answers: Record<string, CharacterAnswer>; mode: "hypothesis" | "drawing"; onSelect: (id: string) => void }) {
  return (
    <div className="character-nav" aria-label="目标字符导航">
      {studyCase.targets.map((target, index) => {
        const answer = answers[target.id];
        const complete = mode === "hypothesis" ? isHypothesisComplete(answer.hypothesis) : answer.strokes.some((stroke) => stroke.tool === "brush");
        const displayNumber = String(index + 1).padStart(2, "0");
        return (
          <button key={target.id} className={activeId === target.id ? "is-active" : ""} onClick={() => onSelect(target.id)}>
            <span className="nav-index">{displayNumber}</span>
            <span className="nav-label">字符 {displayNumber}<small>第 {studyCase.pages.findIndex((page) => page.id === target.pageId) + 1} 页</small></span>
            <span className={`completion-dot ${complete ? "is-complete" : ""}`}>{complete ? "✓" : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

const candidateDisplayPercent = (candidate: TargetCharacter["candidates"][number]) => Math.round(candidate.confidence * 100);
const visibleCandidates = (target: TargetCharacter) => target.candidates.filter((candidate) => candidateDisplayPercent(candidate) > 0);

function AiPanel({ studyCase, target, pageId, compact = false, showAll = false }: { studyCase: StudyCase; target: TargetCharacter; pageId: number; compact?: boolean; showAll?: boolean }) {
  const page = getStudyPage(studyCase, pageId);
  const targetsByPageSequence = new Map(
    studyCase.targets.filter((item) => item.pageId === page.id).map((item) => [item.pageSequence, item]),
  );
  const extraDamageByPageSequence = new Set(
    studyCase.extraDamage.filter((item) => item.pageId === page.id).map((item) => item.pageSequence),
  );
  let glyphPosition = 0;
  const transcription = Array.from(page.transcription).map((character, index) => {
    if (/\s/u.test(character)) return character;
    glyphPosition += 1;
    const matchedTarget = targetsByPageSequence.get(glyphPosition);
    if (matchedTarget) return <mark className="transcription-target" key={`${matchedTarget.id}-${index}`} title={matchedTarget.label}>{character}</mark>;
    return extraDamageByPageSequence.has(glyphPosition)
      ? <span className="transcription-damage-placeholder" key={`damage-${glyphPosition}-${index}`} title="其他残损字符">□</span>
      : character;
  });

  return (
    <section className={`ai-panel ${compact ? "is-compact" : ""} ${showAll ? "shows-all-targets" : ""}`}>
      <div className="ai-heading"><span className="ai-badge">AI 提示</span><span>转录与字符候选</span></div>
      <div className="ai-content">
        {!compact && <div className={`transcription ${studyCase.transcriptionDirection}`}><span className="transcription-page-label">{page.label}</span>{transcription.length ? transcription : "本页暂无转录"}</div>}
        {showAll ? (
          <div className="all-candidate-list">
            {studyCase.targets.map((item) => (
              <div className="candidate-target-row" key={item.id}>
                <span className="candidate-target-index">{item.id}</span>
                <span className="small-label">{item.label} · P{String(studyCase.pages.findIndex((pageItem) => pageItem.id === item.pageId) + 1).padStart(2, "0")}</span>
                <div>{visibleCandidates(item).length ? visibleCandidates(item).map((candidate) => <span key={candidate.rank}><b>{candidate.rank}</b>{candidate.character}</span>) : <em>暂无非零候选</em>}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="ai-candidates-readonly">
            <span className="small-label">{target.label}</span>
            <div>{visibleCandidates(target).length ? visibleCandidates(target).map((candidate) => <span key={candidate.rank}><b>{candidate.rank}</b>{candidate.character}</span>) : <em>暂无非零候选</em>}</div>
          </div>
        )}
      </div>
    </section>
  );
}

const observationTargetNumber = (studyCase: StudyCase, target: TargetCharacter) =>
  String(studyCase.targets.findIndex((item) => item.id === target.id) + 1);

function DamageSummary({ target, prefix = false }: { target: TargetCharacter; prefix?: boolean }) {
  const severityLabel = target.damageSeverity === "Legacy test" ? target.damageSeverity : `${target.damageSeverity} Damage`;
  return <span className="damage-summary">{prefix ? "残损程度 " : ""}{severityLabel} · {Math.round(target.maskRatio * 100)}%</span>;
}

function ObservationDamageStrip({
  studyCase,
  activeId,
  onSelect,
  showDamageSummary = true,
}: {
  studyCase: StudyCase;
  activeId: string;
  onSelect: (id: string) => void;
  showDamageSummary?: boolean;
}) {
  return (
    <div className="observation-damage-strip" aria-label={showDamageSummary ? "全部目标字符损伤程度" : "全部目标字符"}>
      {studyCase.targets.map((target) => {
        const number = observationTargetNumber(studyCase, target);
        return (
          <button type="button" key={target.id} className={target.id === activeId ? "is-active" : ""} onClick={() => onSelect(target.id)}>
            <img src={target.glyphUrl} alt={`目标 ${number} 的残损局部`} width={54} height={54} decoding="async" />
            <span><strong>目标 {number}</strong>{showDamageSummary && <DamageSummary target={target} />}</span>
          </button>
        );
      })}
    </div>
  );
}

function ObservationCandidateText({ studyCase, target }: { studyCase: StudyCase; target: TargetCharacter }) {
  const number = observationTargetNumber(studyCase, target);
  const candidates = visibleCandidates(target);
  return (
    <span className="step1-candidate-text" aria-label={`目标 ${number} 的候选字，只读`}>
      {candidates.length
        ? candidates.map((candidate) => (
          <span key={candidate.rank}>
            <strong>{candidate.character}</strong>
            <small>{candidateDisplayPercent(candidate)}%</small>
          </span>
        ))
        : <em>候选数据待接入</em>}
    </span>
  );
}

function ObservationTargetContext({
  studyCase,
  target,
  radius = 3,
  multiline = false,
}: {
  studyCase: StudyCase;
  target: TargetCharacter;
  radius?: number;
  multiline?: boolean;
}) {
  const characters = studyCase.pages.flatMap((page) =>
    Array.from(page.transcription).filter((character) => !/\s/u.test(character)),
  );
  const center = Math.min(characters.length - 1, Math.max(0, target.sequence - 1));
  const start = Math.max(0, center - radius);
  const end = Math.min(characters.length, center + radius + 1);
  const number = observationTargetNumber(studyCase, target);
  const extraDamageSequences = new Set(studyCase.extraDamage.map((damage) => damage.sequence));

  return (
    <span className={`step1-target-context ${multiline ? "is-multiline" : ""}`} aria-label={`目标 ${number} 的转录上下文`}>
      {start > 0 && <span aria-hidden="true">…</span>}
      {characters.slice(start, end).map((character, offset) => {
        const sequence = start + offset + 1;
        if (start + offset === center) return <mark key={`${character}-${offset}`}>{number}</mark>;
        return <span className={extraDamageSequences.has(sequence) ? "transcription-damage-placeholder" : undefined} key={`${character}-${offset}`}>{character}</span>;
      })}
      {end < characters.length && <span aria-hidden="true">…</span>}
    </span>
  );
}

type IdsOperator = "⿰" | "⿱" | "⿲" | "⿳" | "⿴" | "⿵" | "⿶" | "⿷" | "⿸" | "⿹" | "⿺" | "⿻";

const IDS_STRUCTURES: Array<{ operator: IdsOperator; label: string; arity: 2 | 3 }> = [
  { operator: "⿰", label: "左右", arity: 2 },
  { operator: "⿱", label: "上下", arity: 2 },
  { operator: "⿲", label: "左中右", arity: 3 },
  { operator: "⿳", label: "上中下", arity: 3 },
  { operator: "⿴", label: "全包围", arity: 2 },
  { operator: "⿵", label: "上包围", arity: 2 },
  { operator: "⿶", label: "下包围", arity: 2 },
  { operator: "⿷", label: "左包围", arity: 2 },
  { operator: "⿸", label: "左上包围", arity: 2 },
  { operator: "⿹", label: "右上包围", arity: 2 },
  { operator: "⿺", label: "左下包围", arity: 2 },
  { operator: "⿻", label: "重叠", arity: 2 },
];

const IDS_STRUCTURE_BY_OPERATOR = new Map(IDS_STRUCTURES.map((item) => [item.operator, item]));

function isIdsExpression(raw: string) {
  return IDS_STRUCTURE_BY_OPERATOR.has(Array.from(raw.trim())[0] as IdsOperator);
}

function isIdsExpressionComplete(raw: string) {
  const tokens = Array.from(raw.trim());
  if (!IDS_STRUCTURE_BY_OPERATOR.has(tokens[0] as IdsOperator)) return Boolean(tokens.length);
  let cursor = 0;
  const consumeNode = (): boolean => {
    const token = tokens[cursor];
    if (!token) return false;
    cursor += 1;
    const structure = IDS_STRUCTURE_BY_OPERATOR.get(token as IdsOperator);
    if (!structure) return true;
    return Array.from({ length: structure.arity }).every(consumeNode);
  };
  return consumeNode() && cursor === tokens.length;
}

function isHypothesisComplete(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return isIdsExpressionComplete(trimmed);
}

function IdsCharacterInput({ value, onChange, placeholder, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!panelOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setPanelOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [panelOpen]);

  const insertStructure = (operator: IdsOperator) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const nextValue = `${value.slice(0, start)}${operator}${value.slice(end)}`;
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(start + operator.length, start + operator.length);
    });
  };

  return (
    <div className="ids-character-input" ref={containerRef}>
      <div className="ids-input-control">
        <input
          ref={inputRef}
          className="character-input"
          value={value}
          maxLength={24}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={`ids-toggle-button ${panelOpen ? "is-open" : ""}`}
          aria-label={panelOpen ? "关闭 IDS 结构输入" : "打开 IDS 结构输入"}
          aria-expanded={panelOpen}
          title="IDS 结构输入"
          onClick={() => setPanelOpen((open) => !open)}
        ><span aria-hidden="true">IDS</span></button>
        {panelOpen && (
          <div className="ids-structure-popover" role="group" aria-label="IDS 字形结构">
            {IDS_STRUCTURES.map((structure) => <button type="button" key={structure.operator} aria-label={structure.label} onClick={() => insertStructure(structure.operator)}>{structure.operator}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

function JudgmentEvidenceCard({
  studyCase,
  target,
  answer,
  onCandidateSelect,
  onCustomSelect,
  onCustomChange,
}: {
  studyCase: StudyCase;
  target: TargetCharacter;
  answer: CharacterAnswer;
  onCandidateSelect: (candidate: TargetCharacter["candidates"][number]) => void;
  onCustomSelect: () => void;
  onCustomChange: (value: string) => void;
}) {
  const number = observationTargetNumber(studyCase, target);
  const customSelected = answer.selectionSource === "custom" || answer.rejectedAll;
  const candidates = visibleCandidates(target);

  return (
    <section className="judgment-evidence-card" aria-label={`目标 ${number} 的判断证据`}>
      <img src={target.glyphUrl} alt={`目标 ${number} 的残损局部`} width={82} height={82} decoding="async" />
      <div className="judgment-evidence-fields">
        <div className="judgment-evidence-field"><b>上下文</b><ObservationTargetContext studyCase={studyCase} target={target} radius={10} multiline /></div>
        <div className="judgment-evidence-field">
          <b>候选字</b>
          <div className="judgment-candidate-options" role="group" aria-label={`目标 ${number} 的候选字`}>
            {candidates.map((candidate) => (
              <button
                type="button"
                key={candidate.rank}
                className={answer.selectionSource === "ranked" && answer.candidateRank === candidate.rank ? "is-selected" : ""}
                aria-pressed={answer.selectionSource === "ranked" && answer.candidateRank === candidate.rank}
                onClick={() => onCandidateSelect(candidate)}
              >
                <strong>{candidate.character}</strong>
                <small>{candidateDisplayPercent(candidate)}%</small>
              </button>
            ))}
          </div>
        </div>
        <button type="button" className={`judgment-custom-choice ${customSelected ? "is-selected" : ""}`} aria-pressed={customSelected} onClick={onCustomSelect}>
          <span className="radio-mark" />自行输入其他字符
        </button>
        {customSelected && <IdsCharacterInput key={target.id} value={answer.selectionSource === "ranked" ? "" : answer.hypothesis} placeholder="请输入您判断的字符" ariaLabel={`目标 ${number} 的自定义字符判断`} onChange={onCustomChange} />}
      </div>
    </section>
  );
}

function ObservationAiPanel({
  studyCase,
  pageId,
  activeId,
  onSelect,
}: {
  studyCase: StudyCase;
  pageId: number;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const page = getStudyPage(studyCase, pageId);
  const pageTargets = studyCase.targets.filter((target) => target.pageId === pageId);
  const targetsByPageSequence = new Map(pageTargets.map((target) => [target.pageSequence, target]));
  const extraDamageByPageSequence = new Set(
    studyCase.extraDamage.filter((damage) => damage.pageId === pageId).map((damage) => damage.pageSequence),
  );
  let glyphPosition = 0;

  return (
    <aside className="observation-ai-panel">
      <ParallelPanelHeading title="AI 转录与字符候选" />
      <div className="parallel-panel-body observation-ai-body">
        <section className="step1-transcription-section">
          <div className="step1-section-label"><span className="small-label">AI 转录文本</span></div>
          <div className="step1-transcription-flow is-horizontal" aria-label={`${page.label}转录文本，根据可用宽度自动换行`}>
            {Array.from(page.transcription).map((character, index) => {
              if (/\s/u.test(character)) return <span key={`space-${index}`}>{character}</span>;
              glyphPosition += 1;
              const target = targetsByPageSequence.get(glyphPosition);
              if (!target) return <span className={extraDamageByPageSequence.has(glyphPosition) ? "transcription-damage-placeholder" : undefined} key={`${character}-${index}`}>{character}</span>;
              const number = observationTargetNumber(studyCase, target);
              return (
                <button type="button" key={`${target.id}-${index}`} className={target.id === activeId ? "is-active" : ""} onClick={() => onSelect(target.id)} title={`目标 ${number} · 页内序号 ${target.pageSequence}`}>
                  {number}
                </button>
              );
            })}
          </div>
        </section>
        <section className="step1-prediction-list progressive-prediction-list" aria-label="AI 预测字符候选">
          <div className="step1-section-label"><span className="small-label">AI 预测字符候选</span></div>
          {pageTargets.length === 0 && <p className="step1-empty-predictions">本页没有需要处理的目标字符</p>}
          {pageTargets.map((target) => {
            const number = observationTargetNumber(studyCase, target);
            const active = target.id === activeId;
            return (
              <button type="button" key={target.id} className={`is-expanded ${active ? "is-active" : ""}`} aria-pressed={active} onClick={() => onSelect(target.id)}>
                <span className="progressive-target-title"><span className="step1-target-index">{number}</span><strong>目标{number}</strong><DamageSummary target={target} /></span>
                <img src={target.glyphUrl} alt={`目标 ${number} 的残损局部`} width={82} height={82} decoding="async" />
                <span className="progressive-evidence-fields">
                  <span className="progressive-evidence-field"><b>上下文</b><ObservationTargetContext studyCase={studyCase} target={target} radius={10} multiline /></span>
                  <span className="progressive-evidence-field"><b>候选字</b><ObservationCandidateText studyCase={studyCase} target={target} /></span>
                </span>
              </button>
            );
          })}
        </section>
      </div>
    </aside>
  );
}

function Rating({ value, onChange, label, lowLabel, highLabel }: { value: number | null; onChange: (value: number) => void; label: string; lowLabel: string; highLabel: string }) {
  return (
    <div className="rating-scale">
      <div className="rating-row" role="group" aria-label={`${label}，1 表示${lowLabel}，5 表示${highLabel}`}>
        {[1, 2, 3, 4, 5].map((score) => <button key={score} className={value === score ? "is-selected" : ""} onClick={() => onChange(score)}>{score}</button>)}
      </div>
      <div className="rating-endpoints" aria-hidden="true"><span>{lowLabel}</span><span>{highLabel}</span></div>
    </div>
  );
}

function SurveyChoice<T extends string>({ name, label, value, options, onChange }: {
  name: string;
  label: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="survey-choice-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label className={`survey-choice-option ${value === option.value ? "is-selected" : ""}`} key={option.value}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

const stageNames = ["整体观察", "字符判断", "绘制修复", "检查并提交", "完成问卷"];

function StageHeader({ stage, title, description, stageName }: { stage: number; title: string; description: string; stageName?: string }) {
  return (
    <section className="intro">
      <div><p className="section-index">{String(stage).padStart(2, "0")} / {stageName ?? stageNames[stage - 1]}</p><h1>{title}</h1></div>
      <p>{description}</p>
    </section>
  );
}

function OriginalRubbingHeading() {
  return (
    <div className="viewer-heading">
      <span className="label">原始拓片浏览</span>
    </div>
  );
}

function ParallelPanelHeading({ title }: { title: string }) {
  return <div className="viewer-heading parallel-panel-heading"><span className="label">{title}</span></div>;
}

function TransitionModal({ transition, onCancel, onConfirm }: { transition: Transition; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="transition-title">
        <span className="modal-index">NEXT · {String(transition.target).padStart(2, "0")}</span>
        <h2 id="transition-title">{transition.title}</h2>
        <p>{transition.body}</p>
        <div className="modal-actions"><button className="text-button" onClick={onCancel}>再看一会儿</button><button className="primary-button" onClick={onConfirm}>{transition.confirm}<span>→</span></button></div>
      </div>
    </div>
  );
}

function TaskIntroModal({ taskOrder, drawingName, assisted, mixed, busy, onStart }: { taskOrder: number; drawingName: "skeleton" | "outline"; assisted: boolean; mixed?: boolean; busy: boolean; onStart: () => void }) {
  const drawingDescription = drawingName === "outline"
    ? "绘制修复字符的完整外轮廓（outline）"
    : "绘制修复字符的主要结构骨架（skeleton）";
  const assistanceDescription = assisted
    ? "本任务提供 LLM 转录上下文与 Top-5 候选字辅助。"
    : "本任务不提供 LLM 辅助，需要独立判断字符。";
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="task-intro-title">
        <span className="modal-index">{mixed ? "LOCAL AUTHORING" : `TASK ${String(taskOrder).padStart(2, "0")} / 03`}</span>
        <h2 id="task-intro-title">{mixed ? "新手引导素材制作" : `第 ${taskOrder} 个任务已准备好`}</h2>
        <p>{mixed ? "本地任务包含两个字符：先为“郷”绘制 outline，再为“述”绘制 skeleton。切换字符时，页面标题与画笔粗细会自动切换。" : `本任务需要${drawingDescription}。`}{!mixed && assistanceDescription}<br />点击开始后才会继续计时。</p>
        <div className="modal-actions"><button className="primary-button" disabled={busy} onClick={onStart} autoFocus>{busy ? "正在开始…" : mixed ? "开始素材制作" : `开始第 ${taskOrder} 个任务`}<span>→</span></button></div>
      </div>
    </div>
  );
}

type PracticeGuideTip = { id: string; target: string; title: string; body: string };

function PracticeGuide({ stage, drawingPhase, enabled, busy, error, onAdvance }: {
  stage: Stage;
  drawingPhase: PracticeDrawingPhase;
  enabled: boolean;
  busy: boolean;
  error: string;
  onAdvance: () => void;
}) {
  const tips = useMemo<PracticeGuideTip[]>(() => {
    if (stage === 1) return [
      { id: "roadmap", target: "roadmap", title: "先看顶部流程", body: "任务共有五步，红色标记表示当前步骤。正式任务只能向前推进。本次引导无需作答，只需点击“下一步”。" },
      { id: "stage1-viewer", target: "stage1-viewer", title: "整体观察", body: "正式任务从观察整幅拓片开始：留意目标字符的位置、残存笔画和周围文字。这里先了解页面即可。" },
    ];
    if (stage === 2) return [
      { id: "stage2-input", target: "stage2-input", title: "字符判断", body: "正式任务中，在“我的判断”里填写你推测的字符。不必完全确定，按现有线索判断即可。本次无需填写。" },
    ];
    if (stage === 3) return [
      drawingPhase === "outline"
        ? { id: "stage3-outline", target: "stage3-drawing", title: "外轮廓（outline）", body: "外轮廓描绘笔画的外部边界，使用较细的线。画布中的红色笔画是示例，本次无需绘制。正式任务请按标题要求绘制。" }
        : { id: "stage3-skeleton", target: "stage3-drawing", title: "结构骨架（skeleton）", body: "结构骨架描绘笔画的中心线，不需要模仿笔画粗细。这里已自动切换字符、标题和画笔粗细。本次只需查看示例。" },
    ];
    if (stage === 4) return [
      { id: "stage4-review", target: "stage4-review", title: "检查结果", body: "正式任务在这里核对字符判断和绘制结果。本页不能返回修改，提交后修复内容会锁定。本次只展示示例。" },
    ];
    if (stage === 5) return [
      { id: "stage5-survey", target: "stage5-survey", title: "最后填写问卷", body: "正式任务最后填写作答设备和主观感受，提交后返回 Dashboard。本次无需填写，点击下方按钮即可完成引导。" },
    ];
    return [];
  }, [drawingPhase, stage]);
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const [placement, setPlacement] = useState<"above" | "below" | "left">("below");
  const popoverRef = useRef<HTMLElement | null>(null);
  const tip = tips[index];
  const preferLeftPlacement = stage === 2 || stage === 3;

  useLayoutEffect(() => {
    if (!enabled || !tip) return;
    const target = document.querySelector<HTMLElement>(`[data-practice-guide="${tip.target}"]`);
    if (!target) return;
    const update = () => {
      const rect = target.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 32);
      const popoverHeight = Math.min(popoverRef.current?.offsetHeight ?? 260, window.innerHeight - 32);
      if (preferLeftPlacement && rect.left >= width + 32) {
        setPlacement("left");
        setPosition({
          width,
          left: Math.max(16, rect.left - width - 16),
          top: Math.max(16, Math.min(window.innerHeight - popoverHeight - 16, rect.top + 24)),
        });
        return;
      }
      const left = rect.width > 520
        ? Math.max(16, Math.min(window.innerWidth - width - 16, rect.right - width - 20))
        : Math.max(16, Math.min(window.innerWidth - width - 16, rect.left));
      const belowSpace = window.innerHeight - rect.bottom - 16;
      const aboveSpace = rect.top - 16;
      const useBelow = belowSpace >= popoverHeight || belowSpace >= aboveSpace;
      const desiredTop = useBelow ? rect.bottom + 14 : rect.top - popoverHeight - 14;
      const top = Math.max(16, Math.min(window.innerHeight - popoverHeight - 16, desiredTop));
      setPlacement(useBelow ? "below" : "above");
      setPosition({ width, left, top });
    };
    target.classList.add("practice-guide-active");
    update();
    // Wrapping changes after the initial width is applied, especially on narrow screens.
    const resizeObserver = new ResizeObserver(update);
    if (popoverRef.current) resizeObserver.observe(popoverRef.current);
    resizeObserver.observe(target);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      target.classList.remove("practice-guide-active");
      resizeObserver.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [enabled, preferLeftPlacement, tip, error]);

  if (!enabled || !tip) return null;
  const guideNumber = stage === 1 ? index + 1 : stage === 2 ? 3 : stage === 3 ? drawingPhase === "outline" ? 4 : 5 : stage + 2;
  return (
    <div className="practice-guide-root" role="dialog" aria-modal="true" aria-label="新手引导步骤说明" onKeyDown={(event) => { if (event.key === "Tab") { event.preventDefault(); popoverRef.current?.querySelector("button")?.focus(); } }}>
      <div className="practice-guide-layer"><div className="practice-guide-shade" /></div>
      <aside ref={popoverRef} className={`practice-guide-popover is-${placement}`} style={position}>
        <span className="practice-guide-index">引导 {guideNumber} / 7</span>
        <h2>{tip.title}</h2>
        <p>{tip.body}</p>
        {error && <p className="practice-guide-requirement" role="alert">{error}</p>}
        <div className="practice-guide-actions">
          <button className="primary-button" autoFocus disabled={busy} onClick={() => index < tips.length - 1 ? setIndex(index + 1) : onAdvance()}>{busy ? "正在完成…" : stage === 5 ? "完成新手引导" : "下一步"}<span>→</span></button>
        </div>
      </aside>
    </div>
  );
}

function PauseTaskButton({ onClick }: { onClick: () => void }) {
  return <button className="secondary-button pause-task-button" onClick={onClick}><Pause size={16} aria-hidden="true" />暂停任务</button>;
}

function StageAdvanceButton({ label, disabledReason, onClick }: { label: string; disabledReason: string | null; onClick: () => void }) {
  const tooltipId = useId();
  const disabled = Boolean(disabledReason);
  return (
    <span className={`disabled-action-hint stage-advance-hint ${disabled ? "has-reason" : ""}`} tabIndex={disabled ? 0 : undefined} aria-describedby={disabled ? tooltipId : undefined}>
      <button className="primary-button" disabled={disabled} onClick={onClick}>{label}<span>→</span></button>
      {disabledReason && <span className="disabled-action-tooltip" id={tooltipId} role="tooltip">{disabledReason}</span>}
    </span>
  );
}

export type OnlineStudyTask = {
  taskId: string;
  config: StudyConfig;
  material: StudyCase;
  entry: Record<string, unknown> | null;
  pausedAt: string | null;
  requiresStartConfirmation: boolean;
  previousInputReport?: PreviousInputReport | null;
  targetDrawingModes?: Record<string, DrawingMode>;
  skipQuestionnaire?: boolean;
  authoringFromGuides?: boolean;
};

type StudyAppProps = {
  localFirst?: boolean;
  debugMode?: boolean;
  mode?: "study" | "practice";
  onlineTask?: OnlineStudyTask;
  onlineSaveState?: string;
  onDraftChange?: (draft: StudyDraft) => void | Promise<void>;
  onPause?: () => Promise<void>;
  onResume?: (resumedAt: string) => Promise<void>;
  onTaskComplete?: (draft: StudyDraft) => Promise<void>;
  onPracticeExit?: () => void;
};

export function StudyApp({
  localFirst = false,
  debugMode = false,
  mode = "study",
  onlineTask,
  onlineSaveState,
  onDraftChange,
  onPause,
  onResume,
  onTaskComplete,
  onPracticeExit,
}: StudyAppProps) {
  const isOnline = Boolean(onlineTask);
  const isPractice = mode === "practice";
  const isGuideAuthoring = Boolean(onlineTask?.authoringFromGuides);
  // Keep researcher edits separate from formal drafts and published guide assets.
  const draftStorageKey = isGuideAuthoring
    ? labStorageKey(`tutorial-authoring:${onlineTask!.config.participantId}:v2`)
    : DRAFT_KEY;
  const [draft, setDraft] = useState<StudyDraft | null>(null);
  const [saveState, setSaveState] = useState("正在读取任务");
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [taskStartBusy, setTaskStartBusy] = useState(false);
  const [taskIntroOpen, setTaskIntroOpen] = useState(Boolean(onlineTask?.requiresStartConfirmation));
  const [transition, setTransition] = useState<Transition | null>(null);
  const [observationTargetId, setObservationTargetId] = useState<string | null>(null);
  const [reviewTargetId, setReviewTargetId] = useState<string | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [practiceCompletionError, setPracticeCompletionError] = useState("");
  const [practiceDrawingPhase, setPracticeDrawingPhase] = useState<PracticeDrawingPhase>("outline");
  const viewportStateCache = useRef<Record<number, HeritageViewportState>>({});

  useEffect(() => {
    if (!onlineTask) return;
    const requestedConfig = onlineTask.config;
    const studyCase = onlineTask.material;
    const config = studyCase.id === requestedConfig.caseId
      ? requestedConfig
      : { ...requestedConfig, caseId: studyCase.id, condition: "skeleton_no_llm" as const };
    try {
      const saved = window.localStorage.getItem(draftStorageKey);
      const raw = isPractice ? null : onlineTask?.entry
        ? onlineTask.entry as unknown as StudyDraft | LegacyStudyDraft
        : saved ? (JSON.parse(saved) as StudyDraft | LegacyStudyDraft) : null;
      const previousInputReport = onlineTask.previousInputReport ?? null;
      const parsed = raw && (raw.version === 3 || raw.version === 4)
        ? isGuideAuthoring && raw.version === 4 ? raw : migrateDraft(raw, previousInputReport)
        : null;
      const compatible = parsed
        && sameConfig(parsed.config, config)
        && studyCase.pages.some((page) => page.id === parsed.activePageId)
        && studyCase.targets.every((target) => parsed.answers[target.id]);
      let restored = compatible
        ? { ...parsed, pauseStartedAt: parsed.pauseStartedAt ?? null, pausePeriods: parsed.pausePeriods ?? [], reviewNote: parsed.reviewNote ?? "" }
        : isGuideAuthoring ? authoringDraftFromGuides(config, studyCase) : createDraft(config, studyCase, previousInputReport);
      if (isGuideAuthoring) {
        // Reopen even a previously submitted authoring copy for further edits.
        restored = { ...restored, stage: 3, pauseStartedAt: null,
          restorationSubmittedAt: null, questionnaireSubmittedAt: null,
          answers: Object.fromEntries(Object.entries(restored.answers).map(([id, answer]) => [id, { ...answer, finalDrawingPng: null }])) };
      }
      setDraft(onlineTask?.pausedAt && !restored.pauseStartedAt ? { ...restored, pauseStartedAt: onlineTask.pausedAt } : restored);
    } catch {
      const created = isGuideAuthoring ? authoringDraftFromGuides(config, studyCase) : createDraft(config, studyCase, onlineTask.previousInputReport ?? null);
      setDraft(onlineTask?.pausedAt ? { ...created, pauseStartedAt: onlineTask.pausedAt } : created);
    }
  }, [isPractice, isGuideAuthoring, draftStorageKey, onlineTask?.taskId]);

  useEffect(() => {
    if (!draft) return;
    if (isGuideAuthoring) {
      try {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
        setSaveState("补画草稿已保存到本机");
      } catch { setSaveState("本机保存失败，请勿关闭页面"); }
      return;
    }
    if (localFirst) {
      void Promise.resolve(onDraftChange?.(draft)).catch(() => setSaveState("本机保存失败，请勿关闭页面"));
      return;
    }
    setSaveState("保存中…");
    const timer = window.setTimeout(() => {
      try {
        if (isPractice) {
          setSaveState("练习内容不记录");
          return;
        }
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        if (isOnline) {
          setSaveState("已保存到本机 · 等待同步");
          onDraftChange?.(draft);
        } else {
          setSaveState("已自动保存");
          void archiveDraftToLocalFolder(draft as unknown as Record<string, unknown>).then((result) => {
            if (result === "saved") setSaveState("已自动保存 · 已归档到本地");
          });
        }
      } catch {
        setSaveState("保存失败，请联系研究人员");
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draft, isOnline, isPractice, isGuideAuthoring, draftStorageKey, localFirst, onDraftChange]);

  useEffect(() => {
    if (!draft?.pauseStartedAt) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [draft?.pauseStartedAt]);

  useEffect(() => {
    if (!localFirst) return;
    const pauseHidden = () => {
      if (document.visibilityState !== "hidden") return;
      const at = now();
      setDraft(current => current && current.stage < 6 && !current.pauseStartedAt
        ? { ...current, pauseStartedAt: at, events: [...current.events, { at, type: "task_paused", detail: "background" }] }
        : current);
    };
    document.addEventListener("visibilitychange", pauseHidden);
    return () => document.removeEventListener("visibilitychange", pauseHidden);
  }, [localFirst]);

  const studyCase = onlineTask?.material;
  if (!draft || !studyCase) return <main className="loading-state">正在准备碑刻材料…</main>;

  const activeTarget = studyCase.targets.find((target) => target.id === draft.activeCharacterId) ?? studyCase.targets[0];
  const activePage = getStudyPage(studyCase, draft.activePageId);
  const activeAnswer = draft.answers[activeTarget.id];
  const conditionSetting = getStudyCondition(draft.config.condition);
  const mixedDrawingModes = onlineTask?.targetDrawingModes ?? null;
  const activeDrawingMode = mixedDrawingModes?.[activeTarget.id] ?? conditionSetting.drawingMode;
  const setting = mixedDrawingModes
    ? { ...conditionSetting, drawingMode: activeDrawingMode }
    : isPractice
      ? { ...conditionSetting, drawingMode: practiceDrawingPhase }
      : { ...conditionSetting, drawingMode: activeDrawingMode };
  const isAi = setting.assistanceMode === "llm";
  const isOutline = setting.drawingMode === "outline";
  const drawingName = isOutline ? "outline" : "skeleton";
  const drawingNameZh = isOutline ? "轮廓" : "骨架";
  const drawingNameForTarget = (targetId: string) => (mixedDrawingModes?.[targetId] ?? setting.drawingMode) === "outline" ? "轮廓" : "骨架";
  const steps = ["整体观察", "字符判断", mixedDrawingModes ? "绘制修复" : isOutline ? "轮廓绘制" : "骨架绘制", "检查并提交", onlineTask?.skipQuestionnaire ? "完成" : "完成问卷"];
  const visibleStage = Math.min(draft.stage, 5);

  const recordEvent = (type: string, characterId?: string, detail?: string) =>
    setDraft((current) => current ? { ...current, events: [...current.events, { at: now(), type, characterId, detail }] } : current);

  const selectCharacter = (id: string) => {
    const target = studyCase.targets.find((item) => item.id === id);
    if (!target) return;
    const selectedDrawingMode = mixedDrawingModes?.[id];
    if (isPractice && draft.stage === 3 && selectedDrawingMode) setPracticeDrawingPhase(selectedDrawingMode);
    setFocusRequestKey((value) => value + 1);
    setDraft((current) => {
      if (!current) return current;
      const at = now();
      const events: StudyEvent[] = [...current.events, { at, type: "character_selected", characterId: id, detail: `page:${target.pageId}` }];
      if (current.activePageId !== target.pageId) events.push({ at, type: "page_changed", characterId: id, detail: `target:${target.pageId}` });
      const targetMode = mixedDrawingModes?.[id];
      return {
        ...current,
        activeCharacterId: id,
        activePageId: target.pageId,
        drawingSettings: targetMode ? { ...current.drawingSettings, brushWidth: defaultBrushWidth(targetMode) } : current.drawingSettings,
        events,
      };
    });
  };

  const selectObservationTarget = (id: string) => {
    setObservationTargetId(id);
    selectCharacter(id);
  };

  const selectReviewTarget = (id: string) => {
    setReviewTargetId(id);
    selectCharacter(id);
  };

  const selectPage = (pageId: number) => {
    if (!studyCase.pages.some((page) => page.id === pageId)) return;
    if (draft.stage === 1) setObservationTargetId(null);
    if (draft.stage === 4) setReviewTargetId(null);
    setDraft((current) => current ? {
      ...current,
      activePageId: pageId,
      events: [...current.events, { at: now(), type: "page_changed", detail: `manual:${pageId}` }],
    } : current);
  };

  const updateAnswer = (id: string, patch: Partial<CharacterAnswer>) =>
    setDraft((current) => current ? { ...current, answers: { ...current.answers, [id]: { ...current.answers[id], ...patch } } } : current);

  const updateGlobalBrushWidth = (value: number) => {
    const brushWidth = normalizeDrawingSetting(value, 2, 20, defaultBrushWidth(setting.drawingMode));
    setDraft((current) => current ? {
      ...current,
      drawingSettings: { ...current.drawingSettings, brushWidth },
      answers: Object.fromEntries(Object.entries(current.answers).map(([id, answer]) => [id, {
        ...answer,
        strokes: answer.strokes.map((stroke) => stroke.tool === "brush" ? { ...stroke, width: brushWidth } : stroke),
      }])),
    } : current);
  };

  const updateSourceOpacity = (value: number) => {
    const sourceOpacity = normalizeDrawingSetting(value, 20, 100, DEFAULT_DRAWING_SETTINGS.sourceOpacity);
    setDraft((current) => current ? {
      ...current,
      drawingSettings: { ...current.drawingSettings, sourceOpacity },
    } : current);
  };

  const updateStrokeOpacity = (value: number) => {
    const strokeOpacity = normalizeDrawingSetting(value, 20, 100, DEFAULT_DRAWING_SETTINGS.strokeOpacity);
    setDraft((current) => current ? {
      ...current,
      drawingSettings: { ...current.drawingSettings, strokeOpacity },
    } : current);
  };

  const completedHypotheses = studyCase.targets.filter((target) => isHypothesisComplete(draft.answers[target.id].hypothesis)).length;
  const completedDrawings = studyCase.targets.filter((target) => draft.answers[target.id].strokes.some((stroke) => stroke.tool === "brush")).length;
  const missingHypotheses = studyCase.targets.flatMap((target, index) => isHypothesisComplete(draft.answers[target.id].hypothesis) ? [] : [`字符 ${String(index + 1).padStart(2, "0")}`]);
  const missingDrawings = studyCase.targets.flatMap((target, index) => draft.answers[target.id].strokes.some((stroke) => stroke.tool === "brush") ? [] : [`字符 ${String(index + 1).padStart(2, "0")}`]);

  const pauseTask = () => {
    const at = now();
    setTransition(null);
    setDraft((current) => current && current.stage <= 5 && !current.pauseStartedAt ? {
      ...current,
      pauseStartedAt: at,
      events: [...current.events, { at, type: "task_paused", detail: `stage:${current.stage}` }],
    } : current);
    if (onPause) void onPause();
  };

  const resumeTask = () => {
    const at = now();
    setDraft((current) => {
      if (!current?.pauseStartedAt) return current;
      const period = { startedAt: current.pauseStartedAt, endedAt: at, durationMs: Math.max(0, Date.parse(at) - Date.parse(current.pauseStartedAt)) };
      return {
        ...current,
        pauseStartedAt: null,
        pausePeriods: [...current.pausePeriods, period],
        events: [...current.events, { at, type: "task_resumed", detail: `stage:${current.stage};paused:${period.durationMs}` }],
      };
    });
    if (onResume) {
      void onResume(at).catch(() => setSaveState("任务已继续 · 等待同步服务器"));
    }
  };

  const startTask = () => {
    setTaskStartBusy(true);
    resumeTask();
    setTaskIntroOpen(false);
    setTaskStartBusy(false);
  };

  const enterStage = (stage: Stage) => {
    const at = now();
    if (stage === 4) setReviewTargetId(null);
    if (isPractice && stage === 3) setPracticeDrawingPhase("outline");
    setDraft((current) => {
      if (!current) return current;
      const completedAt = { ...current.stageCompletedAt, [current.stage]: at };
      let answers = stage === 5
        ? Object.fromEntries(Object.entries(current.answers).map(([id, answer]) => [id, { ...answer, finalDrawingPng: renderDrawing(answer.strokes, "export") }]))
        : current.answers;
      const resetToFirstTarget = stage === 2 || stage === 3;
      const firstTarget = studyCase.targets[0];
      if (isPractice && stage === 3) {
        answers = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, {
          ...answer,
          strokes: practiceGuideForTarget(id) ? clonePracticeStrokes(id) : answer.strokes,
        }]));
      }
      return {
        ...current,
        stage,
        answers,
        drawingSettings: isPractice && stage === 3
          ? { ...current.drawingSettings, brushWidth: practiceGuideForTarget(firstTarget.id).brushWidth }
          : current.drawingSettings,
        activeCharacterId: resetToFirstTarget ? firstTarget.id : current.activeCharacterId,
        activePageId: resetToFirstTarget ? firstTarget.pageId : current.activePageId,
        restorationSubmittedAt: stage === 5 ? at : current.restorationSubmittedAt,
        restorationDurationMs: stage === 5 ? Date.parse(at) - Date.parse(current.startedAt) - pausedDurationBetween(current, current.startedAt, at) : current.restorationDurationMs,
        pointerSummary: stage === 5 ? summarizePointerUsage(answers) : current.pointerSummary,
        stageCompletedAt: completedAt,
        stageEnteredAt: { ...current.stageEnteredAt, [stage]: at },
        events: [...current.events, { at, type: stage === 5 ? "restoration_submitted" : "stage_entered", detail: String(stage) }],
      };
    });
    setTransition(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitQuestionnaire = async () => {
    const at = now();
    if (submissionBusy) return;
    const completedDraft: StudyDraft = {
      ...draft,
      stage: 6,
      questionnaireSubmittedAt: at,
      questionnaireDurationMs: draft.restorationSubmittedAt ? Date.parse(at) - Date.parse(draft.restorationSubmittedAt) - pausedDurationBetween(draft, draft.restorationSubmittedAt, at) : null,
      stageCompletedAt: { ...draft.stageCompletedAt, 5: at },
      inputReport: {
        ...draft.inputReport,
        deviceOther: draft.inputReport.deviceOther.trim(),
        inputMethodOther: draft.inputReport.inputMethodOther.trim(),
      },
      pointerSummary: summarizePointerUsage(draft.answers),
      events: [...draft.events, { at, type: "questionnaire_submitted" }],
    };
    if (onTaskComplete) {
      setSubmissionBusy(true);
      setSaveState(localFirst ? "正在保存本机提交…" : "正在提交到服务器…");
      try {
        if (!isPractice && !localFirst) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(completedDraft));
        await onTaskComplete(completedDraft);
      } catch {
        setSaveState(localFirst ? "本机提交保存失败，请勿关闭页面，请重试或联系研究者" : "提交失败，记录仍保存在本机，请检查网络后重试");
      } finally {
        setSubmissionBusy(false);
      }
    } else {
      setDraft(completedDraft);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const completeWithoutQuestionnaire = async () => {
    const at = now();
    if (submissionBusy) return;
    const answers = Object.fromEntries(Object.entries(draft.answers).map(([id, answer]) => [id, {
      ...answer,
      finalDrawingPng: renderDrawing(answer.strokes, "export"),
    }]));
    const completedDraft: StudyDraft = {
      ...draft,
      stage: 6,
      answers,
      restorationSubmittedAt: at,
      restorationDurationMs: Date.parse(at) - Date.parse(draft.startedAt) - pausedDurationBetween(draft, draft.startedAt, at),
      questionnaireSubmittedAt: null,
      questionnaireDurationMs: null,
      stageCompletedAt: { ...draft.stageCompletedAt, 4: at, 5: at },
      pointerSummary: summarizePointerUsage(answers),
      events: [...draft.events, { at, type: "tutorial_authoring_submitted" }],
    };
    if (onTaskComplete) {
      setSubmissionBusy(true);
      setSaveState("正在保存素材绘制…");
      try {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(completedDraft));
        await onTaskComplete(completedDraft);
      } catch {
        setSaveState("保存失败，记录仍保存在本机，请检查后重试");
      } finally {
        setSubmissionBusy(false);
      }
    }
  };

  const returnToDebugStage = (previousStage: Stage) => {
    if (!debugMode || draft.stage <= 1 || previousStage >= draft.stage || previousStage < 1) return;
    const at = now();
    setTransition(null);
    setObservationTargetId(null);
    setReviewTargetId(null);
    viewportStateCache.current = {};
    setDraft((current) => {
      if (!current || current.stage <= 1 || previousStage >= current.stage) return current;
      const firstTarget = studyCase.targets[0];
      const resetToFirstTarget = previousStage === 1 || previousStage === 2 || previousStage === 3;
      const activePageId = previousStage === 1
        ? studyCase.pages[0].id
        : resetToFirstTarget ? firstTarget.pageId : current.activePageId;
      const stageCompletedAt = Object.fromEntries(
        Object.entries(current.stageCompletedAt).filter(([stage]) => Number(stage) < previousStage),
      ) as StudyDraft["stageCompletedAt"];
      const stageEnteredAt = Object.fromEntries(
        Object.entries(current.stageEnteredAt).filter(([stage]) => Number(stage) < previousStage),
      ) as StudyDraft["stageEnteredAt"];
      const answers = previousStage < 5
        ? Object.fromEntries(Object.entries(current.answers).map(([id, answer]) => [id, { ...answer, finalDrawingPng: null }]))
        : current.answers;
      return {
        ...current,
        stage: previousStage,
        answers,
        activeCharacterId: resetToFirstTarget ? firstTarget.id : current.activeCharacterId,
        activePageId,
        restorationSubmittedAt: previousStage < 5 ? null : current.restorationSubmittedAt,
        restorationDurationMs: previousStage < 5 ? null : current.restorationDurationMs,
        questionnaireSubmittedAt: previousStage < 6 ? null : current.questionnaireSubmittedAt,
        questionnaireDurationMs: previousStage < 6 ? null : current.questionnaireDurationMs,
        stageCompletedAt,
        stageEnteredAt: { ...stageEnteredAt, [previousStage]: at },
        events: [...current.events, { at, type: "debug_stage_returned", detail: `${current.stage}->${previousStage}` }],
      };
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateDebugStage = (targetStage: Stage) => {
    if (!debugMode || targetStage === draft.stage) return;
    if (targetStage < draft.stage) {
      returnToDebugStage(targetStage);
      return;
    }
    const fromStage = draft.stage;
    enterStage(targetStage);
    recordEvent("debug_stage_navigated", undefined, `${fromStage}->${targetStage}`);
  };

  const openTransition = (target: Stage) => {
    const mixedDrawingCopy = Boolean(mixedDrawingModes);
    const content: Record<number, Transition> = {
      2: { target: 2, title: "整体观察已完成", body: `接下来将逐一判断 ${studyCase.targets.length} 个目标字符。整幅碑刻${isAi ? "和 AI 提示" : ""}仍会保留；提交判断后将不能修改。`, confirm: "进入字符判断" },
      3: { target: 3, title: "字符判断已完成", body: mixedDrawingCopy ? "接下来请分别按页面标注绘制两个字符的 skeleton 或 outline；切换字符时画笔粗细会自动调整。" : `接下来请根据残存证据和已确认字符，逐字绘制 ${drawingName}。原图、字符判断${isAi ? "和 AI 提示" : ""}仍会显示。`, confirm: mixedDrawingCopy ? "进入绘制修复" : `进入${drawingNameZh}绘制` },
      4: { target: 4, title: mixedDrawingCopy ? "绘制修复已完成" : `${drawingNameZh}绘制已完成`, body: mixedDrawingCopy ? "接下来将集中检查两个字符的判断和绘制结果。当前检查页只供核对，不支持返回修改。" : `接下来将集中检查所有字符判断和 ${drawingName}。当前检查页只供核对，不支持返回修改。`, confirm: "进入检查" },
      5: { target: 5, title: "确认提交修复结果", body: mixedDrawingCopy ? "所有字符判断、outline 与 skeleton 将被锁定并保存。提交后只需完成一份简短问卷。" : `所有字符判断与 ${drawingName} 将被锁定并保存。提交后只需完成一份简短问卷。`, confirm: "确认并提交" },
    };
    setTransition(content[target]);
  };

  const advancePracticeDrawing = () => {
    if (!isPractice) return;
    if (practiceDrawingPhase === "outline") {
      const at = now();
      const nextTargetId = practiceTargetForPhase("skeleton");
      const nextTarget = studyCase.targets.find((target) => target.id === nextTargetId) ?? studyCase.targets[1];
      setPracticeDrawingPhase("skeleton");
      setDraft((current) => current ? {
        ...current,
        activeCharacterId: nextTarget.id,
        activePageId: nextTarget.pageId,
        drawingSettings: { ...current.drawingSettings, brushWidth: practiceGuideForTarget(nextTarget.id).brushWidth },
        events: [...current.events, { at, type: "practice_drawing_phase_changed", detail: "outline->skeleton" }],
      } : current);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    enterStage(4);
  };

  const advancePracticeGuide = async () => {
    if (!isPractice || submissionBusy) return;
    if (draft.stage === 3) { advancePracticeDrawing(); return; }
    if (draft.stage < 5) { enterStage((draft.stage + 1) as Stage); return; }
    // A walkthrough completion is not a fabricated questionnaire or drawing entry.
    setSubmissionBusy(true);
    setPracticeCompletionError("");
    try { await onTaskComplete?.(draft); }
    catch { setPracticeCompletionError("暂时无法记录引导完成，请检查网络后重试。"); }
    finally { setSubmissionBusy(false); }
  };

  const inputReportComplete = Boolean(
    draft.inputReport.device
    && draft.inputReport.inputMethod
    && (draft.inputReport.device !== "other" || draft.inputReport.deviceOther.trim())
    && (draft.inputReport.inputMethod !== "other" || draft.inputReport.inputMethodOther.trim()),
  );
  const formalQuestionComplete = inputReportComplete && studyCase.targets.every((target) => {
    const answer = draft.answers[target.id];
    return answer.characterConfidence && answer.drawingConfidence;
  }) && draft.difficulty && (!isAi || draft.aiHelpfulness);
  const questionComplete = isPractice ? Boolean(draft.difficulty) : Boolean(formalQuestionComplete);
  const missingCharacterConfidence = studyCase.targets.filter((target) => !draft.answers[target.id].characterConfidence).length;
  const missingDrawingConfidence = studyCase.targets.filter((target) => !draft.answers[target.id].drawingConfidence).length;
  const questionnaireMissing = isPractice ? [!draft.difficulty ? "练习确认" : ""].filter(Boolean) : [
    !draft.inputReport.device || (draft.inputReport.device === "other" && !draft.inputReport.deviceOther.trim()) ? "作答设备" : "",
    !draft.inputReport.inputMethod || (draft.inputReport.inputMethod === "other" && !draft.inputReport.inputMethodOther.trim()) ? "绘制输入方式" : "",
    missingCharacterConfidence ? `${missingCharacterConfidence} 个字符判断信心` : "",
    missingDrawingConfidence ? `${missingDrawingConfidence} 个 ${drawingName} 信心` : "",
    !draft.difficulty ? "整体任务难度" : "",
    isAi && !draft.aiHelpfulness ? "AI 帮助程度" : "",
  ].filter(Boolean);

  return (
    <main className={isPractice ? "study-shell is-practice-walkthrough" : "study-shell"} inert={submissionBusy}>
      <header className="site-header">
        <div className="identity"><span className="seal" aria-hidden="true">修</span><div><p className="eyebrow">INSCRIPTION RESTORATION STUDY</p><p className="brand">碑刻字符修复工作台</p></div></div>
        <div className="study-header-tools">
          {isPractice && <button type="button" className="debug-back-button" onClick={onPracticeExit}><ArrowLeft size={15} aria-hidden="true" />返回 Dashboard</button>}
          {debugMode && <span className="debug-mode-badge"><Bug size={14} aria-hidden="true" />Debug mode</span>}
          {debugMode && draft.stage > 1 && <button type="button" className="debug-back-button" onClick={() => returnToDebugStage((draft.stage - 1) as Stage)}><ArrowLeft size={15} aria-hidden="true" />返回上一步</button>}
          <div className="save-state"><span />{onlineSaveState ?? saveState}</div>
        </div>
      </header>

      {draft.stage <= 5 && (
        <nav className="stepper" aria-label="任务进度" data-practice-guide={isPractice ? "roadmap" : undefined}>
          {steps.map((step, index) => {
            const roadmapStage = (index + 1) as Stage;
            const className = `step ${visibleStage === roadmapStage ? "is-current" : ""} ${visibleStage > roadmapStage ? "is-done" : ""}`;
            const content = <><span className="step-number">{visibleStage > roadmapStage ? "✓" : String(roadmapStage).padStart(2, "0")}</span><span>{step}</span></>;
            return debugMode
              ? <button type="button" className={className} key={step} aria-current={visibleStage === roadmapStage ? "step" : undefined} onClick={() => navigateDebugStage(roadmapStage)}>{content}</button>
              : <div className={className} key={step}>{content}</div>;
          })}
        </nav>
      )}

      {draft.stage === 1 && (
        <>
          <StageHeader stage={1} title="先观察整体，再作出判断" description="请仔细查看碑刻的整体布局、残存笔画和目标字符之间的位置关系。当您心中形成初步判断后，再进入下一步。" />
          <section className={`observation-layout ${isAi ? "has-ai" : ""}`} data-practice-guide={isPractice ? "stage1-viewer" : undefined}>
            <section className="viewer-card observation-viewer-card">
              <OriginalRubbingHeading />
              {!isAi && <ObservationDamageStrip studyCase={studyCase} activeId={activeTarget.id} onSelect={selectObservationTarget} showDamageSummary={!isPractice} />}
              <SourceViewer studyCase={studyCase} activeId={observationTargetId ?? (isAi ? "" : activeTarget.id)} activePageId={activePage.id} onPageChange={selectPage} onSelect={selectObservationTarget} answers={draft.answers} initialView="global" defaultPageDrawerOpen focusActiveTarget={Boolean(observationTargetId)} focusRequestKey={focusRequestKey} viewportStateCache={viewportStateCache} onInteraction={(type) => recordEvent(type, observationTargetId ?? (isAi ? undefined : activeTarget.id), `page:${activePage.id}`)} />
            </section>
            {isAi && <ObservationAiPanel studyCase={studyCase} pageId={activePage.id} activeId={observationTargetId} onSelect={selectObservationTarget} />}
          </section>
          <section className="stage-action"><div><span className="action-kicker">准备好了吗？</span><p>进入下一阶段后，您将逐一判断目标字符，且不能返回本页。</p></div><div className="stage-action-buttons"><PauseTaskButton onClick={pauseTask} /><button className="primary-button" onClick={() => openTransition(2)}>我已完成观察<span>→</span></button></div></section>
        </>
      )}

      {draft.stage === 2 && (
        <>
          <StageHeader stage={2} title="为每个目标字符作出明确判断" description="一次集中处理一个字符。您可以自由切换顺序，已填写的内容会自动保留。" />
          <section className="work-grid judgment-grid">
            <div className="viewer-card work-viewer"><OriginalRubbingHeading /><SourceViewer studyCase={studyCase} activeId={activeTarget.id} activePageId={activePage.id} onPageChange={selectPage} onSelect={selectCharacter} answers={draft.answers} compact focusActiveTarget focusRequestKey={focusRequestKey} viewportStateCache={viewportStateCache} onInteraction={(type) => recordEvent(type, activeTarget.id, `page:${activePage.id}`)} /></div>
            <aside className="task-panel judgment-panel" data-practice-guide={isPractice ? "stage2-input" : undefined}>
              <ParallelPanelHeading title="字符判断" />
              <div className="parallel-panel-body judgment-panel-body">
                <div className="panel-character-nav"><CharacterNav studyCase={studyCase} activeId={activeTarget.id} answers={draft.answers} mode="hypothesis" onSelect={selectCharacter} /></div>
                {isAi ? (
                  <div className="hypothesis-form">
                    <div className="judgment-evidence-item">
                      <JudgmentEvidenceCard
                        studyCase={studyCase}
                        target={activeTarget}
                        answer={activeAnswer}
                        onCandidateSelect={(candidate) => {
                          updateAnswer(activeTarget.id, { hypothesis: candidate.character, selectionSource: "ranked", candidateRank: candidate.rank, rejectedAll: false });
                          recordEvent("candidate_selected", activeTarget.id, String(candidate.rank));
                        }}
                        onCustomSelect={() => updateAnswer(activeTarget.id, { hypothesis: activeAnswer.selectionSource === "custom" ? activeAnswer.hypothesis : "", rejectedAll: true, selectionSource: "custom", candidateRank: null })}
                        onCustomChange={(value) => {
                          updateAnswer(activeTarget.id, { hypothesis: value, selectionSource: "custom", candidateRank: null, rejectedAll: true });
                          recordEvent("custom_hypothesis_edited", activeTarget.id);
                        }}
                      />
                      {activeAnswer.hypothesis && <div className="confirmed-answer"><span>当前判断</span><strong>{activeAnswer.hypothesis}</strong><small>{activeAnswer.selectionSource === "ranked" ? `AI 建议` : "自行输入"}</small></div>}
                    </div>
                  </div>
                ) : (
                  <>
                    <section className="no-llm-judgment-card" aria-label={`${activeTarget.label}字符判断`}>
                      <img src={activeTarget.glyphUrl} alt={`${activeTarget.label}残损局部图`} />
                      <div className="no-llm-judgment-input">
                        <span>我的判断</span>
                        <IdsCharacterInput key={activeTarget.id} value={activeAnswer.hypothesis} placeholder="请输入您判断的字符" ariaLabel={`${activeTarget.label}的字符判断`} onChange={(value) => { updateAnswer(activeTarget.id, { hypothesis: value, selectionSource: "custom", candidateRank: null, rejectedAll: false }); recordEvent("custom_hypothesis_edited", activeTarget.id); }} />
                      </div>
                    </section>
                    {activeAnswer.hypothesis && <div className="confirmed-answer"><span>当前判断</span><strong>{activeAnswer.hypothesis}</strong><small>自行输入</small></div>}
                  </>
                )}
              </div>
            </aside>
          </section>
          <section className="stage-action"><div><span className="action-kicker">已完成 {completedHypotheses} / {studyCase.targets.length}</span><p>所有字符都需要明确的 character hypothesis。</p></div><div className="stage-action-buttons"><PauseTaskButton onClick={pauseTask} /><StageAdvanceButton label="完成字符判断" disabledReason={missingHypotheses.length ? `请先完成 ${missingHypotheses.join("、")} 的字符判断。` : null} onClick={() => openTransition(3)} /></div></section>
        </>
      )}

      {draft.stage === 3 && (
        <>
          <StageHeader
            stage={3}
            stageName={isOutline ? "轮廓绘制" : "骨架绘制"}
            title={isOutline ? "绘制修复字符的完整边界" : "绘制字符的主要结构骨架"}
            description={isOutline ? "Outline 用来表达修复后字符笔画的完整外边界。请沿您判断的字形边缘绘制，不要只画中心线。" : "Skeleton 用来表达字符的主要中心线和整体结构，不需要模仿碑刻笔画的真实粗细。"}
          />
          <section className="work-grid drawing-grid">
            <div className="viewer-card work-viewer"><OriginalRubbingHeading /><SourceViewer studyCase={studyCase} activeId={activeTarget.id} activePageId={activePage.id} onPageChange={selectPage} onSelect={selectCharacter} answers={draft.answers} showDrawings compact focusActiveTarget focusRequestKey={focusRequestKey} viewportStateCache={viewportStateCache} onInteraction={(type) => recordEvent(type, activeTarget.id, `page:${activePage.id}`)} /></div>
            <aside className="task-panel drawing-panel" data-practice-guide={isPractice ? "stage3-drawing" : undefined}>
              <ParallelPanelHeading title={`${drawingNameZh}绘制`} />
              <div className="parallel-panel-body drawing-panel-body">
                <div className="panel-character-nav"><CharacterNav studyCase={studyCase} activeId={activeTarget.id} answers={draft.answers} mode="drawing" onSelect={selectCharacter} /></div>
                <div className="drawing-title"><h2>绘制 <span className={`drawing-character-token ${isIdsExpression(activeAnswer.hypothesis) ? "is-ids" : ""}`}>{activeAnswer.hypothesis}</span> 的 {drawingName}</h2></div>
                <DrawingCanvas
                  key={`${activeTarget.id}-${setting.drawingMode}`}
                  target={activeTarget}
                  strokes={activeAnswer.strokes}
                  drawingMode={setting.drawingMode}
                  brushWidth={draft.drawingSettings.brushWidth}
                  sourceOpacity={draft.drawingSettings.sourceOpacity}
                  strokeOpacity={draft.drawingSettings.strokeOpacity}
                  onBrushWidthChange={updateGlobalBrushWidth}
                  onSourceOpacityChange={updateSourceOpacity}
                  onStrokeOpacityChange={updateStrokeOpacity}
                  onChange={(strokes) => { updateAnswer(activeTarget.id, { strokes }); recordEvent("drawing_changed", activeTarget.id, `${setting.drawingMode}:${strokes.length}`); }}
                />
              </div>
            </aside>
          </section>
          <section className="stage-action"><div><span className="action-kicker">已完成 {completedDrawings} / {studyCase.targets.length}</span><p>每个字符至少需要一条有效画笔 stroke。</p></div><div className="stage-action-buttons"><PauseTaskButton onClick={pauseTask} /><StageAdvanceButton label={mixedDrawingModes ? "完成绘制修复" : `完成${drawingNameZh}绘制`} disabledReason={missingDrawings.length ? `请先为 ${missingDrawings.join("、")} 绘制至少一条有效画笔 stroke。` : null} onClick={() => openTransition(4)} /></div></section>
        </>
      )}

      {draft.stage === 4 && (
        <>
          <StageHeader stage={4} title="提交前，集中检查全部结果" description={mixedDrawingModes ? "请分别核对每个字符的最终判断、outline 或 skeleton。本页暂不支持修改；确认提交后，修复结果将被锁定。" : `请核对每个字符的最终判断和 ${drawingName}。本页暂不支持修改；确认提交后，修复结果将被锁定。`} />
          <section className="review-grid">
            <div className="viewer-card review-source"><OriginalRubbingHeading /><SourceViewer studyCase={studyCase} activeId={reviewTargetId ?? activeTarget.id} activePageId={activePage.id} onPageChange={selectPage} onSelect={selectReviewTarget} answers={draft.answers} showDrawings initialView="global" focusActiveTarget={Boolean(reviewTargetId)} focusRequestKey={focusRequestKey} viewportStateCache={viewportStateCache} /></div>
            <aside className="review-panel" data-practice-guide={isPractice ? "stage4-review" : undefined}>
              <ParallelPanelHeading title="结果检查" />
              <div className="parallel-panel-body review-panel-body">
                <div className="review-list">
                  {studyCase.targets.map((target) => {
                    const answer = draft.answers[target.id];
                    return (
                      <article
                        className={`review-item ${activeTarget.id === target.id ? "is-active" : ""}`}
                        key={target.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectReviewTarget(target.id)}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectReviewTarget(target.id); }}
                      >
                        <span className="review-target-label">{target.label}</span>
                        <div className="review-visual-pair">
                          <div className="review-visual-block">
                            <div className="glyph-review">
                              <img src={target.glyphUrl} alt={`${target.label}残损图`} />
                              <DrawingOverlay strokes={answer.strokes} />
                            </div>
                          </div>
                          <div className="review-visual-block">
                            <div className="glyph-review skeleton-only">
                              <img src={renderDrawing(answer.strokes, "export")} alt={`${target.label}白底黑线${drawingNameForTarget(target.id)}`} />
                            </div>
                          </div>
                        </div>
                        <div className="review-copy">
                          <strong>{answer.hypothesis}</strong>
                          <span className="stroke-count">
                            {answer.selectionSource === "ranked" ? `AI 建议` : "自行输入"}
                            {` · ${countBrushStrokes(answer.strokes)}条笔画`}
                          </span>
                        </div>
                        <span className="review-check">✓</span>
                      </article>
                    );
                  })}
                </div>
              </div>
            </aside>
          </section>
          <section className="stage-action submit-action"><div><span className="action-kicker">结果核对完成</span><p>{onlineTask?.skipQuestionnaire ? "提交后两个字符的绘制结果将保存为新手引导素材，不需要填写问卷。" : isPractice && mixedDrawingModes ? "提交后字符判断、outline 和 skeleton 将被锁定，随后完成一题引导确认。" : isPractice ? `提交后字符判断和 ${drawingName} 将被锁定，随后完成一题引导确认。` : `提交后字符判断和 ${drawingName} 将被锁定。如有需要补充说明的内容，可在下一页问卷中填写备注。`}</p></div><div className="stage-action-buttons"><PauseTaskButton onClick={pauseTask} /><button className="primary-button" disabled={submissionBusy} onClick={() => onlineTask?.skipQuestionnaire ? void completeWithoutQuestionnaire() : openTransition(5)}>{submissionBusy ? "正在保存…" : onlineTask?.skipQuestionnaire ? "保存素材绘制" : "确认并提交修复"}<span>→</span></button></div></section>
        </>
      )}

      {draft.stage === 5 && (
        <>
          <StageHeader stage={5} title="完成一份简短问卷" description={isPractice ? "问卷页面示例，本次引导无需填写。" : "您的修复结果已经保存并锁定。下列问题只用于记录本次任务的主观感受。"} />
          <section className="questionnaire" data-practice-guide={isPractice ? "stage5-survey" : undefined}>
            {isPractice ? (
              <article className="questionnaire-section">
                <div className="questionnaire-section-heading"><h2>问卷示例</h2></div>
                <div className="question-card overall-question">
                  <div className="question-row">
                    <h3>您觉得本次修复任务的整体难度如何？</h3>
                    <Rating label="任务难度示例" lowLabel="非常容易" highLabel="非常困难" value={draft.difficulty} onChange={(difficulty) => setDraft({ ...draft, difficulty })} />
                  </div>
                </div>
              </article>
            ) : <>
            <article className="questionnaire-section input-report-section">
              <div className="questionnaire-section-heading questionnaire-note-heading">
                <h2>作答方式</h2>
                {draft.inputReport.prefilledFromTaskOrder && <small>已沿用上一项任务的选择</small>}
              </div>
              <div className="question-card input-report-card">
                {draft.inputReport.prefilledFromTaskOrder && (
                  <p className="input-report-prefill">以下选项已根据任务 {String(draft.inputReport.prefilledFromTaskOrder).padStart(2, "0")} 自动填入；如果本次使用方式有变，请直接修改。</p>
                )}
                <div className="input-report-question">
                  <h3>本任务主要使用什么设备？</h3>
                  <SurveyChoice<ReportedDevice>
                    name="reported-device"
                    label="本任务主要使用的设备"
                    value={draft.inputReport.device}
                    options={[
                      { value: "computer", label: "电脑" },
                      { value: "tablet", label: "平板电脑（如 iPad）" },
                      { value: "other", label: "其他" },
                    ]}
                    onChange={(device) => setDraft({ ...draft, inputReport: { ...draft.inputReport, device, deviceOther: device === "other" ? draft.inputReport.deviceOther : "" } })}
                  />
                  {draft.inputReport.device === "other" && (
                    <label className="survey-other-field">
                      <span>请说明设备</span>
                      <input maxLength={50} value={draft.inputReport.deviceOther} onChange={(event) => setDraft({ ...draft, inputReport: { ...draft.inputReport, deviceOther: event.target.value } })} />
                    </label>
                  )}
                </div>
                <div className="input-report-question">
                  <h3>本任务绘制时主要使用什么输入方式？</h3>
                  <SurveyChoice<ReportedInputMethod>
                    name="reported-input-method"
                    label="本任务绘制时主要使用的输入方式"
                    value={draft.inputReport.inputMethod}
                    options={[
                      { value: "mouse", label: "鼠标" },
                      { value: "trackpad", label: "触控板" },
                      { value: "touch", label: "手指触控" },
                      { value: "stylus", label: "触控笔（如 Apple Pencil）" },
                      { value: "other", label: "其他" },
                    ]}
                    onChange={(inputMethod) => setDraft({ ...draft, inputReport: { ...draft.inputReport, inputMethod, inputMethodOther: inputMethod === "other" ? draft.inputReport.inputMethodOther : "" } })}
                  />
                  {draft.inputReport.inputMethod === "other" && (
                    <label className="survey-other-field">
                      <span>请说明输入方式</span>
                      <input maxLength={50} value={draft.inputReport.inputMethodOther} onChange={(event) => setDraft({ ...draft, inputReport: { ...draft.inputReport, inputMethodOther: event.target.value } })} />
                    </label>
                  )}
                </div>
              </div>
            </article>
            {studyCase.targets.map((target) => {
              const answer = draft.answers[target.id];
              return (
                <article className="questionnaire-section" key={target.id}>
                  <div className="questionnaire-section-heading character-question-heading">
                    <div className="question-target">
                      <div className="question-glyph"><img src={target.glyphUrl} alt="" /><DrawingOverlay strokes={answer.strokes} /></div>
                      <div><span className="small-label">{target.label}</span><strong>{answer.hypothesis}</strong></div>
                    </div>
                  </div>
                  <div className="question-card">
                    <div className="question-row">
                      <h3>您对字符判断有多少信心？</h3>
                      <Rating label={`${target.label}字符判断信心`} lowLabel="非常没有信心" highLabel="非常有信心" value={answer.characterConfidence} onChange={(value) => updateAnswer(target.id, { characterConfidence: value })} />
                    </div>
                    <div className="question-row">
                      <h3>{isOutline ? "您对所绘 outline 的边界准确性有多少信心？" : "您对所绘 skeleton 的结构有多少信心？"}</h3>
                      <Rating label={`${target.label}${drawingNameZh}信心`} lowLabel="非常没有信心" highLabel="非常有信心" value={answer.drawingConfidence} onChange={(value) => updateAnswer(target.id, { drawingConfidence: value })} />
                    </div>
                  </div>
                </article>
              );
            })}
            <article className="questionnaire-section">
              <div className="questionnaire-section-heading"><h2>整体任务评价</h2></div>
              <div className="question-card overall-question">
                <div className="question-row">
                  <h3>您认为本次任务的整体难度如何？</h3>
                  <Rating label="整体难度" lowLabel="非常容易" highLabel="非常困难" value={draft.difficulty} onChange={(difficulty) => setDraft({ ...draft, difficulty })} />
                </div>
                {isAi && <div className="question-row"><h3>AI 提示对完成本次任务有多大帮助？</h3><Rating label="AI 帮助程度" lowLabel="完全没有帮助" highLabel="非常有帮助" value={draft.aiHelpfulness} onChange={(aiHelpfulness) => setDraft({ ...draft, aiHelpfulness })} /></div>}
              </div>
            </article>
            <article className="questionnaire-section">
              <div className="questionnaire-section-heading questionnaire-note-heading"><h2>备注信息</h2><small>选填</small></div>
              <div className="question-card survey-note-card">
                <label className="survey-note-field">
                  <span className="visually-hidden">备注信息（选填）</span>
                  <textarea
                    value={draft.reviewNote}
                    maxLength={1000}
                    placeholder="如有需要，请在此补充说明。"
                    onChange={(event) => setDraft({ ...draft, reviewNote: event.target.value })}
                  />
                </label>
              </div>
            </article>
            </>}
          </section>
          <section className="stage-action"><div><span className="action-kicker">问卷完成状态</span><p>{questionComplete ? "所有必填项已完成。" : "请回答所有必填问题后提交。"}</p></div><div className="stage-action-buttons"><PauseTaskButton onClick={pauseTask} /><StageAdvanceButton label={submissionBusy ? "正在提交…" : isPractice ? "完成新手引导" : draft.config.taskOrder < 3 ? "提交问卷并完成本项任务" : "提交问卷并完成全部任务"} disabledReason={submissionBusy ? "正在等待服务器确认。" : questionnaireMissing.length ? `请先完成：${questionnaireMissing.join("、")}。` : null} onClick={() => void submitQuestionnaire()} /></div></section>
        </>
      )}

      {draft.stage === 6 && (
        <section className="completion-page"><span className="completion-seal">完</span><p className="section-index">TASK COMPLETED</p><h1>本次任务已完成</h1><p>修复结果和问卷均已安全保存。</p><div className="completion-meta"><span>{draft.config.participantId}</span><span>{draft.config.sessionId}</span><span>{getConditionLabel(draft.config.condition)}</span></div><button className="secondary-button completion-export-button" onClick={() => downloadJson(draftRecordFileName(draft as unknown as Record<string, unknown>), draft)}><Download size={16} aria-hidden="true" />导出任务记录</button></section>
      )}

      {draft.pauseStartedAt && !taskIntroOpen && (
        <div className="pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title" onKeyDown={(event) => { if (event.key === "Tab") event.preventDefault(); }}><div className="pause-dialog"><Pause size={34} aria-hidden="true" /><p className="section-index">TASK PAUSED</p><h2 id="pause-title">任务已暂停</h2><p>当前页面已锁定，暂停时间不会计入任务耗时。</p><button className="pause-resume-button" onClick={resumeTask} autoFocus><Play size={17} aria-hidden="true" />继续任务</button></div></div>
      )}

      {taskIntroOpen && <TaskIntroModal taskOrder={draft.config.taskOrder} drawingName={isOutline ? "outline" : "skeleton"} assisted={isAi} mixed={Boolean(mixedDrawingModes)} busy={taskStartBusy} onStart={startTask} />}
      {transition && <TransitionModal transition={transition} onCancel={() => setTransition(null)} onConfirm={() => enterStage(transition.target)} />}
      <PracticeGuide
        key={`${draft.stage}-${practiceDrawingPhase}`}
        stage={draft.stage}
        drawingPhase={practiceDrawingPhase}
        enabled={isPractice && draft.stage <= 5 && !taskIntroOpen && !draft.pauseStartedAt && !transition}
        busy={submissionBusy}
        error={practiceCompletionError}
        onAdvance={() => void advancePracticeGuide()}
      />
    </main>
  );
}
