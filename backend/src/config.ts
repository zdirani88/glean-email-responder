import "dotenv/config";
import { DEFAULT_REPLY_SETTINGS, type ReplySettings } from "@gmail-glean-reply-drafter/shared";

export interface AppConfig {
  port: number;
  host: string;
  sharedSecret?: string;
  gleanServerUrl?: string;
  gleanApiToken?: string;
  gleanTimeoutMs: number;
  gleanStubMode: boolean;
  replySettings: ReplySettings;
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST?.trim() || "127.0.0.1",
    gleanTimeoutMs: Number(process.env.GLEAN_TIMEOUT_MS ?? 15000),
    gleanStubMode: (process.env.GLEAN_STUB_MODE ?? "false").toLowerCase() === "true",
    replySettings: { ...DEFAULT_REPLY_SETTINGS },
  };

  const sharedSecret = process.env.BACKEND_SHARED_SECRET?.trim();
  const gleanServerUrl = process.env.GLEAN_SERVER_URL?.trim();
  const gleanApiToken = process.env.GLEAN_API_TOKEN?.trim();

  if (sharedSecret) config.sharedSecret = sharedSecret;
  if (gleanServerUrl) config.gleanServerUrl = gleanServerUrl;
  if (gleanApiToken) config.gleanApiToken = gleanApiToken;

  config.replySettings = {
    ...config.replySettings,
    replyMode: parseSetting(process.env.REPLY_MODE, ["auto", "fast", "thinking"], config.replySettings.replyMode),
    defaultTone: parseSetting(process.env.REPLY_TONE, ["concise", "warm", "formal", "direct"], config.replySettings.defaultTone),
    defaultLength: parseSetting(process.env.REPLY_LENGTH, ["short", "medium", "detailed"], config.replySettings.defaultLength),
    overwriteBehavior: parseSetting(process.env.OVERWRITE_BEHAVIOR, ["replace", "append"], config.replySettings.overwriteBehavior),
    contextDepth: parseSetting(process.env.CONTEXT_DEPTH, ["latest", "visibleThread"], config.replySettings.contextDepth),
  };

  return config;
}

function parseSetting<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const normalized = value?.trim();
  return allowed.includes(normalized as T) ? (normalized as T) : fallback;
}
