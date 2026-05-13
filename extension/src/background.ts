import type { BackgroundMessage, BackgroundResponse, ExtensionConfig } from "./types";

const DEFAULT_CONFIG: ExtensionConfig = {
  backendBaseUrl: "http://127.0.0.1:8787",
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["backendBaseUrl"]);
  if (!existing.backendBaseUrl) {
    await chrome.storage.local.set(DEFAULT_CONFIG);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "draft-reply" || !tab?.id || !tab.url?.startsWith("https://mail.google.com/")) {
    return;
  }

  await chrome.tabs.sendMessage(tab.id, { type: "DRAFT_REPLY_COMMAND" });
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type !== "REQUEST_DRAFT") {
    return false;
  }

  requestDraft(message.payload).then(sendResponse);
  return true;
});

async function requestDraft(payload: BackgroundMessage["payload"]): Promise<BackgroundResponse> {
  const config = await getConfig();
  const baseUrl = config.backendBaseUrl.replace(/\/$/, "");

  try {
    const res = await fetch(`${baseUrl}/draft-email-reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.backendSecret ? { "x-backend-secret": config.backendSecret } : {}),
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          error: "Pairing needed: open Gmail Glean Helper, click Pair extension, then reload Gmail and try again.",
        };
      }
      return { ok: false, error: toFriendlyBackendError(data.error ?? `Backend returned ${res.status}`, res.status) };
    }

    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: "Helper not reachable: open Gmail Glean Helper and click Restart server. If needed, quit and reopen the helper app.",
    };
  }
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
  if (status === 429) return "Too many requests: wait a moment, then try again.";
  if (text.includes("timed out")) return "Glean took too long: open Gmail Glean Helper, increase Timeout, then try again.";
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("authenticate") || text.includes("token problem")) return "Glean token problem: open Gmail Glean Helper, paste a fresh Client API token with CHAT and SEARCH scopes, click Save and start, then try again.";
  if (text.includes("bad request") || text.includes("400")) return "Glean rejected the request: try again, or switch Response mode to Auto in Gmail Glean Helper.";
  if (text.includes("empty draft")) return "Glean did not return a final draft. Try again with a short guidance note.";
  return error;
}
