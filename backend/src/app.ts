import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { DraftErrorPayload, DraftResponsePayload } from "@gmail-glean-reply-drafter/shared";
import type { AppConfig } from "./config.js";
import { draftWithGlean, testGleanConnection } from "./gleanClient.js";
import { buildReplyPrompt } from "./prompt.js";
import { draftRequestSchema, type ValidDraftRequest } from "./schema.js";

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
      const prompt = buildReplyPrompt(payload, config.replySettings);
      const result = await draftWithGlean(prompt, config, {
        messageCount: payload.messages.length,
        totalBodyChars: payload.messages.reduce((total, message) => total + message.bodyText.length, 0),
        userInstructionChars: payload.userInstruction?.length ?? 0,
        schedulingIntent: hasSchedulingIntent(payload),
      });
      const response: DraftResponsePayload = {
        draft: result.draft,
        variants: result.variants,
        selectedVariantIndex: 0,
        effectiveGleanMode: result.effectiveMode,
        overwriteBehavior: config.replySettings.overwriteBehavior,
        summary: `Drafted from ${payload.messages.length} visible message${payload.messages.length === 1 ? "" : "s"} using ${result.effectiveMode} mode.`,
        requestId,
        warnings: [],
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
      const friendlyMessage = isGleanAuthError(message) ? getGleanAuthErrorMessage() : message;
      const body: DraftErrorPayload = { error: friendlyMessage, requestId };
      res.status(isGleanAuthError(message) ? 401 : message.includes("timed out") ? 504 : 502).json(body);
    }
  });

  return app;
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
