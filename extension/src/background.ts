import type { BackgroundMessage, BackgroundResponse, ExtensionConfig } from "./types";
import { BACKEND_ENDPOINTS, DEFAULT_BACKEND_BASE_URL, type DraftResponsePayload } from "@gmail-glean-reply-drafter/shared";

type DraftEndpoint = typeof BACKEND_ENDPOINTS.emailReply | typeof BACKEND_ENDPOINTS.newEmail | typeof BACKEND_ENDPOINTS.slackReply | typeof BACKEND_ENDPOINTS.webResponse;

const DEFAULT_CONFIG: ExtensionConfig = {
  backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["backendBaseUrl"]);
  if (!existing.backendBaseUrl) {
    await chrome.storage.local.set(DEFAULT_CONFIG);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "draft-reply" || !tab?.id || !isSupportedDraftUrl(tab.url)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "DRAFT_REPLY_COMMAND" });
  } catch (error) {
    console.info("draft_command_content_script_unavailable", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type !== "REQUEST_DRAFT" && message.type !== "REQUEST_NEW_EMAIL_DRAFT" && message.type !== "REQUEST_SLACK_DRAFT" && message.type !== "REQUEST_WEB_DRAFT") {
    return false;
  }

  requestDraft(message.payload, getDraftEndpoint(message.type)).then(sendResponse);
  return true;
});

async function requestDraft(payload: BackgroundMessage["payload"], endpoint: DraftEndpoint): Promise<BackgroundResponse> {
  const config = await getConfig();
  const baseUrl = config.backendBaseUrl.replace(/\/$/, "");

  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.backendSecret ? { "x-backend-secret": config.backendSecret } : {}),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    const data = parseBackendJson(responseText);
    if (!res.ok) {
      if (res.status === 404) {
        return { ok: false, error: "Helper update required: quit the currently running helper, install the latest DMG in Applications, reopen it, then pair and refresh the extension." };
      }
      const backendError = data && typeof data.error === "string" ? data.error : `Backend returned ${res.status}`;
      return { ok: false, error: toFriendlyBackendError(backendError, res.status) };
    }

    if (!data || typeof data.draft !== "string") {
      return { ok: false, error: "Helper update required: the running helper returned an incompatible response. Install and reopen the latest DMG, then refresh the extension." };
    }

    return { ok: true, data: data as unknown as DraftResponsePayload };
  } catch (error) {
    return {
      ok: false,
      error: "Helper not reachable: open Glean Response Helper and click Restart helper. If needed, quit and reopen the helper app.",
    };
  }
}

function parseBackendJson(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function getDraftEndpoint(type: BackgroundMessage["type"]) {
  if (type === "REQUEST_NEW_EMAIL_DRAFT") return BACKEND_ENDPOINTS.newEmail;
  if (type === "REQUEST_SLACK_DRAFT") return BACKEND_ENDPOINTS.slackReply;
  if (type === "REQUEST_WEB_DRAFT") return BACKEND_ENDPOINTS.webResponse;
  return BACKEND_ENDPOINTS.emailReply;
}

function isSupportedDraftUrl(url: string | undefined) {
  return Boolean(url && /^https?:\/\//.test(url));
}

async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(["backendBaseUrl", "backendSecret"]);
  const config: ExtensionConfig = {
    backendBaseUrl: String(stored.backendBaseUrl || DEFAULT_CONFIG.backendBaseUrl),
  };
  if (typeof stored.backendSecret === "string" && stored.backendSecret) {
    config.backendSecret = stored.backendSecret;
  }
  return config;
}

function toFriendlyBackendError(error: string, status: number) {
  const text = error.toLowerCase();
  if (status === 429) return "Too many requests: Wait about a minute, then try again. If this keeps happening, close extra Gmail tabs using the extension.";
  if (text.includes("timed out") || text.includes("timeout")) return "Glean took too long: Open Glean Response Helper, increase Timeout, then try again. Scheduling and calendar checks can take longer.";
  if (text.includes("glean token") || text.includes("token problem") || text.includes("please authenticate") || text.includes("glean chat 401") || text.includes("glean chat 403")) return "Glean token problem: Open Glean Response Helper, paste a fresh Client API token with CHAT and SEARCH scopes. Click Save, then Test Glean.";
  if (text.includes("not paired") || text.includes("pair extension") || text.includes("backend secret") || text.includes("extension is not paired")) return "Pairing needed: Open Glean Response Helper, install or refresh the extension, click Pair extension, then reload the page.";
  if (status === 401) return "Authentication problem: Open Glean Response Helper and click Test Glean. If it passes, click Pair extension. If it fails, replace your token.";
  if (status === 403 || text.includes("forbidden")) return "Access problem: Check your Glean token scopes and helper setup. For calendar drafts, confirm a calendar/free-busy action is enabled in Glean.";
  if (text.includes("bad request") || text.includes("400")) return "Glean rejected the request: Try a shorter instruction, or switch Response mode to Auto in Glean Response Helper.";
  if (text.includes("empty draft") || text.includes("no draft returned")) return "Glean did not return a final draft: Try again with a clearer instruction. For calendar requests, confirm your Glean tenant has a calendar/free-busy action enabled.";
  return error;
}
