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

export interface DraftVariant {
  draft: string;
  label: string;
}

export interface DraftResponsePayload {
  draft: string;
  variants: DraftVariant[];
  selectedVariantIndex: number;
  effectiveGleanMode: EffectiveGleanMode;
  overwriteBehavior: OverwriteBehavior;
  summary: string;
  requestId: string;
  warnings: string[];
}

export interface DraftErrorPayload {
  error: string;
  requestId?: string;
  warnings?: string[];
}
