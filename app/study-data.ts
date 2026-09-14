export type StudyCondition = "skeleton_no_llm" | "skeleton_llm_assisted" | "outline_no_llm";
export type DrawingMode = "skeleton" | "outline";
export type AssistanceMode = "none" | "llm";

export type StudyConditionDefinition = {
  id: StudyCondition;
  label: string;
  description: string;
  drawingMode: DrawingMode;
  assistanceMode: AssistanceMode;
};

export type Candidate = {
  rank: number;
  character: string;
  confidence: number;
};

export type StudyPage = {
  id: number;
  index: number;
  label: string;
  imageUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  format: string;
  transcription: string;
  targetCount: number;
};

export type TargetCharacter = {
  id: string;
  glyphId: string;
  label: string;
  pageId: number;
  sequence: number;
  pageSequence: number;
  transcription: string;
  bbox: { x: number; y: number; width: number; height: number };
  crop: { x: number; y: number; size: number };
  glyphUrl: string;
  maskUrl: string;
  maskLevel: 3 | 5 | 7 | 10 | 20;
  maskComponents: Array<{ templateFile: string; rotationDegrees: 0 | 90 | 180 | 270 }>;
  damageTier: 1 | 2 | 3 | null;
  damageSeverity: "Mild" | "Medium" | "Severe" | "Legacy test";
  maskRatio: number;
  candidates: Candidate[];
};

export type ExtraDamageCharacter = {
  id: string;
  glyphId: string;
  pageId: number;
  sequence: number;
  pageSequence: number;
  transcription: string;
  crop: { x: number; y: number; size: number };
  glyphUrl: string;
  maskUrl: string;
  maskLevel: 5 | 10 | 20;
  damageTier: 1 | 2 | 3;
  damageSeverity: "Mild" | "Medium" | "Severe";
  maskRatio: number;
};

export type StudyCase = {
  id: string;
  caseName: string;
  caseSetId: string;
  caseSetName: string;
  title: string;
  zitieId: string;
  zitieIdPrefix: string;
  sourceCollection: "online_prepared_material";
  referenceId: string;
  coverImageUrl?: string;
  transcription: string;
  transcriptionDirection: "horizontal" | "vertical";
  aiPredictionMetadata: {
    model: string;
    generatedAt: string;
    isDummy: boolean;
    availability?: "available" | "unavailable";
  };
  pages: StudyPage[];
  targets: TargetCharacter[];
  extraDamage: ExtraDamageCharacter[];
  readiness: {
    status: "simulated" | "pilot_ready";
    hasTranscription: boolean;
    hasAiCandidates: boolean;
  };
};

export const DEFAULT_CASE_ID = "case_01";

export function getCaseDisplayName(value: StudyCase | string) {
  const studyCase = typeof value === "string" ? undefined : value;
  const caseId = typeof value === "string" ? value : value.id;
  const match = caseId.match(/^case_([0-9a-f]{6})__.+__cfg-([0-9a-f]{4})$/u);
  const prefix = studyCase?.zitieIdPrefix ?? match?.[1] ?? "unknown";
  const configCode = match?.[2];
  const title = studyCase?.title ? `${studyCase.title} · ` : "";
  const config = configCode ? `cfg-${configCode} · ` : "";
  return `${config}${title}${prefix}`;
}

export const getStudyPage = (studyCase: StudyCase, pageId: number) =>
  studyCase.pages.find((page) => page.id === pageId) ?? studyCase.pages[0];

export const STUDY_CONDITIONS: StudyConditionDefinition[] = [
  {
    id: "skeleton_no_llm",
    label: "Skeleton · No LLM",
    description: "不显示转录和候选字，绘制字符结构骨架",
    drawingMode: "skeleton",
    assistanceMode: "none",
  },
  {
    id: "skeleton_llm_assisted",
    label: "Skeleton · LLM-assisted",
    description: "显示 AI 转录和候选字，绘制字符结构骨架",
    drawingMode: "skeleton",
    assistanceMode: "llm",
  },
  {
    id: "outline_no_llm",
    label: "Outline · No LLM",
    description: "不显示转录和候选字，绘制修复字符完整边界",
    drawingMode: "outline",
    assistanceMode: "none",
  },
];

export const CONDITION_LABELS = Object.fromEntries(
  STUDY_CONDITIONS.map((condition) => [condition.id, condition.label]),
) as Record<StudyCondition, string>;

export function normalizeStudyCondition(value: unknown): StudyCondition {
  if (value === "human_only") return "skeleton_no_llm";
  if (value === "ai_assisted") return "skeleton_llm_assisted";
  return STUDY_CONDITIONS.some((condition) => condition.id === value)
    ? value as StudyCondition
    : "skeleton_no_llm";
}

export function isSupportedStudyCondition(value: unknown) {
  return value === "human_only"
    || value === "ai_assisted"
    || STUDY_CONDITIONS.some((condition) => condition.id === value);
}

export function getStudyCondition(value: unknown) {
  const normalized = normalizeStudyCondition(value);
  return STUDY_CONDITIONS.find((condition) => condition.id === normalized)!;
}

export function getConditionLabel(value: unknown) {
  return getStudyCondition(value).label;
}
