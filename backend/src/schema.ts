import { z } from "zod";

export const draftRequestSchema = z.object({
  threadSubject: z.string().optional(),
  participantsVisible: z.array(z.string()).default([]),
  currentUser: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  messages: z
    .array(
      z.object({
        senderName: z.string().optional(),
        senderEmail: z.string().optional(),
        timestampText: z.string().optional(),
        bodyText: z.string().min(1),
        isLatestVisible: z.boolean(),
      })
    )
    .min(1),
  userInstruction: z.string().max(2000).optional(),
  currentDraft: z.string().max(10000).optional(),
  clientTimezone: z.string().max(100).optional(),
  activeComposerDetected: z.boolean(),
  pageUrl: z.string(),
  timestamp: z.string(),
  clientRequestId: z.string().min(1),
});

export const newEmailRequestSchema = z.object({
  composeSubject: z.string().max(500).optional(),
  recipientsVisible: z.array(z.string().max(500)).default([]),
  currentUser: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  userInstruction: z.string().trim().min(1, "Describe what this new email should accomplish.").max(3000),
  currentDraft: z.string().max(10000).optional(),
  clientTimezone: z.string().max(100).optional(),
  activeComposerDetected: z.boolean(),
  pageUrl: z.string(),
  timestamp: z.string(),
  clientRequestId: z.string().min(1),
});

export const slackDraftRequestSchema = z.object({
  workspaceName: z.string().max(500).optional(),
  channelName: z.string().max(500).optional(),
  threadTitle: z.string().max(500).optional(),
  participantsVisible: z.array(z.string().max(500)).default([]),
  currentUser: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  messages: z
    .array(
      z.object({
        senderName: z.string().optional(),
        senderEmail: z.string().optional(),
        timestampText: z.string().optional(),
        bodyText: z.string().min(1),
        isLatestVisible: z.boolean(),
      })
    )
    .min(1),
  userInstruction: z.string().max(2000).optional(),
  currentDraft: z.string().max(10000).optional(),
  clientTimezone: z.string().max(100).optional(),
  activeComposerDetected: z.boolean(),
  pageUrl: z.string(),
  timestamp: z.string(),
  clientRequestId: z.string().min(1),
});

export type ValidDraftRequest = z.infer<typeof draftRequestSchema>;
export type ValidNewEmailRequest = z.infer<typeof newEmailRequestSchema>;
export type ValidSlackDraftRequest = z.infer<typeof slackDraftRequestSchema>;
