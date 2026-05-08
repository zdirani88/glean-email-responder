type ReplyMode = "auto" | "fast" | "thinking";
type ReplyTone = "concise" | "warm" | "formal" | "direct";
type ReplyLength = "short" | "medium" | "detailed";
type OverwriteBehavior = "replace" | "append";
type ContextDepth = "latest" | "visibleThread";

interface ReplySettings {
  replyMode: ReplyMode;
  defaultTone: ReplyTone;
  defaultLength: ReplyLength;
  overwriteBehavior: OverwriteBehavior;
  contextDepth: ContextDepth;
}

interface HelperStatus {
  running: boolean;
  port: number;
  gleanServerUrl: string;
  gleanTimeoutMs: number;
  replySettings: ReplySettings;
  hasToken: boolean;
  hasLocalSecret: boolean;
  launchAtLogin: boolean;
  extensionPath: string;
  extensionId: string;
  serverError?: string;
}

interface HelperApi {
  getStatus(): Promise<HelperStatus>;
  saveConfig(input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs: number; replySettings: ReplySettings }): Promise<HelperStatus>;
  testGlean(input: { gleanServerUrl: string; token?: string }): Promise<{ ok: true }>;
  restartServer(): Promise<HelperStatus>;
  openUrl(url: string): Promise<void>;
  openExtensionFolder(): Promise<void>;
  pairExtension(): Promise<void>;
  copyPairingLink(): Promise<void>;
  clearGleanToken(): Promise<HelperStatus>;
  rotateLocalSecret(): Promise<HelperStatus>;
}

declare global {
  interface Window {
    gmailGleanHelper: HelperApi;
  }
}

const serverUrl = document.querySelector<HTMLInputElement>("#serverUrl");
const token = document.querySelector<HTMLInputElement>("#token");
const launchAtLogin = document.querySelector<HTMLInputElement>("#launchAtLogin");
const replyMode = document.querySelector<HTMLSelectElement>("#replyMode");
const defaultTone = document.querySelector<HTMLSelectElement>("#defaultTone");
const defaultLength = document.querySelector<HTMLSelectElement>("#defaultLength");
const overwriteBehavior = document.querySelector<HTMLSelectElement>("#overwriteBehavior");
const contextDepth = document.querySelector<HTMLSelectElement>("#contextDepth");
const gleanTimeoutMs = document.querySelector<HTMLSelectElement>("#gleanTimeoutMs");
const statusDot = document.querySelector<HTMLElement>("#statusDot");
const statusText = document.querySelector<HTMLElement>("#statusText");
const tokenState = document.querySelector<HTMLElement>("#tokenState");
const saveButton = document.querySelector<HTMLButtonElement>("#save");
const testButton = document.querySelector<HTMLButtonElement>("#test");
const restartButton = document.querySelector<HTMLButtonElement>("#restart");
const openExtensionsButton = document.querySelector<HTMLButtonElement>("#openExtensions");
const openShortcutsButton = document.querySelector<HTMLButtonElement>("#openShortcuts");
const openExtensionFolderButton = document.querySelector<HTMLButtonElement>("#openExtensionFolder");
const pairExtensionButton = document.querySelector<HTMLButtonElement>("#pairExtension");
const copyPairingLinkButton = document.querySelector<HTMLButtonElement>("#copyPairingLink");
const clearTokenButton = document.querySelector<HTMLButtonElement>("#clearToken");
const rotateSecretButton = document.querySelector<HTMLButtonElement>("#rotateSecret");
const extensionPath = document.querySelector<HTMLElement>("#extensionPath");
const extensionId = document.querySelector<HTMLElement>("#extensionId");
const message = document.querySelector<HTMLElement>("#message");

void refreshStatus();

saveButton?.addEventListener("click", async () => {
  await runAction("Settings saved. Local server restarted.", async () => {
    const input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs: number; replySettings: ReplySettings } = {
      gleanServerUrl: serverUrl?.value ?? "",
      launchAtLogin: Boolean(launchAtLogin?.checked),
      gleanTimeoutMs: Number(gleanTimeoutMs?.value || 45000),
      replySettings: readReplySettings(),
    };
    if (token?.value) input.token = token.value;

    const status = await window.gmailGleanHelper.saveConfig(input);
    if (token) token.value = "";
    renderStatus(status);
  });
});

testButton?.addEventListener("click", async () => {
  await runAction("Glean connection works.", async () => {
    const input: { gleanServerUrl: string; token?: string } = {
      gleanServerUrl: serverUrl?.value ?? "",
    };
    if (token?.value) input.token = token.value;
    await window.gmailGleanHelper.testGlean(input);
  });
});

restartButton?.addEventListener("click", async () => {
  await runAction("Local server restarted.", async () => {
    renderStatus(await window.gmailGleanHelper.restartServer());
  });
});

openExtensionsButton?.addEventListener("click", () => {
  void window.gmailGleanHelper.openUrl("chrome://extensions");
});

openExtensionFolderButton?.addEventListener("click", async () => {
  await runAction("Extension folder opened.", async () => {
    await window.gmailGleanHelper.openExtensionFolder();
  });
});

pairExtensionButton?.addEventListener("click", async () => {
  await runAction("Chrome extension pairing opened.", async () => {
    await window.gmailGleanHelper.pairExtension();
  });
});

copyPairingLinkButton?.addEventListener("click", async () => {
  await runAction("Pairing link copied.", async () => {
    await window.gmailGleanHelper.copyPairingLink();
  });
});

clearTokenButton?.addEventListener("click", async () => {
  await runAction("Glean token cleared.", async () => {
    renderStatus(await window.gmailGleanHelper.clearGleanToken());
  });
});

rotateSecretButton?.addEventListener("click", async () => {
  await runAction("Local pairing secret rotated. Pair the Chrome extension again.", async () => {
    renderStatus(await window.gmailGleanHelper.rotateLocalSecret());
  });
});

openShortcutsButton?.addEventListener("click", () => {
  void window.gmailGleanHelper.openUrl("chrome://extensions/shortcuts");
});

async function refreshStatus() {
  renderStatus(await window.gmailGleanHelper.getStatus());
}

function renderStatus(status: HelperStatus) {
  if (serverUrl) serverUrl.value = status.gleanServerUrl;
  if (launchAtLogin) launchAtLogin.checked = status.launchAtLogin;
  if (replyMode) replyMode.value = status.replySettings.replyMode;
  if (defaultTone) defaultTone.value = status.replySettings.defaultTone;
  if (defaultLength) defaultLength.value = status.replySettings.defaultLength;
  if (overwriteBehavior) overwriteBehavior.value = status.replySettings.overwriteBehavior;
  if (contextDepth) contextDepth.value = status.replySettings.contextDepth;
  if (gleanTimeoutMs) gleanTimeoutMs.value = String(status.gleanTimeoutMs);
  if (statusDot) statusDot.className = status.running ? "dot on" : "dot off";
  if (statusText) {
    statusText.textContent = status.running
      ? `Running on localhost:${status.port}`
      : status.serverError
        ? `Stopped: ${status.serverError}`
        : "Stopped";
  }
  if (tokenState) tokenState.textContent = status.hasToken ? "Token saved securely" : "Token not set";
  if (extensionPath) extensionPath.textContent = status.extensionPath;
  if (extensionId) extensionId.textContent = status.extensionId;
}

async function runAction(successText: string, action: () => Promise<void>) {
  setBusy(true);
  setMessage("Working...", "neutral");

  try {
    await action();
    setMessage(successText, "success");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Something went wrong.", "error");
  } finally {
    setBusy(false);
  }
}

function readReplySettings(): ReplySettings {
  return {
    replyMode: readSelect(replyMode, "auto") as ReplyMode,
    defaultTone: readSelect(defaultTone, "concise") as ReplyTone,
    defaultLength: readSelect(defaultLength, "short") as ReplyLength,
    overwriteBehavior: readSelect(overwriteBehavior, "replace") as OverwriteBehavior,
    contextDepth: readSelect(contextDepth, "visibleThread") as ContextDepth,
  };
}

function readSelect(element: HTMLSelectElement | null, fallback: string) {
  return element?.value || fallback;
}

function setBusy(busy: boolean) {
  [
    saveButton,
    testButton,
    restartButton,
    openExtensionFolderButton,
    pairExtensionButton,
    copyPairingLinkButton,
    clearTokenButton,
    rotateSecretButton,
  ].forEach((button) => {
    if (button) button.disabled = busy;
  });
}

function setMessage(text: string, tone: "neutral" | "success" | "error") {
  if (!message) return;
  message.textContent = text;
  message.className = `message ${tone}`;
}
