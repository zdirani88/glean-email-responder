import type { AppConfig } from "./config.js";

interface GleanChatMessage {
  author?: string;
  fragments?: Array<{ text?: string }>;
  content?: string;
}

interface GleanChatResponse {
  messages?: GleanChatMessage[];
  followUpResults?: GleanChatMessage[];
}

export async function draftWithGlean(prompt: string, config: AppConfig): Promise<string> {
  if (config.gleanStubMode) {
    return [
      "Hi,",
      "",
      "Thanks for the context. This is a stub draft from the local backend while Glean integration is disabled.",
      "",
      "Best,",
    ].join("\n");
  }

  if (!config.gleanServerUrl || !config.gleanApiToken) {
    throw new Error("Glean is not configured. Set GLEAN_SERVER_URL and GLEAN_API_TOKEN, or enable GLEAN_STUB_MODE.");
  }

  const chatUrl = `${config.gleanServerUrl.replace(/\/$/, "")}/rest/api/v1/chat`;
  const res = await fetchWithTimeout(
    chatUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gleanApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ author: "USER", fragments: [{ text: prompt }] }],
        stream: false,
      }),
    },
    config.gleanTimeoutMs
  );

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`Glean chat ${res.status}: ${body}`);
  }

  const data = (await res.json()) as GleanChatResponse;
  const responseMessages = data.messages ?? data.followUpResults ?? [];
  const assistantDrafts = responseMessages
    .filter((message) => message.author === "GLEAN_AI" || message.author === "ASSISTANT")
    .map(getMessageText)
    .map((text) => text.trim())
    .filter(Boolean)
    .filter((text) => !isProgressMessage(text));

  const draft = assistantDrafts.at(-1) ?? getMessageText(responseMessages.at(-1)).trim();

  if (!draft.trim()) {
    throw new Error("Glean returned an empty draft.");
  }

  return draft.trim();
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
  return message?.fragments?.map((fragment) => fragment.text ?? "").join("") ?? message?.content ?? "";
}

function isProgressMessage(text: string) {
  const normalized = text.replace(/[*_`]/g, "").trim().toLowerCase();
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
