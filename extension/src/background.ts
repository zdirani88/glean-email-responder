import type { BackgroundMessage, BackgroundResponse, ExtensionConfig } from "./types";

const DEFAULT_CONFIG: ExtensionConfig = {
  backendBaseUrl: "http://localhost:8787",
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(["backendBaseUrl"]);
  if (!existing.backendBaseUrl) {
    await chrome.storage.sync.set(DEFAULT_CONFIG);
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
      return { ok: false, error: data.error ?? `Backend returned ${res.status}` };
    }

    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach backend.",
    };
  }
}

async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.sync.get(["backendBaseUrl", "backendSecret"]);
  const config: ExtensionConfig = {
    backendBaseUrl: String(stored.backendBaseUrl || DEFAULT_CONFIG.backendBaseUrl),
  };
  if (typeof stored.backendSecret === "string" && stored.backendSecret) {
    config.backendSecret = stored.backendSecret;
  }
  return config;
}
