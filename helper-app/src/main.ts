import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { createBackendApp, DEFAULT_REPLY_SETTINGS, testGleanConnection, type AppConfig, type ReplySettings } from "@gmail-glean-reply-drafter/backend";

interface HelperConfig {
  port: number;
  gleanServerUrl: string;
  gleanTimeoutMs: number;
  replySettings: ReplySettings;
  encryptedToken?: string;
  encryptedLocalSecret?: string;
  launchAtLogin: boolean;
}

interface PublicStatus {
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

const DEFAULT_CONFIG: HelperConfig = {
  port: 8787,
  gleanServerUrl: "https://scio-prod-be.glean.com",
  gleanTimeoutMs: 45000,
  replySettings: { ...DEFAULT_REPLY_SETTINGS },
  launchAtLogin: false,
};
const BACKEND_HOST = "127.0.0.1";
const EXTENSION_ID = "odjbnkdimjemoifcndjpopoiifpdnlbo";

const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | undefined;
let server: Server | undefined;
let currentConfig = DEFAULT_CONFIG;
let lastServerError: string | undefined;

app.whenReady().then(async () => {
  currentConfig = await loadHelperConfig();
  currentConfig = await ensureLocalSecret(currentConfig);
  await startLocalServerSafely();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("helper:get-status", async (event): Promise<PublicStatus> => {
  assertTrustedSender(event.senderFrame?.url);
  return getPublicStatus();
});

ipcMain.handle("helper:save-config", async (_event, input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs?: number; replySettings?: Partial<ReplySettings> }) => {
  assertTrustedSender(_event.senderFrame?.url);
  const validated = validateSaveConfigInput(input);
  currentConfig = {
    ...currentConfig,
    gleanServerUrl: validated.gleanServerUrl,
    gleanTimeoutMs: validated.gleanTimeoutMs,
    replySettings: validated.replySettings,
    launchAtLogin: validated.launchAtLogin,
  };

  if (validated.token) {
    currentConfig.encryptedToken = encryptToken(validated.token);
  }

  await saveHelperConfig(currentConfig);
  app.setLoginItemSettings({ openAtLogin: currentConfig.launchAtLogin });
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:test-glean", async (_event, input: { gleanServerUrl: string; token?: string }) => {
  assertTrustedSender(_event.senderFrame?.url);
  const validated = validateTestGleanInput(input);
  const token = validated.token || decryptToken(currentConfig.encryptedToken);
  await testGleanConnection(toBackendConfig({ ...currentConfig, gleanServerUrl: validated.gleanServerUrl }, token));
  return { ok: true };
});

ipcMain.handle("helper:restart-server", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:open-url", async (_event, url: string) => {
  assertTrustedSender(_event.senderFrame?.url);
  if (url === "chrome://extensions" || url === "chrome://extensions/shortcuts") {
    await openChromeUrl(url);
    return;
  }

  throw new Error("This helper can only open Chrome extension setup pages.");
});

ipcMain.handle("helper:open-extension-folder", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  const extensionPath = await prepareInstallableExtensionFolder();
  await openChromeUrl("chrome://extensions");
  const result = await shell.openPath(extensionPath);
  if (result) throw new Error(result);
});

ipcMain.handle("helper:pair-extension", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  await prepareInstallableExtensionFolder();
  await openChromeUrl(getExtensionPairingUrl());
});

ipcMain.handle("helper:copy-pairing-link", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  clipboard.writeText(getExtensionPairingUrl());
});

ipcMain.handle("helper:clear-glean-token", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  delete currentConfig.encryptedToken;
  await saveHelperConfig(currentConfig);
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:rotate-local-secret", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  currentConfig.encryptedLocalSecret = encryptToken(generateLocalSecret());
  await saveHelperConfig(currentConfig);
  await restartLocalServerSafely();
  return getPublicStatus();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    title: "Gmail Glean Helper",
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== getRendererUrl()) {
      event.preventDefault();
    }
  });

  void mainWindow.loadFile(getRendererPath());
}

async function startLocalServer() {
  if (server) return;

  const token = decryptToken(currentConfig.encryptedToken);
  const backend = createBackendApp(toBackendConfig(currentConfig, token));

  await new Promise<void>((resolve, reject) => {
    server = backend
      .listen(currentConfig.port, BACKEND_HOST, () => resolve())
      .on("error", (error: Error) => reject(error));
  });
}

async function startLocalServerSafely() {
  try {
    await startLocalServer();
    lastServerError = undefined;
  } catch (error) {
    lastServerError = error instanceof Error ? error.message : "Could not start the local server.";
    server = undefined;
  }
}

async function restartLocalServer() {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }

  await startLocalServer();
}

async function restartLocalServerSafely() {
  try {
    await restartLocalServer();
    lastServerError = undefined;
  } catch (error) {
    lastServerError = error instanceof Error ? error.message : "Could not restart the local server.";
    server = undefined;
  }
}

function toBackendConfig(config: HelperConfig, token?: string): AppConfig {
  const backendConfig: AppConfig = {
    port: config.port,
    host: BACKEND_HOST,
    gleanServerUrl: config.gleanServerUrl,
    gleanTimeoutMs: config.gleanTimeoutMs,
    gleanStubMode: false,
    replySettings: config.replySettings,
  };

  if (token) backendConfig.gleanApiToken = token;
  backendConfig.sharedSecret = getLocalSecret(config);
  return backendConfig;
}

function getPublicStatus(): PublicStatus {
  const status: PublicStatus = {
    running: Boolean(server?.listening),
    port: currentConfig.port,
    gleanServerUrl: currentConfig.gleanServerUrl,
    gleanTimeoutMs: currentConfig.gleanTimeoutMs,
    replySettings: currentConfig.replySettings,
    hasToken: Boolean(currentConfig.encryptedToken),
    hasLocalSecret: Boolean(currentConfig.encryptedLocalSecret),
    launchAtLogin: currentConfig.launchAtLogin,
    extensionPath: getInstallableExtensionPath(),
    extensionId: EXTENSION_ID,
  };
  if (lastServerError) status.serverError = lastServerError;
  return status;
}

function getBundledExtensionPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, "extension");
  }

  return resolve(app.getAppPath(), "..", "extension", "dist");
}

function getInstallableExtensionPath() {
  return join(app.getPath("desktop"), "Gmail Glean Reply Extension");
}

async function prepareInstallableExtensionFolder() {
  const source = getBundledExtensionPath();
  const destination = getInstallableExtensionPath();

  if (!existsSync(source)) {
    throw new Error(`Bundled extension folder was not found at ${source}`);
  }

  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  return destination;
}

async function openChromeUrl(url: string) {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-a", "Google Chrome", url]);
    return;
  }

  await shell.openExternal(url);
}

function getExtensionPairingUrl() {
  const payload = {
    backendBaseUrl: `http://${BACKEND_HOST}:${currentConfig.port}`,
    backendSecret: getLocalSecret(currentConfig),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `chrome-extension://${EXTENSION_ID}/options.html#pair=${encoded}`;
}

async function getConfigPath() {
  const dir = app.getPath("userData");
  await mkdir(dir, { recursive: true });
  return join(dir, "helper-config.json");
}

async function loadHelperConfig(): Promise<HelperConfig> {
  const path = await getConfigPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HelperConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      gleanTimeoutMs: normalizeTimeout(parsed.gleanTimeoutMs),
      replySettings: normalizeReplySettings(parsed.replySettings),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function ensureLocalSecret(config: HelperConfig) {
  if (config.encryptedLocalSecret) {
    try {
      getLocalSecret(config);
      return config;
    } catch {
      // Recreate the local pairing secret if secure storage cannot decrypt the old one.
    }
  }

  const nextConfig = {
    ...config,
    encryptedLocalSecret: encryptToken(generateLocalSecret()),
  };
  await saveHelperConfig(nextConfig);
  return nextConfig;
}

async function saveHelperConfig(config: HelperConfig) {
  const path = await getConfigPath();
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

function encryptToken(token: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure token storage is not available on this computer.");
  }

  return safeStorage.encryptString(token).toString("base64");
}

function decryptToken(encryptedToken: string | undefined) {
  if (!encryptedToken) return undefined;
  if (!safeStorage.isEncryptionAvailable()) return undefined;

  try {
    return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
  } catch {
    return undefined;
  }
}

function generateLocalSecret() {
  return randomBytes(32).toString("base64url");
}

function getLocalSecret(config: HelperConfig) {
  const secret = decryptToken(config.encryptedLocalSecret);
  if (!secret) {
    throw new Error("Local extension pairing secret is unavailable. Reset the local pairing secret and pair the extension again.");
  }
  return secret;
}

function assertTrustedSender(url: string | undefined) {
  if (url !== getRendererUrl()) {
    throw new Error("Blocked untrusted helper request.");
  }
}

function getRendererPath() {
  return join(app.getAppPath(), "dist", "index.html");
}

function getRendererUrl() {
  return pathToFileURL(getRendererPath()).href;
}

function validateSaveConfigInput(input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs?: number; replySettings?: Partial<ReplySettings> }) {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid settings payload.");
  }

  return {
    gleanServerUrl: normalizeGleanServerUrl(input.gleanServerUrl),
    token: normalizeOptionalToken(input.token),
    gleanTimeoutMs: normalizeTimeout(input.gleanTimeoutMs),
    replySettings: normalizeReplySettings(input.replySettings),
    launchAtLogin: input.launchAtLogin === true,
  };
}

function validateTestGleanInput(input: { gleanServerUrl: string; token?: string }) {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid connection test payload.");
  }

  return {
    gleanServerUrl: normalizeGleanServerUrl(input.gleanServerUrl),
    token: normalizeOptionalToken(input.token),
  };
}

function normalizeGleanServerUrl(value: unknown) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_CONFIG.gleanServerUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a valid Glean server URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Glean server URL must start with https://.");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOptionalToken(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Token must be text.");
  }

  const token = value.trim();
  if (!token) return undefined;
  if (token.length > 8192) {
    throw new Error("Token is too long.");
  }

  return token;
}

function normalizeTimeout(value: unknown) {
  const timeout = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_CONFIG.gleanTimeoutMs;
  return Math.min(Math.max(Math.round(timeout), 15000), 90000);
}

function normalizeReplySettings(value: unknown): ReplySettings {
  const incoming = typeof value === "object" && value !== null ? value as Partial<ReplySettings> : {};
  return {
    replyMode: pickSetting(incoming.replyMode, ["auto", "fast", "thinking"], DEFAULT_REPLY_SETTINGS.replyMode),
    defaultTone: pickSetting(incoming.defaultTone, ["concise", "warm", "formal", "direct"], DEFAULT_REPLY_SETTINGS.defaultTone),
    defaultLength: pickSetting(incoming.defaultLength, ["short", "medium", "detailed"], DEFAULT_REPLY_SETTINGS.defaultLength),
    overwriteBehavior: pickSetting(incoming.overwriteBehavior, ["replace", "append"], DEFAULT_REPLY_SETTINGS.overwriteBehavior),
    contextDepth: pickSetting(incoming.contextDepth, ["latest", "visibleThread"], DEFAULT_REPLY_SETTINGS.contextDepth),
  };
}

function pickSetting<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}
