import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { DraftErrorPayload, DraftResponsePayload } from "@gmail-glean-reply-drafter/shared";
import type { AppConfig } from "./config.js";
import { draftWithGlean, testGleanConnection } from "./gleanClient.js";
import { buildReplyPrompt } from "./prompt.js";
import { draftRequestSchema } from "./schema.js";

export function createBackendApp(config: AppConfig) {
  const app = express();

  const allowedOrigins = [/^chrome-extension:\/\//, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

  app.use(
    cors({
      origin: allowedOrigins,
    })
  );
  app.use(express.json({ limit: "256kb" }));
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (!origin || allowedOrigins.some((pattern) => pattern.test(origin))) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden origin." });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      gleanConfigured: Boolean(config.gleanStubMode || (config.gleanServerUrl && config.gleanApiToken)),
      stubMode: config.gleanStubMode,
    });
  });

  app.post("/test-glean-connection", async (req, res) => {
    const testConfig = {
      ...config,
      gleanServerUrl: req.body?.gleanServerUrl || config.gleanServerUrl,
      gleanApiToken: req.body?.gleanApiToken || config.gleanApiToken,
    };

    try {
      await testGleanConnection(testConfig);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach Glean.";
      res.status(message.includes("401") || message.includes("403") ? 401 : 502).json({ error: message });
    }
  });

  app.post("/draft-email-reply", async (req, res) => {
    const startedAt = Date.now();
    const requestId = req.body?.clientRequestId || crypto.randomUUID();

    if (config.sharedSecret) {
      const suppliedSecret = req.header("x-backend-secret");
      if (!suppliedSecret || !secureStringEquals(suppliedSecret, config.sharedSecret)) {
        const body: DraftErrorPayload = { error: "Unauthorized.", requestId };
        res.status(401).json(body);
        return;
      }
    }

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
      const prompt = buildReplyPrompt(payload);
      const draft = await draftWithGlean(prompt, config);
      const response: DraftResponsePayload = {
        draft,
        summary: `Drafted from ${payload.messages.length} visible message${payload.messages.length === 1 ? "" : "s"}.`,
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
      const body: DraftErrorPayload = { error: message, requestId };
      res.status(message.includes("timed out") ? 504 : 502).json(body);
    }
  });

  return app;
}

function secureStringEquals(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}
