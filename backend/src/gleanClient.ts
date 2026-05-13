import type { DraftVariant, EffectiveGleanMode } from "@gmail-glean-reply-drafter/shared";
import type { AppConfig } from "./config.js";

interface GleanChatMessage {
  author?: string;
  fragments?: Array<{ text?: string; messageType?: string; type?: string }>;
  content?: string;
  messageType?: string;
  type?: string;
}

interface GleanChatResponse {
  messages?: GleanChatMessage[];
  followUpResults?: GleanChatMessage[];
}

export interface GleanDraftResult {
  draft: string;
  variants: DraftVariant[];
  effectiveMode: EffectiveGleanMode;
}

export async function draftWithGlean(prompt: string, config: AppConfig, requestStats: { messageCount: number; totalBodyChars: number; userInstructionChars: number; schedulingIntent?: boolean }): Promise<GleanDraftResult> {
  const effectiveMode = resolveEffectiveMode(config, requestStats);
  if (config.gleanStubMode) {
    const draft = [
      "Hi,",
      "",
      "Thanks for the context. This is a stub draft from the local backend while Glean integration is disabled.",
      "",
      "Best,",
    ].join("\n");
    return { draft, variants: [{ draft, label: "Draft 1" }], effectiveMode };
  }

  if (!config.gleanServerUrl || !config.gleanApiToken) {
    throw new Error("Glean is not configured. Set GLEAN_SERVER_URL and GLEAN_API_TOKEN, or enable GLEAN_STUB_MODE.");
  }

  const chatUrl = `${config.gleanServerUrl.replace(/\/$/, "")}/rest/api/v1/chat`;
  const data = await sendChatRequest(chatUrl, prompt, config, effectiveMode);

  const responseMessages = data.messages ?? data.followUpResults ?? [];
  const assistantDrafts = responseMessages
    .filter((message) => message.author === "GLEAN_AI" || message.author === "ASSISTANT")
    .filter(isContentMessage)
    .map(getMessageText)
    .map((text) => text.trim())
    .filter(Boolean)
    .filter((text) => !isProgressMessage(text));

  const fallbackDrafts = responseMessages
    .filter(isContentMessage)
    .map(getMessageText)
    .map((text) => text.trim())
    .filter(Boolean)
    .filter((text) => !isProgressMessage(text));
  const cleanedDrafts = (assistantDrafts.length ? assistantDrafts : fallbackDrafts)
    .map(cleanDraft)
    .filter(Boolean);
  const variants = toDraftVariants(cleanedDrafts);
  const draft = variants.at(-1)?.draft ?? variants.at(0)?.draft ?? "";

  if (!draft.trim()) {
    throw new Error("Glean returned an empty draft.");
  }

  return { draft, variants, effectiveMode };
}

async function sendChatRequest(chatUrl: string, prompt: string, config: AppConfig, effectiveMode: EffectiveGleanMode) {
  const baseBody = {
    messages: [{ author: "USER", fragments: [{ text: prompt }] }],
    stream: false,
  };
  const withMode = {
    agentConfig: { mode: effectiveMode === "fast" ? "QUICK" : "DEFAULT" },
    ...baseBody,
  };

  const first = await postChat(chatUrl, config, withMode);
  if (first.ok) return (await first.json()) as GleanChatResponse;

  const firstBody = await readErrorBody(first);
  if (first.status !== 400) {
    throw new Error(`Glean chat ${first.status}: ${firstBody}`);
  }

  console.warn("glean_chat_mode_rejected_retrying_without_mode", {
    status: first.status,
    effectiveMode,
    error: firstBody.slice(0, 160),
  });

  const retry = await postChat(chatUrl, config, baseBody);
  if (!retry.ok) {
    const retryBody = await readErrorBody(retry);
    throw new Error(`Glean chat ${retry.status}: ${retryBody}`);
  }

  return (await retry.json()) as GleanChatResponse;
}

function postChat(chatUrl: string, config: AppConfig, body: unknown) {
  return fetchWithTimeout(
    chatUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gleanApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    config.gleanTimeoutMs
  );
}

export async function testGleanConnection(config: AppConfig): Promise<void> {
  if (config.gleanStubMode) {
    return;
  }

  if (!config.gleanServerUrl || !config.gleanApiToken) {
    throw new Error("Glean is not configured. Add a Glean server URL and Client API token.");
  }

  const searchUrl = `${config.gleanServerUrl.replace(/\/$/, "")}/rest/api/v1/search`;
  const res = await fetchWithTimeout(
    searchUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gleanApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "test", pageSize: 1 }),
    },
    config.gleanTimeoutMs
  );

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`Glean search ${res.status}: ${body}`);
  }
}

function getMessageText(message: GleanChatMessage | undefined) {
  if (!message) return "";
  const fragments = message.fragments ?? [];
  const contentFragments = fragments.filter(isContentFragment);
  if (contentFragments.length) {
    return contentFragments.map((fragment) => fragment.text ?? "").join("");
  }
  if (fragments.length && fragments.some(hasTypedFragment)) return "";
  return message.content ?? fragments.map((fragment) => fragment.text ?? "").join("");
}

function isContentMessage(message: GleanChatMessage) {
  const messageType = normalizeMessageType(message.messageType ?? message.type);
  return !messageType || messageType === "CONTENT";
}

function isContentFragment(fragment: { messageType?: string; type?: string }) {
  const messageType = normalizeMessageType(fragment.messageType ?? fragment.type);
  return !messageType || messageType === "CONTENT";
}

function hasTypedFragment(fragment: { messageType?: string; type?: string }) {
  return Boolean(fragment.messageType || fragment.type);
}

function normalizeMessageType(value: string | undefined) {
  return value?.trim().toUpperCase();
}

function isProgressMessage(text: string) {
  const normalized = text.replace(/[*_`]/g, "").trim().toLowerCase();
  if (normalized.startsWith("checking ") || normalized.startsWith("drafting ") || normalized.startsWith("thinking") || normalized.startsWith("working ")) return true;
  if (normalized.includes("thinking mode") || normalized.includes("working notes") || normalized.includes("draft option")) return true;
  return (
    normalized === "checking your writing style" ||
    normalized === "checking your writing style..." ||
    normalized === "drafting your reply" ||
    normalized === "drafting your reply..."
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request to Glean timed out. Please try again.");
    }

    throw error instanceof Error ? error : new Error("Unknown network error while reaching Glean.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(res: Response) {
  const text = await res.text();
  return text.slice(0, 500);
}

function resolveEffectiveMode(config: AppConfig, stats: { messageCount: number; totalBodyChars: number; userInstructionChars: number; schedulingIntent?: boolean }): EffectiveGleanMode {
  if (stats.schedulingIntent) return "thinking";
  if (config.replySettings.replyMode === "fast") return "fast";
  if (config.replySettings.replyMode === "thinking") return "thinking";

  if (stats.messageCount > 1 || stats.totalBodyChars > 1200 || stats.userInstructionChars > 220) {
    return "thinking";
  }

  return "fast";
}

function cleanDraft(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[—–]/g, ",")
    .replace(/^\s*(working notes?|analysis|reasoning|thinking|status update):[\s\S]*?(?=\n\n|$)/gim, "")
    .trim();
}

function toDraftVariants(values: string[]): DraftVariant[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map((draft, index) => ({ draft, label: "Draft " + (index + 1) }));
}
