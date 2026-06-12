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
  writingPreferences: string;
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
  extensionPairedAt?: string;
  extensionFolderReady: boolean;
  bundledExtensionReady: boolean;
  serverError?: string;
}

interface HelperApi {
  getStatus(): Promise<HelperStatus>;
  saveConfig(input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs: number; replySettings: ReplySettings }): Promise<HelperStatus>;
  testGlean(input: { gleanServerUrl: string; token?: string }): Promise<{ ok: true; tokenExpiresAt?: string; tokenScopeHint?: { hasChat: boolean; hasSearch: boolean; hasCalendar: boolean } }>;
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
const writingPreferences = document.querySelector<HTMLTextAreaElement>("#writingPreferences");
const statusDot = document.querySelector<HTMLElement>("#statusDot");
const refreshStatusButton = document.querySelector<HTMLButtonElement>("#refreshStatus");
const jumpConnectButton = document.querySelector<HTMLButtonElement>("#jumpConnect");
const quickRestartButton = document.querySelector<HTMLButtonElement>("#quickRestart");
const quickRefreshExtensionButton = document.querySelector<HTMLButtonElement>("#quickRefreshExtension");
const quickPairButton = document.querySelector<HTMLButtonElement>("#quickPair");
const setupProgress = document.querySelector<HTMLElement>("#setupProgress");
const stepToken = document.querySelector<HTMLElement>("#stepToken");
const stepServer = document.querySelector<HTMLElement>("#stepServer");
const stepExtension = document.querySelector<HTMLElement>("#stepExtension");
const stepPair = document.querySelector<HTMLElement>("#stepPair");
const healthBackend = document.querySelector<HTMLElement>("#healthBackend");
const healthToken = document.querySelector<HTMLElement>("#healthToken");
const healthSecret = document.querySelector<HTMLElement>("#healthSecret");
const healthExtension = document.querySelector<HTMLElement>("#healthExtension");
const connectSection = document.querySelector<HTMLElement>("#connectSection");
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

refreshStatusButton?.addEventListener("click", () => {
  void refreshStatus();
});

jumpConnectButton?.addEventListener("click", () => {
  connectSection?.scrollIntoView({ behavior: "smooth", block: "start" });
  serverUrl?.focus();
});

quickRestartButton?.addEventListener("click", () => {
  restartButton?.click();
});

quickRefreshExtensionButton?.addEventListener("click", () => {
  openExtensionFolderButton?.click();
});

quickPairButton?.addEventListener("click", () => {
  pairExtensionButton?.click();
});

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
  await runAction(undefined, async () => {
    const input: { gleanServerUrl: string; token?: string } = {
      gleanServerUrl: serverUrl?.value ?? "",
    };
    if (token?.value) input.token = token.value;
    const result = await window.gmailGleanHelper.testGlean(input);
    setMessage(formatGleanTestSuccess(result.tokenExpiresAt, result.tokenScopeHint), "success");
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
  await runAction("Latest extension copied to Desktop. In Chrome, click Reload on Glean Email Responder or Load unpacked if it is not installed yet.", async () => {
    await window.gmailGleanHelper.openExtensionFolder();
    renderStatus(await window.gmailGleanHelper.getStatus());
  });
});

pairExtensionButton?.addEventListener("click", async () => {
  await runAction(undefined, async () => {
    await window.gmailGleanHelper.pairExtension();
    const status = await waitForPairingConfirmation();
    renderStatus(status);
    if (status.extensionPairedAt) {
      setMessage("Extension pairing confirmed. Reload Gmail before drafting.", "success");
      return;
    }

    setMessage("Pairing page opened in Chrome. If the checklist does not turn green, reload the extension and click Pair extension again.", "neutral");
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

async function waitForPairingConfirmation() {
  let latest = await window.gmailGleanHelper.getStatus();
  for (let index = 0; index < 20 && !latest.extensionPairedAt; index += 1) {
    await sleep(500);
    latest = await window.gmailGleanHelper.getStatus();
  }
  return latest;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshStatus() {
  try {
    renderStatus(await window.gmailGleanHelper.getStatus());
  } catch (error) {
    setMessage(toFriendlyError(error), "error");
  }
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
  if (writingPreferences) writingPreferences.value = status.replySettings.writingPreferences;
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
  renderSetup(status);
}

function renderSetup(status: HelperStatus) {
  const tokenReady = status.hasToken;
  const serverReady = status.running;
  const extensionReady = status.extensionFolderReady && status.bundledExtensionReady;
  const pairReady = Boolean(status.hasLocalSecret && status.extensionPairedAt);
  const completed = [tokenReady, serverReady, extensionReady, pairReady].filter(Boolean).length;
  if (setupProgress) setupProgress.style.width = `${Math.round((completed / 4) * 100)}%`;

  setStep(stepToken, tokenReady, "1");
  setStep(stepServer, serverReady, "2");
  setStep(stepExtension, extensionReady, "3", status.bundledExtensionReady);
  setStep(stepPair, pairReady, "4");

  setHealth(healthBackend, serverReady, "Backend", serverReady ? `Running on localhost:${status.port}` : status.serverError || "Stopped. Click Start helper.");
  setHealth(healthToken, tokenReady, "Glean token", tokenReady ? "Saved in macOS secure storage." : "Missing. Paste a Client API token and save.");
  setHealth(
    healthSecret,
    pairReady,
    "Extension pairing",
    pairReady
      ? `Confirmed ${formatRelativeTime(status.extensionPairedAt)}`
      : status.hasLocalSecret
        ? "Not confirmed. Click Pair extension, then reload Gmail."
        : "Missing local secret. Rotate pairing secret."
  );
  setHealth(healthExtension, extensionReady, "Extension folder", extensionReady ? "Latest copy is ready on Desktop." : "Click Refresh extension copy.", status.bundledExtensionReady);
}

function formatRelativeTime(value: string | undefined) {
  if (!value) return "recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function setStep(element: HTMLElement | null, done: boolean, fallbackLabel: string, available = true) {
  if (!element) return;
  element.classList.toggle("done", done);
  element.classList.toggle("warn", !available);
  const badge = element.querySelector<HTMLElement>(".badge");
  if (badge) badge.textContent = done ? "✓" : fallbackLabel;
}

function setHealth(element: HTMLElement | null, done: boolean, title: string, detail: string, available = true) {
  if (!element) return;
  element.classList.toggle("done", done);
  element.classList.toggle("warn", !done && available);
  const badge = element.querySelector<HTMLElement>(".badge");
  const strong = element.querySelector<HTMLElement>("strong");
  const small = element.querySelector<HTMLElement>("small");
  if (badge) badge.textContent = done ? "✓" : available ? "!" : "×";
  if (strong) strong.textContent = title;
  if (small) small.textContent = detail;
}

async function runAction(successText: string | undefined, action: () => Promise<void>) {
  setBusy(true);
  setMessage("Working...", "neutral");

  try {
    await action();
    if (successText) setMessage(successText, "success");
  } catch (error) {
    setMessage(toFriendlyError(error), "error");
  } finally {
    setBusy(false);
  }
}

function formatGleanTestSuccess(tokenExpiresAt: string | undefined, tokenScopeHint?: { hasChat: boolean; hasSearch: boolean; hasCalendar: boolean }) {
  const scopeText = formatScopeHint(tokenScopeHint);
  if (!tokenExpiresAt) return "Glean connection works. Token expiration is not available from this token." + scopeText;

  const expiresAt = new Date(tokenExpiresAt);
  const days = Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000);
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(expiresAt);

  if (days < 0) return `Glean connection works, but this token appears to have expired on ${formatted}.` + scopeText;
  if (days === 0) return `Glean connection works. Token expires today at ${formatted}.` + scopeText;
  return `Glean connection works. Token expires ${formatted}, in about ${days} day${days === 1 ? "" : "s"}.` + scopeText;
}

function formatScopeHint(scopeHint: { hasChat: boolean; hasSearch: boolean; hasCalendar: boolean } | undefined) {
  if (!scopeHint) return " Calendar action access could not be detected from this token, scheduling will still ask Glean to check availability when possible.";
  const required = scopeHint.hasChat && scopeHint.hasSearch;
  const calendar = scopeHint.hasCalendar ? " Calendar scope appears present." : " Calendar scope was not visible in the token. Scheduling drafts can still work if Glean enables the calendar action server-side, but verify suggested times before sending.";
  return required ? calendar : " CHAT or SEARCH scope was not visible in the token. Create a token with CHAT and SEARCH scopes." + calendar;
}

function readReplySettings(): ReplySettings {
  return {
    replyMode: readSelect(replyMode, "auto") as ReplyMode,
    defaultTone: readSelect(defaultTone, "concise") as ReplyTone,
    defaultLength: readSelect(defaultLength, "short") as ReplyLength,
    overwriteBehavior: readSelect(overwriteBehavior, "replace") as OverwriteBehavior,
    contextDepth: readSelect(contextDepth, "visibleThread") as ContextDepth,
    writingPreferences: writingPreferences?.value.trim() || "Do not use em dashes. Write concise, warm, direct replies.",
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
    refreshStatusButton,
    quickRestartButton,
    quickRefreshExtensionButton,
    quickPairButton,
  ].forEach((button) => {
    if (button) button.disabled = busy;
  });
}

function setMessage(text: string, tone: "neutral" | "success" | "error") {
  if (!message) return;
  message.textContent = text;
  message.className = `message ${tone}`;
}

function toFriendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Something went wrong.");
  const text = raw.toLowerCase();
  if (text.includes("glean token") || text.includes("token problem") || text.includes("please authenticate") || text.includes("authenticate") || text.includes("glean chat 401") || text.includes("glean chat 403")) {
    return "Glean token problem: paste a fresh Client API token with CHAT and SEARCH scopes. For scheduling, add calendar or Google Calendar scopes if available. Then click Save and Test Glean.";
  }
  if (text.includes("not paired") || text.includes("pair extension") || text.includes("extension is not paired") || text.includes("pairing problem")) {
    return "Pairing problem: click Pair extension, then reload Gmail and try again.";
  }
  if (text.includes("fetch failed") || text.includes("econnrefused") || text.includes("could not reach")) {
    return "Helper connection problem: click Restart server. If that does not work, quit and reopen Gmail Glean Helper.";
  }
  if (text.includes("403")) {
    return "Access problem: check your Glean token scopes. For scheduling, confirm calendar action access is enabled in Glean. Then click Save and Test Glean.";
  }
  if (text.includes("401")) {
    return "Authentication problem: click Test Glean. If it fails, replace your Glean token. If it passes, click Pair extension.";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "Glean took too long: increase Timeout in Reply settings, then try again.";
  }
  if (text.includes("extension folder") || text.includes("bundled extension")) {
    return "Extension copy problem: reinstall the latest helper app, then click Refresh extension copy.";
  }
  return raw;
}
