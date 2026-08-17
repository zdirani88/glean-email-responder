import type { ExtensionConfig } from "./types";

const backendBaseUrl = document.querySelector<HTMLInputElement>("#backendBaseUrl");
const backendSecret = document.querySelector<HTMLInputElement>("#backendSecret");
const statusEl = document.querySelector<HTMLElement>("#status");

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";

void restore();

document.querySelector<HTMLButtonElement>("#save")?.addEventListener("click", async () => {
  await chrome.storage.local.set({
    backendBaseUrl: backendBaseUrl?.value.trim() || DEFAULT_BACKEND_URL,
    backendSecret: backendSecret?.value.trim() || "",
  });

  if (statusEl) statusEl.textContent = "Saved.";
});

async function restore() {
  const paired = readPairingPayload();
  if (paired) {
    await chrome.storage.local.set(paired);
    history.replaceState(null, "", location.pathname);
    await confirmPairing(paired);
  }

  const stored = await chrome.storage.local.get(["backendBaseUrl", "backendSecret"]);
  if (backendBaseUrl) backendBaseUrl.value = String(stored.backendBaseUrl || DEFAULT_BACKEND_URL);
  if (backendSecret) backendSecret.value = String(stored.backendSecret || "");
}

function readPairingPayload(): ExtensionConfig | undefined {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const encoded = params.get("pair");
  if (!encoded) return undefined;

  try {
    const parsed = JSON.parse(atob(toBase64(encoded))) as Partial<ExtensionConfig>;
    if (typeof parsed.backendBaseUrl !== "string" || typeof parsed.backendSecret !== "string") {
      return undefined;
    }

    const backendBaseUrl = parsed.backendBaseUrl.trim();
    const backendSecret = parsed.backendSecret.trim();
    if (!backendBaseUrl.startsWith("http://127.0.0.1:") || !backendSecret) {
      return undefined;
    }

    return { backendBaseUrl, backendSecret };
  } catch {
    if (statusEl) statusEl.textContent = "Pairing link was invalid.";
    return undefined;
  }
}

async function confirmPairing(config: ExtensionConfig) {
  try {
    const res = await fetch(`${config.backendBaseUrl.replace(/\/$/, "")}/pairing-confirmed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-backend-secret": config.backendSecret || "",
      },
      body: JSON.stringify({
        source: "extension-options",
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    });

    if (!res.ok) {
      if (statusEl) statusEl.textContent = "Saved locally, but helper rejected the pairing. Open Glean Response Helper and click Pair extension again.";
      return;
    }

    if (statusEl) statusEl.textContent = "Paired with Glean Response Helper. Reload the page before drafting.";
  } catch {
    if (statusEl) statusEl.textContent = "Saved locally, but could not reach helper to confirm pairing. Start Glean Response Helper, then click Pair extension again.";
  }
}

function toBase64(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
}
