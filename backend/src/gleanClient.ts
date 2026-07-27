import type { DraftTokenUsage, DraftVariant, EffectiveGleanMode } from "@gmail-glean-reply-drafter/shared";
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
  usage?: unknown;
  tokenUsage?: unknown;
  usageMetadata?: unknown;
  metadata?: {
    usage?: unknown;
    tokenUsage?: unknown;
  };
  responseMetadata?: {
    usage?: unknown;
    tokenUsage?: unknown;
  };
}

interface TokenUsageFallbacks {
  modelName?: string;
  provider?: string;
  isGleanHostedModel?: boolean;
}

interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface GleanDraftResult {
  draft: string;
  variants: DraftVariant[];
  effectiveMode: EffectiveGleanMode;
  tokenUsage: DraftTokenUsage;
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
    return { draft, variants: [{ draft, label: "Draft 1" }], effectiveMode, tokenUsage: estimateTokenUsage(prompt, draft) };
  }

  if (!config.gleanServerUrl || !config.gleanApiToken) {
    throw new Error("Glean is not configured. Set GLEAN_SERVER_URL and GLEAN_API_TOKEN, or enable GLEAN_STUB_MODE.");
  }

  const chatUrl = `${config.gleanServerUrl.replace(/\/$/, "")}/rest/api/v1/chat`;
  const data = await sendChatRequest(chatUrl, prompt, config, effectiveMode);

  const responseMessages = [...(data.messages ?? []), ...(data.followUpResults ?? [])];
  const nonUserMessages = responseMessages.filter((message) => message.author?.trim().toUpperCase() !== "USER");
  const assistantDrafts = uniqueResponseTexts(nonUserMessages
    .filter(isAssistantMessage)
    .filter(isContentMessage)
    .map(getMessageText)
    .map((text) => text.trim())
    .filter(Boolean)
    .filter((text) => !isProgressMessage(text)));

  const fallbackDrafts = uniqueResponseTexts(nonUserMessages
    .filter(isContentMessage)
    .map(getMessageText)
    .map((text) => text.trim())
    .filter(Boolean)
    .filter((text) => !isProgressMessage(text)));
  const cleanedDrafts = (assistantDrafts.length ? assistantDrafts : fallbackDrafts)
    .flatMap(splitDraftOptions)
    .map(cleanDraft)
    .filter(Boolean);
  const variants = toDraftVariants(cleanedDrafts);
  const draft = variants.at(0)?.draft ?? "";

  if (!draft.trim()) {
    throw new Error("Glean returned an empty draft.");
  }

  return { draft, variants, effectiveMode, tokenUsage: extractTokenUsage(data) ?? estimateTokenUsage(prompt, draft) };
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

function isAssistantMessage(message: GleanChatMessage) {
  const author = message.author?.trim().toUpperCase();
  return author === "GLEAN_AI" || author === "ASSISTANT";
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

function uniqueResponseTexts(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function splitDraftOptions(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  const markerPattern = /(?:^|\n)\s*(?:\*\*)?(?:draft|option|version|reply)\s*(?:#?\d+|[A-C])(?:\s*[-,]\s*[^:\n]+)?\s*[:.)-]\s*(?:\*\*)?/gi;
  const markers = Array.from(normalized.matchAll(markerPattern));
  if (markers.length < 2) return [value];

  return markers
    .map((marker, index) => {
      const start = marker.index ?? 0;
      const end = markers[index + 1]?.index ?? normalized.length;
      return normalized.slice(start, end).replace(marker[0], "").trim();
    })
    .filter(Boolean);
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

function extractTokenUsage(response: GleanChatResponse): DraftTokenUsage | undefined {
  const fallbacks: TokenUsageFallbacks = {
    ...extractModelMetadata(response),
  };
  const candidates = [
    response.usage,
    response.tokenUsage,
    response.usageMetadata,
    response.metadata?.usage,
    response.metadata?.tokenUsage,
    response.responseMetadata?.usage,
    response.responseMetadata?.tokenUsage,
    ...collectTokenUsageCandidates(response),
  ];

  const usages: DraftTokenUsage[] = [];
  for (const candidate of candidates) {
    const usage = normalizeTokenUsage(candidate, fallbacks);
    if (usage) usages.push(usage);
  }

  return usages
    .sort((a, b) => scoreTokenUsage(b) - scoreTokenUsage(a))
    .at(0);
}

function normalizeTokenUsage(value: unknown, fallbacks: TokenUsageFallbacks = {}): DraftTokenUsage | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = readNumberField(value, [
    "inputTokens",
    "input_tokens",
    "inputTokenCount",
    "input_token_count",
    "promptTokens",
    "prompt_tokens",
    "promptTokenCount",
    "prompt_token_count",
    "requestTokens",
    "request_tokens",
    "tokensIn",
    "tokens_in",
  ]);
  const outputTokens = readNumberField(value, [
    "outputTokens",
    "output_tokens",
    "outputTokenCount",
    "output_token_count",
    "completionTokens",
    "completion_tokens",
    "completionTokenCount",
    "completion_token_count",
    "generatedTokens",
    "generated_tokens",
    "responseTokens",
    "response_tokens",
    "tokensOut",
    "tokens_out",
  ]);
  const suppliedTotalTokens = readNumberField(value, ["totalTokens", "total_tokens", "totalTokenCount", "total_token_count", "tokens", "tokenCount", "token_count"]);
  const totalTokens = suppliedTotalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cacheCreationInputTokens = readNumberField(value, [
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
    "cachedInputCreationTokens",
    "cached_input_creation_tokens",
  ]);
  const cacheReadInputTokens = readNumberField(value, [
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheHitInputTokens",
    "cache_hit_input_tokens",
  ]);
  const estimatedCostUsd = readNumberField(value, ["estimatedCostUsd", "estimated_cost_usd", "costUsd", "cost_usd", "totalCostUsd", "total_cost_usd"]);
  const modelName = readStringField(value, ["model", "modelName", "model_name", "llmModel", "llm_model", "modelId", "model_id", "deploymentModel"]) ?? fallbacks.modelName;
  const provider = readStringField(value, ["provider", "modelProvider", "model_provider", "llmProvider", "llm_provider", "vendor"]) ?? fallbacks.provider;
  const isGleanHostedModel = readBooleanField(value, ["isGleanHostedModel", "is_glean_hosted_model", "gleanHostedModel", "glean_hosted_model"]) ?? fallbacks.isGleanHostedModel;

  if (inputTokens === null && outputTokens === null && totalTokens === null && estimatedCostUsd === null && !modelName && !provider) {
    return undefined;
  }
  const vendorCost = estimatedCostUsd === null ? estimateVendorListPriceCost(modelName, inputTokens, outputTokens) : null;
  const resolvedCost = estimatedCostUsd ?? vendorCost;
  const estimatedCostSource = estimatedCostUsd !== null ? "glean" : vendorCost !== null ? "vendor-list-price" : "unavailable";

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== null ? { cacheReadInputTokens } : {}),
    ...(modelName ? { modelName } : {}),
    ...(provider ? { provider } : {}),
    ...(typeof isGleanHostedModel === "boolean" ? { isGleanHostedModel } : {}),
    estimatedCostUsd: resolvedCost,
    estimatedCostSource,
    source: "glean",
    note: formatGleanUsageNote(estimatedCostSource, modelName),
  };
}

function estimateTokenUsage(prompt: string, draft: string): DraftTokenUsage {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(draft.length / 4);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: null,
    estimatedCostSource: "unavailable",
    source: "estimated",
    note: "Glean did not return model or token usage metadata, so this token count is an approximate text-length estimate and cost is unavailable.",
  };
}

function collectTokenUsageCandidates(value: unknown, depth = 0, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (depth > 8 || !isRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const candidates: Record<string, unknown>[] = [];
  if (looksLikeUsageRecord(value)) candidates.push(value);

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    if (isRecord(child)) {
      if (normalizedKey.includes("usage") || normalizedKey.includes("token") || normalizedKey.includes("llm") || normalizedKey.includes("model")) {
        candidates.push(child);
      }
      candidates.push(...collectTokenUsageCandidates(child, depth + 1, seen));
      continue;
    }

    if (Array.isArray(child)) {
      for (const item of child) {
        candidates.push(...collectTokenUsageCandidates(item, depth + 1, seen));
      }
    }
  }

  return candidates;
}

function looksLikeUsageRecord(record: Record<string, unknown>) {
  return Object.keys(record)
    .map(normalizeKey)
    .some((key) => key.includes("token") || key.includes("cost") || key === "model" || key.includes("modelname") || key.includes("provider"));
}

function extractModelMetadata(value: unknown): TokenUsageFallbacks {
  const records = collectTokenUsageCandidates(value);
  for (const record of records) {
    const modelName = readStringField(record, ["model", "modelName", "model_name", "llmModel", "llm_model", "modelId", "model_id", "deploymentModel"]);
    const provider = readStringField(record, ["provider", "modelProvider", "model_provider", "llmProvider", "llm_provider", "vendor"]);
    const isGleanHostedModel = readBooleanField(record, ["isGleanHostedModel", "is_glean_hosted_model", "gleanHostedModel", "glean_hosted_model"]);
    if (modelName || provider || typeof isGleanHostedModel === "boolean") {
      return {
        ...(modelName ? { modelName } : {}),
        ...(provider ? { provider } : {}),
        ...(typeof isGleanHostedModel === "boolean" ? { isGleanHostedModel } : {}),
      };
    }
  }

  return {};
}

function scoreTokenUsage(usage: DraftTokenUsage) {
  return [
    usage.inputTokens !== null ? 4 : 0,
    usage.outputTokens !== null ? 4 : 0,
    usage.totalTokens !== null ? 2 : 0,
    usage.estimatedCostUsd !== null ? 2 : 0,
    usage.modelName ? 2 : 0,
    usage.provider ? 1 : 0,
  ].reduce((total, score) => total + score, 0);
}

function formatGleanUsageNote(costSource: DraftTokenUsage["estimatedCostSource"], modelName: string | undefined) {
  if (costSource === "glean") return "Glean returned token usage and cost metadata.";
  if (costSource === "vendor-list-price") {
    return `Glean returned usage${modelName ? ` for ${modelName}` : ""}; cost is estimated from public vendor list pricing and may not match Glean billing.`;
  }
  return "Glean returned usage metadata without cost metadata. Cost is unavailable unless Glean exposes cost or a known model is detected.";
}

function estimateVendorListPriceCost(modelName: string | undefined, inputTokens: number | null, outputTokens: number | null) {
  if (!modelName || inputTokens === null || outputTokens === null) return null;
  const price = findModelPrice(modelName);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputUsdPerMillion + (outputTokens / 1_000_000) * price.outputUsdPerMillion;
}

function findModelPrice(modelName: string): ModelPrice | undefined {
  const normalized = normalizeModelName(modelName);
  const entries: Array<[RegExp, ModelPrice]> = [
    [/gpt[-_ ]?4\.1[-_ ]?nano/, { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 }],
    [/gpt[-_ ]?4\.1[-_ ]?mini/, { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 }],
    [/gpt[-_ ]?4\.1(?![-_ ]?(mini|nano))/, { inputUsdPerMillion: 2, outputUsdPerMillion: 8 }],
    [/gpt[-_ ]?4o[-_ ]?mini/, { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 }],
    [/gpt[-_ ]?4o(?![-_ ]?mini)/, { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 }],
    [/o4[-_ ]?mini|o3[-_ ]?mini/, { inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 }],
    [/claude[-_ ]?(sonnet[-_ ]?)?4|claude[-_ ]?3\.7[-_ ]?sonnet|claude[-_ ]?3(\.5|[-_ ]?5)?[-_ ]?sonnet|claude[-_ ]?sonnet[-_ ]?(4|3\.7|3(\.5|[-_ ]?5)?)/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
    [/claude[-_ ]?3\.5[-_ ]?haiku|claude[-_ ]?haiku[-_ ]?3\.5/, { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 }],
    [/claude[-_ ]?3[-_ ]?haiku/, { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.25 }],
    [/claude[-_ ]?(opus[-_ ]?)?4(\.1)?|claude[-_ ]?3[-_ ]?opus|claude[-_ ]?opus[-_ ]?(4(\.1)?|3)/, { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
  ];
  return entries.find(([pattern]) => pattern.test(normalized))?.[1];
}

function normalizeModelName(value: string) {
  return value.trim().toLowerCase();
}

function readNumberField(record: Record<string, unknown>, fieldNames: string[]) {
  for (const fieldName of fieldNames) {
    const normalized = normalizeNumber(record[fieldName]);
    if (normalized !== null) return normalized;
  }

  return null;
}

function readStringField(record: Record<string, unknown>, fieldNames: string[]) {
  for (const fieldName of fieldNames) {
    const direct = normalizeString(record[fieldName]);
    if (direct) return direct;
    const normalizedFieldName = normalizeKey(fieldName);
    for (const [key, value] of Object.entries(record)) {
      if (normalizeKey(key) === normalizedFieldName) {
        const normalized = normalizeString(value);
        if (normalized) return normalized;
      }
    }
  }

  return undefined;
}

function readBooleanField(record: Record<string, unknown>, fieldNames: string[]) {
  for (const fieldName of fieldNames) {
    const direct = normalizeBoolean(record[fieldName]);
    if (direct !== null) return direct;
    const normalizedFieldName = normalizeKey(fieldName);
    for (const [key, value] of Object.entries(record)) {
      if (normalizeKey(key) === normalizedFieldName) {
        const normalized = normalizeBoolean(value);
        if (normalized !== null) return normalized;
      }
    }
  }

  return undefined;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return null;
}

function normalizeKey(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
