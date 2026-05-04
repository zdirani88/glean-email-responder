import type { DraftRequestPayload, DraftResponsePayload } from "@gmail-glean-reply-drafter/shared";

export interface ExtensionConfig {
  backendBaseUrl: string;
  backendSecret?: string;
}

export type ContentMessage =
  | { type: "DRAFT_REPLY_COMMAND" }
  | { type: "DRAFT_REPLY_FROM_UI" };

export type BackgroundMessage =
  | { type: "REQUEST_DRAFT"; payload: DraftRequestPayload };

export type BackgroundResponse =
  | { ok: true; data: DraftResponsePayload }
  | { ok: false; error: string };
