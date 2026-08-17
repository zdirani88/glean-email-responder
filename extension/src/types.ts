import type { DraftRequestPayload, DraftResponsePayload, NewEmailRequestPayload, SlackDraftRequestPayload, WebDraftRequestPayload } from "@gmail-glean-reply-drafter/shared";

export interface ExtensionConfig {
  backendBaseUrl: string;
  backendSecret?: string;
}

export type ContentMessage =
  | { type: "DRAFT_REPLY_COMMAND" }
  | { type: "DRAFT_REPLY_FROM_UI" };

export type BackgroundMessage =
  | { type: "REQUEST_DRAFT"; payload: DraftRequestPayload }
  | { type: "REQUEST_NEW_EMAIL_DRAFT"; payload: NewEmailRequestPayload }
  | { type: "REQUEST_SLACK_DRAFT"; payload: SlackDraftRequestPayload }
  | { type: "REQUEST_WEB_DRAFT"; payload: WebDraftRequestPayload };

export type BackgroundResponse =
  | { ok: true; data: DraftResponsePayload }
  | { ok: false; error: string };
