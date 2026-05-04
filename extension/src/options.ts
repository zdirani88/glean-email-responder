const backendBaseUrl = document.querySelector<HTMLInputElement>("#backendBaseUrl");
const backendSecret = document.querySelector<HTMLInputElement>("#backendSecret");
const statusEl = document.querySelector<HTMLElement>("#status");

void restore();

document.querySelector<HTMLButtonElement>("#save")?.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    backendBaseUrl: backendBaseUrl?.value.trim() || "http://localhost:8787",
    backendSecret: backendSecret?.value.trim() || "",
  });

  if (statusEl) statusEl.textContent = "Saved.";
});

async function restore() {
  const stored = await chrome.storage.sync.get(["backendBaseUrl", "backendSecret"]);
  if (backendBaseUrl) backendBaseUrl.value = String(stored.backendBaseUrl || "http://localhost:8787");
  if (backendSecret) backendSecret.value = String(stored.backendSecret || "");
}
