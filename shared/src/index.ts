export interface EmailParticipant {
  name?: string;
  email?: string;
}

export interface ExtractedMessage {
  senderName?: string;
  senderEmail?: string;
  timestampText?: string;
  bodyText: string;
  isLatestVisible: boolean;
}

export type ReplyMode = "auto" | "fast" | "thinking";
export type ReplyTone = "concise" | "warm" | "formal" | "direct";
export type ReplyLength = "short" | "medium" | "detailed";
export type OverwriteBehavior = "replace" | "append";
export type ContextDepth = "latest" | "visibleThread";
export type EffectiveGleanMode = "fast" | "thinking";

export const LOCAL_BACKEND_HOST = "127.0.0.1";
export const DEFAULT_BACKEND_PORT = 8787;
export const DEFAULT_BACKEND_BASE_URL = `http://${LOCAL_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;
export const BACKEND_API_VERSION = 2;
// Must match the stable ID produced by extension/manifest.json's pinned public key.
export const PINNED_EXTENSION_ID = "odjbnkdimjemoifcndjpopoiifpdnlbo";
export const BACKEND_ENDPOINTS = {
  health: "/health",
  pairingConfirmed: "/pairing-confirmed",
  testGleanConnection: "/test-glean-connection",
  emailReply: "/draft-email-reply",
  newEmail: "/draft-new-email",
  slackReply: "/draft-slack-reply",
  webResponse: "/draft-web-response",
} as const;

export interface ReplySettings {
  replyMode: ReplyMode;
  defaultTone: ReplyTone;
  defaultLength: ReplyLength;
  overwriteBehavior: OverwriteBehavior;
  contextDepth: ContextDepth;
  writingPreferences: string;
}

export const DEFAULT_REPLY_SETTINGS: ReplySettings = {
  replyMode: "auto",
  defaultTone: "concise",
  defaultLength: "short",
  overwriteBehavior: "replace",
  contextDepth: "visibleThread",
  writingPreferences: "Do not use em dashes. Use commas, periods, colons, semicolons, or parentheses instead. Write concise, warm, direct replies. Avoid corporate filler.",
};

export interface DraftRequestPayload {
  threadSubject?: string;
  participantsVisible: string[];
  currentUser?: EmailParticipant;
  messages: ExtractedMessage[];
  userInstruction?: string;
  currentDraft?: string;
  clientTimezone?: string;
  activeComposerDetected: boolean;
  pageUrl: string;
  timestamp: string;
  clientRequestId: string;
}

export interface NewEmailRequestPayload {
  composeSubject?: string;
  recipientsVisible: string[];
  currentUser?: EmailParticipant;
  userInstruction: string;
  currentDraft?: string;
  clientTimezone?: string;
  activeComposerDetected: boolean;
  pageUrl: string;
  timestamp: string;
  clientRequestId: string;
}

export interface SlackDraftRequestPayload {
  workspaceName?: string;
  channelName?: string;
  threadTitle?: string;
  participantsVisible: string[];
  currentUser?: EmailParticipant;
  messages: ExtractedMessage[];
  userInstruction?: string;
  currentDraft?: string;
  clientTimezone?: string;
  activeComposerDetected: boolean;
  pageUrl: string;
  timestamp: string;
  clientRequestId: string;
}

export interface WebDraftRequestPayload {
  pageTitle: string;
  pageUrl: string;
  selectedText: string;
  nearbyText: string;
  pageText: string;
  activeFieldText: string;
  userInstruction: string;
  clientTimezone?: string;
  activeComposerDetected: boolean;
  timestamp: string;
  clientRequestId: string;
}

export interface GroundingSource {
  label: string;
  detail: string;
}

export interface DraftCalendarStatus {
  requested: boolean;
  detail: string;
}

export interface DraftVariant {
  draft: string;
  label: string;
  subject?: string;
}

export interface DraftTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  modelName?: string;
  provider?: string;
  isGleanHostedModel?: boolean;
  estimatedCostUsd: number | null;
  estimatedCostSource?: "glean" | "vendor-list-price" | "unavailable";
  source: "glean" | "estimated";
  note: string;
}

export interface DraftResponsePayload {
  draft: string;
  subject?: string;
  variants: DraftVariant[];
  selectedVariantIndex: number;
  effectiveGleanMode: EffectiveGleanMode;
  overwriteBehavior: OverwriteBehavior;
  summary: string;
  groundingSources: GroundingSource[];
  calendarStatus?: DraftCalendarStatus;
  tokenUsage?: DraftTokenUsage;
  requestId: string;
  warnings: string[];
}

export interface DraftErrorPayload {
  error: string;
  requestId?: string;
  warnings?: string[];
}
