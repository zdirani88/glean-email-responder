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
  activeComposerDetected: z.boolean(),
  pageUrl: z.string(),
  timestamp: z.string(),
  clientRequestId: z.string().min(1),
});

export type ValidDraftRequest = z.infer<typeof draftRequestSchema>;
