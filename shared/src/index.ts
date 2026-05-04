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

export interface DraftRequestPayload {
  threadSubject?: string;
  participantsVisible: string[];
  currentUser?: EmailParticipant;
  messages: ExtractedMessage[];
  activeComposerDetected: boolean;
  pageUrl: string;
  timestamp: string;
  clientRequestId: string;
}

export interface DraftResponsePayload {
  draft: string;
  summary: string;
  requestId: string;
  warnings: string[];
}

export interface DraftErrorPayload {
  error: string;
  requestId?: string;
  warnings?: string[];
}
