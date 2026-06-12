import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { DraftCalendarStatus, DraftErrorPayload, DraftResponsePayload, GroundingSource } from "@gmail-glean-reply-drafter/shared";
import type { AppConfig } from "./config.js";
import { draftWithGlean, testGleanConnection } from "./gleanClient.js";
import { buildNewEmailPrompt, buildReplyPrompt } from "./prompt.js";
import { draftRequestSchema, newEmailRequestSchema, type ValidDraftRequest, type ValidNewEmailRequest } from "./schema.js";

const testGleanConnectionSchema = z.object({
  gleanServerUrl: z.string().url().optional(),
  gleanApiToken: z.string().max(8192).optional(),
});

export function createBackendApp(config: AppConfig) {
  const app = express();
  const requestTimestampsByIp = new Map<string, number[]>();

  const allowedOrigins = [/^chrome-extension:\/\//, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

  app.use(
    cors({
      origin: allowedOrigins,
    })
  );
  app.use(express.json({ limit: "256kb" }));
  app.use((req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }

    const now = Date.now();
    const windowStart = now - 60_000;
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const recent = (requestTimestampsByIp.get(key) || []).filter((timestamp) => timestamp > windowStart);
    if (recent.length >= 20) {
      res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      return;
    }

    recent.push(now);
    requestTimestampsByIp.set(key, recent);
    next();
  });
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (!origin || allowedOrigins.some((pattern) => pattern.test(origin))) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden origin." });
  });
  app.use((req, res, next) => {
    if (req.method !== "POST" || !config.sharedSecret) {
      next();
      return;
    }

    const suppliedSecret = req.header("x-backend-secret");
    if (!suppliedSecret || !secureStringEquals(suppliedSecret, config.sharedSecret)) {
      res.status(401).json({ error: "Extension is not paired with Gmail Glean Helper. Open the helper app, click Pair extension, then try again." });
      return;
    }

    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      gleanConfigured: Boolean(config.gleanStubMode || (config.gleanServerUrl && config.gleanApiToken)),
      stubMode: config.gleanStubMode,
    });
  });

  app.post("/pairing-confirmed", async (_req, res) => {
    await config.onPairingConfirmed?.();
    res.json({ ok: true });
  });

  app.post("/test-glean-connection", async (req, res) => {
    const parsed = testGleanConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid connection test payload." });
      return;
    }

    const testConfig: AppConfig = { ...config };
    const gleanServerUrl = parsed.data.gleanServerUrl || config.gleanServerUrl;
    const gleanApiToken = parsed.data.gleanApiToken || config.gleanApiToken;
    if (gleanServerUrl) {
      testConfig.gleanServerUrl = gleanServerUrl;
    }
    if (gleanApiToken) {
      testConfig.gleanApiToken = gleanApiToken;
    }

    try {
      await testGleanConnection(testConfig);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach Glean.";
      if (isGleanAuthError(message)) {
        res.status(401).json({ error: getGleanAuthErrorMessage() });
        return;
      }
      res.status(502).json({ error: message });
    }
  });

  app.post("/draft-email-reply", async (req, res) => {
    const startedAt = Date.now();
    const requestId = req.body?.clientRequestId || crypto.randomUUID();

    const parsed = draftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const body: DraftErrorPayload = {
        error: "Invalid draft request payload.",
        requestId,
        warnings: parsed.error.issues.map((issue) => issue.message),
      };
      res.status(400).json(body);
      return;
    }

    const payload = parsed.data;
    console.info("draft_request_started", {
      requestId,
      visibleMessageCount: payload.messages.length,
      hasSubject: Boolean(payload.threadSubject),
    });

    try {
      const schedulingIntent = hasSchedulingIntent(payload);
      const prompt = buildReplyPrompt(payload, config.replySettings);
      const result = await draftWithGlean(prompt, config, {
        messageCount: payload.messages.length,
        totalBodyChars: payload.messages.reduce((total, message) => total + message.bodyText.length, 0),
        userInstructionChars: payload.userInstruction?.length ?? 0,
        schedulingIntent,
      });
      const response: DraftResponsePayload = {
        draft: result.draft,
        variants: result.variants,
        selectedVariantIndex: 0,
        effectiveGleanMode: result.effectiveMode,
        overwriteBehavior: config.replySettings.overwriteBehavior,
        summary: `Drafted from ${payload.messages.length} visible message${payload.messages.length === 1 ? "" : "s"} using ${result.effectiveMode} mode.`,
        groundingSources: buildReplyGroundingSources(payload, schedulingIntent, result.effectiveMode),
        calendarStatus: buildCalendarStatus(schedulingIntent),
        requestId,
        warnings: buildDraftWarnings(schedulingIntent),
      };

      console.info("draft_request_succeeded", {
        requestId,
        latencyMs: Date.now() - startedAt,
        visibleMessageCount: payload.messages.length,
      });
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Draft generation failed.";
      console.warn("draft_request_failed", {
        requestId,
        latencyMs: Date.now() - startedAt,
        error: message,
      });
      const friendlyMessage = toFriendlyDraftError(message);
      const body: DraftErrorPayload = { error: friendlyMessage, requestId };
      res.status(isGleanAuthError(message) ? 401 : message.includes("timed out") ? 504 : 502).json(body);
    }
  });

  app.post("/draft-new-email", async (req, res) => {
    const startedAt = Date.now();
    const requestId = req.body?.clientRequestId || crypto.randomUUID();

    const parsed = newEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const body: DraftErrorPayload = {
        error: "Invalid new email draft request payload.",
        requestId,
        warnings: parsed.error.issues.map((issue) => issue.message),
      };
      res.status(400).json(body);
      return;
    }

    const payload = parsed.data;
    console.info("new_email_draft_started", {
      requestId,
      hasSubject: Boolean(payload.composeSubject),
      recipientCount: payload.recipientsVisible.length,
    });

    try {
      const schedulingIntent = hasNewEmailSchedulingIntent(payload);
      const prompt = buildNewEmailPrompt(payload, config.replySettings);
      const result = await draftWithGlean(prompt, config, {
        messageCount: 0,
        totalBodyChars: payload.currentDraft?.length ?? 0,
        userInstructionChars: payload.userInstruction.length,
        schedulingIntent,
      });
      const parsedVariants = result.variants.map((variant) => {
        const parsedDraft = parseNewEmailDraft(variant.draft, payload.composeSubject);
        return { ...variant, draft: parsedDraft.body, subject: parsedDraft.subject };
      });
      const selected = parsedVariants.at(0) ?? { draft: result.draft, label: "Draft 1", subject: payload.composeSubject || "Draft email" };
      const response: DraftResponsePayload = {
        draft: selected.draft,
        subject: selected.subject,
        variants: parsedVariants.length ? parsedVariants : [selected],
        selectedVariantIndex: 0,
        effectiveGleanMode: result.effectiveMode,
        overwriteBehavior: config.replySettings.overwriteBehavior,
        summary: selected.subject ? "Drafted a new email with subject \"" + selected.subject + "\" using " + result.effectiveMode + " mode." : "Drafted a new email using " + result.effectiveMode + " mode.",
        groundingSources: buildNewEmailGroundingSources(payload, schedulingIntent, result.effectiveMode),
        calendarStatus: buildCalendarStatus(schedulingIntent),
        requestId,
        warnings: buildDraftWarnings(schedulingIntent),
      };

      console.info("new_email_draft_succeeded", {
        requestId,
        latencyMs: Date.now() - startedAt,
      });
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "New email draft generation failed.";
      console.warn("new_email_draft_failed", {
        requestId,
        latencyMs: Date.now() - startedAt,
        error: message,
      });
      const friendlyMessage = toFriendlyDraftError(message);
      const body: DraftErrorPayload = { error: friendlyMessage, requestId };
      res.status(isGleanAuthError(message) ? 401 : message.includes("timed out") ? 504 : 502).json(body);
    }
  });

  return app;
}

function toFriendlyDraftError(message: string) {
  const normalized = message.toLowerCase();
  if (isGleanAuthError(message)) return getGleanAuthErrorMessage();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "Glean timed out: Open Gmail Glean Helper, increase Timeout, then try again. For scheduling requests, keep Thinking mode because calendar checks can take longer.";
  }
  if (normalized.includes("not configured") || normalized.includes("glean is not configured")) {
    return "Glean is not configured: Open Gmail Glean Helper, enter your Glean server URL and Client API token, click Save, then Test Glean.";
  }
  if (normalized.includes("empty draft")) {
    return "No draft returned: Try again with a clearer instruction. If this was a scheduling request, confirm your Glean token has calendar action access.";
  }
  if (normalized.includes("calendar") || normalized.includes("free slots")) {
    return "Calendar check problem: Confirm your Glean token includes calendar or Google Calendar action access, then click Test Glean and try again.";
  }
  return message;
}

function isGleanAuthError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("glean chat 401") || normalized.includes("glean chat 403") || normalized.includes("please authenticate") || normalized.includes("unauthorized");
}

function getGleanAuthErrorMessage() {
  return "Glean token problem: open Gmail Glean Helper, paste a fresh Client API token with CHAT and SEARCH scopes, click Save and start, then try again.";
}

function secureStringEquals(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function hasSchedulingIntent(payload: ValidDraftRequest) {
  const text = [
    payload.threadSubject,
    payload.userInstruction,
    payload.currentDraft,
    ...payload.messages.map((message) => message.bodyText),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /\b(schedule|scheduling|calendar|available|availability|free|busy|meet|meeting|call|sync|slot|slots|time|times|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/.test(text);
}

function parseNewEmailDraft(value: string, fallbackSubject?: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const subjectMatch = normalized.match(/^\s*Subject\s*:\s*(.+)$/im);
  const bodyMatch = normalized.match(/^\s*Body\s*:\s*\n?([\s\S]*)$/im);
  const subject = cleanGeneratedSubject(subjectMatch?.[1]) || fallbackSubject || "Draft email";
  let body = bodyMatch?.[1]?.trim() || normalized;
  body = body.replace(/^\s*Subject\s*:.+$/im, "").replace(/^\s*Body\s*:\s*/im, "").trim();
  return { subject, body };
}

function cleanGeneratedSubject(value: string | undefined) {
  return value?.replace(/^"|"$/g, "").trim();
}

function hasNewEmailSchedulingIntent(payload: ValidNewEmailRequest) {
  const text = [payload.composeSubject, payload.userInstruction, payload.currentDraft]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /\b(schedule|scheduling|calendar|available|availability|free|busy|meet|meeting|call|sync|slot|slots|time|times|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/.test(text);
}

function buildReplyGroundingSources(payload: ValidDraftRequest, schedulingIntent: boolean, effectiveMode: string): GroundingSource[] {
  const sources: GroundingSource[] = [
    { label: "Visible Gmail thread", detail: `${payload.messages.length} visible message${payload.messages.length === 1 ? "" : "s"} extracted from the current Gmail view.` },
  ];
  if (payload.currentDraft) sources.push({ label: "Current draft", detail: "Existing text in the reply box was used as draft context." });
  if (payload.userInstruction) sources.push({ label: "User instruction", detail: "The note typed in the Glean reply panel was included." });
  sources.push({ label: "Glean mode", detail: effectiveMode === "thinking" ? "Thinking mode was used for deeper reasoning." : "Fast mode was used for a quick draft." });
  if (schedulingIntent) sources.push({ label: "Calendar availability", detail: "Requested through Glean's Google Calendar/free-slots action if your token and Glean tenant support it." });
  return sources;
}

function buildNewEmailGroundingSources(payload: ValidNewEmailRequest, schedulingIntent: boolean, effectiveMode: string): GroundingSource[] {
  const sources: GroundingSource[] = [
    { label: "New compose instruction", detail: "The goal typed in the Glean panel was used as the main source." },
  ];
  if (payload.composeSubject) sources.push({ label: "Subject field", detail: "The current Gmail subject was included." });
  if (payload.currentDraft) sources.push({ label: "Current draft", detail: "Existing text in the compose body was used as draft context." });
  if (payload.recipientsVisible.length) sources.push({ label: "Visible recipients", detail: `${payload.recipientsVisible.length} visible recipient${payload.recipientsVisible.length === 1 ? "" : "s"} were included.` });
  sources.push({ label: "Glean mode", detail: effectiveMode === "thinking" ? "Thinking mode was used for deeper reasoning." : "Fast mode was used for a quick draft." });
  if (schedulingIntent) sources.push({ label: "Calendar availability", detail: "Requested through Glean's Google Calendar/free-slots action if your token and Glean tenant support it." });
  return sources;
}

function buildCalendarStatus(schedulingIntent: boolean): DraftCalendarStatus {
  if (!schedulingIntent) {
    return { requested: false, detail: "No scheduling language detected, calendar was not requested." };
  }

  return {
    requested: true,
    detail: "Scheduling language detected. The draft prompt asked Glean to check real availability using its Google Calendar/free-slots action when available. This app does not connect to Google Calendar directly.",
  };
}

function buildDraftWarnings(schedulingIntent: boolean) {
  if (!schedulingIntent) return [];
  return [
    "Calendar availability is handled through Glean actions. If the draft does not explicitly say availability was checked, verify the time before sending.",
  ];
}
