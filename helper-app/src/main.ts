import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  extensionInstallPath?: string;
  launchAtLogin: boolean;
  extensionPairedAt?: string;
  extensionPairedVersion?: string;
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
  extensionPairedAt?: string;
  extensionFolderReady: boolean;
  bundledExtensionReady: boolean;
  extensionFolderDetail: string;
  bundledExtensionDetail: string;
  extensionManifestVersion?: string;
  bundledExtensionManifestVersion?: string;
  extensionVersionMatches: boolean;
  extensionPairedVersion?: string;
  manualInstallCommand: string;
  manualPairingSettings: string;
  serverError?: string;
}

interface ExtensionActionResult {
  extensionPath: string;
  extensionVersion: string;
  manualInstallCommand: string;
  warnings: string[];
}

interface ExtensionFolderStatus {
  path: string;
  ready: boolean;
  detail: string;
  missingFiles: string[];
  manifestVersion?: string;
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
const EXTENSION_FOLDER_NAME = "Gmail Glean Reply Extension";
const REQUIRED_EXTENSION_FILES = ["manifest.json", "background.js", "contentScript.js", "options.html", "options.js"];

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
  return { ok: true, tokenExpiresAt: getTokenExpiresAt(token), tokenScopeHint: getTokenScopeHint(token) };
});

ipcMain.handle("helper:restart-server", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:open-url", async (_event, url: string) => {
  assertTrustedSender(_event.senderFrame?.url);
  if (isAllowedChromeUrl(url)) {
    await openChromeUrl(url);
    return;
  }

  throw new Error("This helper can only open Chrome extension setup pages.");
});

ipcMain.handle("helper:open-extension-folder", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  const { extensionPath, extensionVersion, warnings } = await prepareInstallableExtensionFolder();
  clipboard.writeText(extensionPath);
  void openChromeUrl("chrome://extensions").catch((error) => {
    console.warn("chrome_extensions_page_open_failed", toErrorMessage(error));
  });
  void shell.openPath(extensionPath).then((error) => {
    if (error) console.warn("extension_folder_open_failed", error);
  });
  return { extensionPath, extensionVersion, manualInstallCommand: getManualInstallCommand(), warnings } satisfies ExtensionActionResult;
});

ipcMain.handle("helper:pair-extension", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  const { extensionPath, extensionVersion, warnings } = await prepareInstallableExtensionFolder();
  clipboard.writeText(getManualPairingSettings());
  void openChromeUrl(getChromeExtensionDetailsUrl()).catch((error) => {
    console.warn("chrome_extensions_page_open_failed", toErrorMessage(error));
  });
  return { extensionPath, extensionVersion, manualInstallCommand: getManualInstallCommand(), warnings } satisfies ExtensionActionResult;
});

ipcMain.handle("helper:copy-pairing-link", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  clipboard.writeText(getExtensionPairingUrl());
});

ipcMain.handle("helper:copy-manual-install-command", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  const command = getManualInstallCommand();
  clipboard.writeText(command);
  return command;
});

ipcMain.handle("helper:copy-manual-pairing-settings", async (event) => {
  assertTrustedSender(event.senderFrame?.url);
  const settings = getManualPairingSettings();
  clipboard.writeText(settings);
  return settings;
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
  delete currentConfig.extensionPairedAt;
  delete currentConfig.extensionPairedVersion;
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
  backendConfig.onPairingConfirmed = (extensionVersion) => {
    const nextConfig = {
      ...currentConfig,
      extensionPairedAt: new Date().toISOString(),
      ...(extensionVersion ? { extensionPairedVersion: extensionVersion } : {}),
    };
    if (!extensionVersion) delete nextConfig.extensionPairedVersion;
    currentConfig = nextConfig;
    void saveHelperConfig(currentConfig);
  };
  return backendConfig;
}

function getPublicStatus(): PublicStatus {
  const bundledExtensionPath = getBundledExtensionPath();
  const installableExtensionPath = getInstallableExtensionPath();
  const bundledExtension = getExtensionFolderStatus(bundledExtensionPath);
  const installableExtension = getExtensionFolderStatus(installableExtensionPath);
  const extensionVersionMatches = Boolean(
    bundledExtension.manifestVersion && installableExtension.manifestVersion === bundledExtension.manifestVersion,
  );
  const extensionFolderDetail = getInstallableExtensionDetail(installableExtension, bundledExtension);
  const status: PublicStatus = {
    running: Boolean(server?.listening),
    port: currentConfig.port,
    gleanServerUrl: currentConfig.gleanServerUrl,
    gleanTimeoutMs: currentConfig.gleanTimeoutMs,
    replySettings: currentConfig.replySettings,
    hasToken: Boolean(currentConfig.encryptedToken),
    hasLocalSecret: Boolean(currentConfig.encryptedLocalSecret),
    launchAtLogin: currentConfig.launchAtLogin,
    extensionPath: installableExtension.ready ? installableExtensionPath : "",
    extensionId: EXTENSION_ID,
    extensionFolderReady: installableExtension.ready,
    bundledExtensionReady: bundledExtension.ready,
    extensionFolderDetail,
    bundledExtensionDetail: bundledExtension.detail,
    extensionVersionMatches,
    manualInstallCommand: getManualInstallCommand(),
    manualPairingSettings: getManualPairingSettings(),
  };
  if (installableExtension.manifestVersion) status.extensionManifestVersion = installableExtension.manifestVersion;
  if (bundledExtension.manifestVersion) status.bundledExtensionManifestVersion = bundledExtension.manifestVersion;
  if (currentConfig.extensionPairedAt) status.extensionPairedAt = currentConfig.extensionPairedAt;
  if (currentConfig.extensionPairedVersion) status.extensionPairedVersion = currentConfig.extensionPairedVersion;
  if (lastServerError) status.serverError = lastServerError;
  return status;
}

function getBundledExtensionPath() {
  const fallbackPath = app.isPackaged ? join(process.resourcesPath, "extension") : resolve(app.getAppPath(), "..", "..", "extension", "dist");
  const candidates: string[] = app.isPackaged
    ? [
        fallbackPath,
        resolve(app.getAppPath(), "..", "extension"),
        resolve(app.getAppPath(), "..", "..", "extension"),
        // Support helper bundles created before the extension moved under Resources.
        resolve(app.getAppPath(), "..", "..", "extension", "dist"),
      ]
    : [fallbackPath];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }

  return fallbackPath;
}

function getInstallableExtensionPath() {
  const candidates = uniquePaths([currentConfig.extensionInstallPath, getDesktopExtensionPath(), getFallbackExtensionPath()]);
  return candidates.find((path) => getExtensionFolderStatus(path).ready) || currentConfig.extensionInstallPath || getDesktopExtensionPath();
}

function isAllowedChromeUrl(url: string) {
  return url === "chrome://extensions" || url === "chrome://extensions/shortcuts" || url === getChromeExtensionDetailsUrl();
}

async function prepareInstallableExtensionFolder() {
  const source = getBundledExtensionPath();
  const warnings: string[] = [];
  const sourceStatus = getExtensionFolderStatus(source);

  if (!sourceStatus.ready) {
    throw new Error(`Bundled extension folder is incomplete at ${source}. ${sourceStatus.detail}`);
  }

  const destinations = uniquePaths([getDesktopExtensionPath(), currentConfig.extensionInstallPath, getFallbackExtensionPath()]);
  for (const destination of destinations) {
    try {
      await copyExtensionFolder(source, destination);
      currentConfig = { ...currentConfig, extensionInstallPath: destination };
      await saveHelperConfig(currentConfig);
      if (destination !== getDesktopExtensionPath()) {
        warnings.push(`macOS did not allow copying to Desktop, so the extension was copied to ${destination}.`);
      }
      return { extensionPath: destination, extensionVersion: sourceStatus.manifestVersion ?? "unknown", warnings };
    } catch (error) {
      warnings.push(`Could not copy extension to ${destination}: ${toErrorMessage(error)}`);
    }
  }

  throw new Error(`Extension copy failed. ${warnings.join(" ")}`);
}

async function openChromeUrl(url: string) {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("open", ["-b", "com.google.Chrome", url]);
      return;
    } catch {
      await execFileAsync("open", ["-a", "Google Chrome", url]);
    }
    return;
  }

  await shell.openExternal(url);
}

async function copyExtensionFolder(source: string, destination: string) {
  const stagingPath = `${destination}.staging-${process.pid}`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(stagingPath, { recursive: true, force: true });

  try {
    await cp(source, stagingPath, { recursive: true, force: true });
    const copiedStatus = getExtensionFolderStatus(stagingPath);
    if (!copiedStatus.ready) {
      throw new Error(copiedStatus.detail);
    }
    if (copiedStatus.manifestVersion !== readExtensionManifestVersion(source)) {
      throw new Error("The copied extension version does not match the bundled extension.");
    }

    await rm(destination, { recursive: true, force: true });
    await rename(stagingPath, destination);
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

function getInstallableExtensionDetail(installable: ExtensionFolderStatus, bundled: ExtensionFolderStatus) {
  if (!installable.ready) return installable.detail;
  if (!bundled.manifestVersion) return "Bundled extension version is unavailable.";
  if (installable.manifestVersion !== bundled.manifestVersion) {
    return `Out of date. Installed version ${installable.manifestVersion ?? "unknown"}; current version ${bundled.manifestVersion}. Click Install / refresh extension.`;
  }
  return `Current extension version ${bundled.manifestVersion}.`;
}

function getExtensionFolderStatus(path: string): ExtensionFolderStatus {
  const missingFiles = REQUIRED_EXTENSION_FILES.filter((file) => !existsSync(join(path, file)));
  const manifestVersion = readExtensionManifestVersion(path);
  const ready = missingFiles.length === 0;
  return {
    path,
    ready,
    detail: ready
      ? manifestVersion
        ? `Ready. Extension version ${manifestVersion}.`
        : "Ready."
      : existsSync(path)
        ? `Missing ${missingFiles.join(", ")}.`
        : "Folder has not been copied yet.",
    missingFiles,
    ...(manifestVersion ? { manifestVersion } : {}),
  };
}

function readExtensionManifestVersion(path: string) {
  try {
    const raw = readFileSync(join(path, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function getDesktopExtensionPath() {
  return join(app.getPath("desktop"), EXTENSION_FOLDER_NAME);
}

function getFallbackExtensionPath() {
  return join(app.getPath("userData"), EXTENSION_FOLDER_NAME);
}

function uniquePaths(paths: Array<string | undefined>) {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}

function toErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error.");
}

function getExtensionPairingUrl() {
  const payload = {
    backendBaseUrl: `http://${BACKEND_HOST}:${currentConfig.port}`,
    backendSecret: getLocalSecret(currentConfig),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `chrome-extension://${EXTENSION_ID}/options.html#pair=${encoded}`;
}

function getChromeExtensionDetailsUrl() {
  return `chrome://extensions/?id=${EXTENSION_ID}`;
}

function getManualInstallCommand() {
  const source = getBundledExtensionPath();
  const desktopDestination = getDesktopExtensionPath();
  const fallbackDestination = getFallbackExtensionPath();
  return [
    `if mkdir -p ${quoteShellArg(dirname(desktopDestination))} && ditto ${quoteShellArg(source)} ${quoteShellArg(desktopDestination)}; then`,
    `  printf '%s\\n' ${quoteShellArg(`Extension copied to ${desktopDestination}`)};`,
    "else",
    `  mkdir -p ${quoteShellArg(dirname(fallbackDestination))} && ditto ${quoteShellArg(source)} ${quoteShellArg(fallbackDestination)} && printf '%s\\n' ${quoteShellArg(`Desktop was unavailable. Extension copied to ${fallbackDestination}`)};`,
    "fi",
  ].join("\n");
}

function getManualPairingSettings() {
  return [`http://${BACKEND_HOST}:${currentConfig.port}`, getLocalSecret(currentConfig)].join("\n");
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    writingPreferences: normalizeWritingPreferences(incoming.writingPreferences),
  };
}

function pickSetting<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function normalizeWritingPreferences(value: unknown) {
  if (typeof value !== "string") return DEFAULT_REPLY_SETTINGS.writingPreferences;
  const trimmed = value.trim();
  return trimmed.slice(0, 2000) || DEFAULT_REPLY_SETTINGS.writingPreferences;
}

function getTokenExpiresAt(token: string | undefined) {
  if (!token) return undefined;
  const payload = decodeJwtPayload(token) as { exp?: unknown } | undefined;
  if (!payload) return undefined;

  try {
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
    const expiresAt = new Date(payload.exp * 1000);
    if (Number.isNaN(expiresAt.getTime())) return undefined;
    return expiresAt.toISOString();
  } catch {
    return undefined;
  }
}

function getTokenScopeHint(token: string | undefined) {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const rawScopes = [payload.scope, payload.scopes, payload.permissions, payload.authorities]
    .flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (!rawScopes.length) return undefined;
  const normalized = rawScopes.map((scope) => scope.toLowerCase());
  return {
    hasChat: normalized.some((scope) => scope.includes("chat")),
    hasSearch: normalized.some((scope) => scope.includes("search")),
    hasCalendar: normalized.some((scope) => scope.includes("calendar") || scope.includes("google_calendar") || scope.includes("free_slots")),
  };
}

function decodeJwtPayload(token: string | undefined) {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
