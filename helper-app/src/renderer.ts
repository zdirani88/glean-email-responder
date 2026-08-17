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
  bundledExtensionManifestVersion?: string;
  extensionPairedVersion?: string;
  serverError?: string;
}

interface ExtensionActionResult {
  extensionPath: string;
  extensionVersion: string;
  warnings: string[];
}

interface HelperApi {
  getStatus(): Promise<HelperStatus>;
  saveConfig(input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs: number; replySettings: ReplySettings }): Promise<HelperStatus>;
  testGlean(input: { gleanServerUrl: string; token?: string }): Promise<{ ok: true; tokenExpiresAt?: string; tokenScopeHint?: { hasChat: boolean; hasSearch: boolean; hasCalendar: boolean } }>;
  restartServer(): Promise<HelperStatus>;
  openExtensionFolder(): Promise<ExtensionActionResult>;
  copyManualPairingSettings(): Promise<string>;
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
const setupProgress = document.querySelector<HTMLElement>("#setupProgress");
const stepToken = document.querySelector<HTMLElement>("#stepToken");
const stepServer = document.querySelector<HTMLElement>("#stepServer");
const stepExtension = document.querySelector<HTMLElement>("#stepExtension");
const stepTokenDetail = document.querySelector<HTMLElement>("#stepTokenDetail");
const stepServerDetail = document.querySelector<HTMLElement>("#stepServerDetail");
const stepExtensionDetail = document.querySelector<HTMLElement>("#stepExtensionDetail");
const readinessSummary = document.querySelector<HTMLElement>("#readinessSummary");
const statusText = document.querySelector<HTMLElement>("#statusText");
const tokenState = document.querySelector<HTMLElement>("#tokenState");
const saveButton = document.querySelector<HTMLButtonElement>("#save");
const testButton = document.querySelector<HTMLButtonElement>("#test");
const restartButton = document.querySelector<HTMLButtonElement>("#restart");
const openExtensionFolderButton = document.querySelector<HTMLButtonElement>("#openExtensionFolder");
const copyManualPairingSettingsButton = document.querySelector<HTMLButtonElement>("#copyManualPairingSettings");
const clearTokenButton = document.querySelector<HTMLButtonElement>("#clearToken");
const rotateSecretButton = document.querySelector<HTMLButtonElement>("#rotateSecret");
const extensionPath = document.querySelector<HTMLElement>("#extensionPath");
const extensionId = document.querySelector<HTMLElement>("#extensionId");
const extensionConnectionDetail = document.querySelector<HTMLElement>("#extensionConnectionDetail");
const extensionMessage = document.querySelector<HTMLElement>("#extensionMessage");
const message = document.querySelector<HTMLElement>("#message");

void refreshStatus();
window.setInterval(() => void refreshStatus(true), 3000);

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

openExtensionFolderButton?.addEventListener("click", () => {
  void installExtension();
});

copyManualPairingSettingsButton?.addEventListener("click", async () => {
  await runExtensionAction("Pairing values copied. In Chrome’s Extension options, paste the first line as the backend URL and the second as the shared secret, then click Save.", async () => {
    await window.gmailGleanHelper.copyManualPairingSettings();
  });
});

clearTokenButton?.addEventListener("click", async () => {
  await runAction("Glean token cleared.", async () => {
    renderStatus(await window.gmailGleanHelper.clearGleanToken());
  });
});

rotateSecretButton?.addEventListener("click", async () => {
  await runAction("Local pairing secret rotated. Copy the new pairing values into Chrome’s Extension options.", async () => {
    renderStatus(await window.gmailGleanHelper.rotateLocalSecret());
  });
});

async function installExtension() {
  await runExtensionAction(undefined, async () => {
    const result = await window.gmailGleanHelper.openExtensionFolder();
    renderStatus(await window.gmailGleanHelper.getStatus());
    setExtensionMessage(formatExtensionCopySuccess(result), result.warnings.length ? "neutral" : "success");
  });
}

async function refreshStatus(preserveInputs = false) {
  try {
    renderStatus(await window.gmailGleanHelper.getStatus(), preserveInputs);
  } catch (error) {
    setMessage(toFriendlyError(error), "error");
  }
}

function renderStatus(status: HelperStatus, preserveInputs = false) {
  if (!preserveInputs) {
    if (serverUrl) serverUrl.value = status.gleanServerUrl;
    if (launchAtLogin) launchAtLogin.checked = status.launchAtLogin;
    if (replyMode) replyMode.value = status.replySettings.replyMode;
    if (defaultTone) defaultTone.value = status.replySettings.defaultTone;
    if (defaultLength) defaultLength.value = status.replySettings.defaultLength;
    if (overwriteBehavior) overwriteBehavior.value = status.replySettings.overwriteBehavior;
    if (contextDepth) contextDepth.value = status.replySettings.contextDepth;
    if (gleanTimeoutMs) gleanTimeoutMs.value = String(status.gleanTimeoutMs);
    if (writingPreferences) writingPreferences.value = status.replySettings.writingPreferences;
  }
  if (statusDot) statusDot.className = status.running ? "dot on" : "dot off";
  if (statusText) {
    statusText.textContent = status.running
      ? `Running on localhost:${status.port}`
      : status.serverError
        ? `Stopped: ${status.serverError}`
        : "Stopped";
  }
  if (tokenState) tokenState.textContent = status.hasToken ? "Token saved securely" : "Token not set";
  if (extensionPath) extensionPath.textContent = status.extensionPath || "Not prepared yet";
  if (extensionId) extensionId.textContent = status.extensionId;
  renderSetup(status);
}

function renderSetup(status: HelperStatus) {
  const tokenReady = status.hasToken;
  const serverReady = status.running;
  const extensionReady = Boolean(
    status.hasLocalSecret &&
      status.extensionPairedAt &&
      status.extensionPairedVersion &&
      status.extensionPairedVersion === status.bundledExtensionManifestVersion,
  );
  const completed = [tokenReady, serverReady, extensionReady].filter(Boolean).length;
  if (setupProgress) setupProgress.style.width = `${Math.round((completed / 3) * 100)}%`;

  setStep(stepToken, tokenReady, "1");
  setStep(stepServer, serverReady, "2");
  setStep(stepExtension, extensionReady, "3");
  if (stepTokenDetail) stepTokenDetail.textContent = tokenReady ? "Client API token saved." : "Add your server and token below.";
  if (stepServerDetail) stepServerDetail.textContent = serverReady ? `Running on this Mac at port ${status.port}.` : "Restart the helper under Troubleshooting.";
  if (stepExtensionDetail) {
    stepExtensionDetail.textContent = extensionReady
      ? `Chrome confirmed version ${status.extensionPairedVersion}.`
      : status.extensionPairedVersion
        ? `Last confirmed ${status.extensionPairedVersion}; reload Chrome to verify ${status.bundledExtensionManifestVersion || "the current version"}.`
        : "Complete the Chrome steps below.";
  }
  if (extensionConnectionDetail) {
    extensionConnectionDetail.textContent = extensionReady
      ? `Chrome is connected and running extension version ${status.extensionPairedVersion}.`
      : `Current extension version ${status.bundledExtensionManifestVersion || "unavailable"}; Chrome confirmation ${status.extensionPairedVersion || "not received yet"}.`;
  }
  if (readinessSummary) {
    readinessSummary.textContent = completed === 3
      ? "Setup complete. You can draft from Gmail, Slack, LinkedIn, and other web pages."
      : "Finish the incomplete items below. Status updates automatically after Chrome reloads the extension.";
  }
}

function setStep(element: HTMLElement | null, done: boolean, fallbackLabel: string) {
  if (!element) return;
  element.classList.toggle("done", done);
  const badge = element.querySelector<HTMLElement>(".badge");
  if (badge) badge.textContent = done ? "✓" : fallbackLabel;
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

async function runExtensionAction(successText: string | undefined, action: () => Promise<void>) {
  setBusy(true);
  setExtensionMessage("Working…", "neutral");

  try {
    await action();
    if (successText) setExtensionMessage(successText, "success");
  } catch (error) {
    setExtensionMessage(toFriendlyError(error), "error");
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
  if (!scopeHint) return " Calendar action access cannot be confirmed from this token. Scheduling will still ask Glean to check availability when your tenant has a calendar action enabled.";
  const required = scopeHint.hasChat && scopeHint.hasSearch;
  const calendar = scopeHint.hasCalendar
    ? " Calendar-related access appears in the token, but final availability checks still depend on your Glean tenant's enabled actions."
    : " Calendar access was not visible in the token. That may be normal if Glean exposes calendar availability as a tenant action instead of a token scope. Verify suggested times before sending.";
  return required ? calendar : " CHAT or SEARCH scope was not visible in the token. Create a token with CHAT and SEARCH scopes." + calendar;
}

function formatExtensionCopySuccess(result: ExtensionActionResult) {
  const base = `Extension version ${result.extensionVersion} is ready. Finder opened the folder and its location was copied. In Chrome, use Load unpacked for the first install or Reload for an existing install.`;
  return appendWarnings(base, result.warnings);
}

function appendWarnings(base: string, warnings: string[]) {
  if (!warnings.length) return base;
  return `${base} ${warnings.join(" ")}`;
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
    copyManualPairingSettingsButton,
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

function setExtensionMessage(text: string, tone: "neutral" | "success" | "error") {
  if (!extensionMessage) return;
  extensionMessage.textContent = text;
  extensionMessage.className = `message ${tone}`;
}

function toFriendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Something went wrong.");
  const text = raw.toLowerCase();
  if (text.includes("glean token") || text.includes("token problem") || text.includes("please authenticate") || text.includes("authenticate") || text.includes("glean chat 401") || text.includes("glean chat 403")) {
    return "Glean token problem: paste a fresh Client API token with CHAT and SEARCH scopes. For scheduling, your Glean tenant also needs a calendar/free-busy action enabled. Then click Save and Test Glean.";
  }
  if (text.includes("not paired") || text.includes("pair extension") || text.includes("extension is not paired") || text.includes("pairing problem")) {
    return "Chrome is not connected yet. Follow the four extension setup steps, save the pairing values in Extension options, then reload the extension.";
  }
  if (text.includes("fetch failed") || text.includes("econnrefused") || text.includes("could not reach")) {
    return "Helper connection problem: click Restart helper. If that does not work, quit and reopen Glean Response Helper.";
  }
  if (text.includes("403")) {
    return "Access problem: check your Glean token scopes. For scheduling, confirm a calendar/free-busy action is enabled in Glean. Then click Save and Test Glean.";
  }
  if (text.includes("401")) {
    return "Authentication problem: click Test Glean. If it fails, replace your Glean token. If it passes, reconnect the Chrome extension using the setup steps.";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "Glean took too long: increase Timeout in Reply settings, then try again.";
  }
  if (text.includes("extension folder") || text.includes("bundled extension")) {
    return "Extension file problem: click Prepare extension files again. If it still fails, reinstall the latest helper app.";
  }
  return raw;
}
