import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { createBackendApp, testGleanConnection, type AppConfig } from "@gmail-glean-reply-drafter/backend";

interface HelperConfig {
  port: number;
  gleanServerUrl: string;
  encryptedToken?: string;
  encryptedLocalSecret?: string;
  launchAtLogin: boolean;
}

interface PublicStatus {
  running: boolean;
  port: number;
  gleanServerUrl: string;
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

ipcMain.handle("helper:save-config", async (_event, input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean }) => {
  assertTrustedSender(_event.senderFrame?.url);
  currentConfig = {
    ...currentConfig,
    gleanServerUrl: input.gleanServerUrl.trim() || DEFAULT_CONFIG.gleanServerUrl,
    launchAtLogin: input.launchAtLogin,
  };

  if (input.token?.trim()) {
    currentConfig.encryptedToken = encryptToken(input.token.trim());
  }

  await saveHelperConfig(currentConfig);
  app.setLoginItemSettings({ openAtLogin: currentConfig.launchAtLogin });
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:test-glean", async (_event, input: { gleanServerUrl: string; token?: string }) => {
  assertTrustedSender(_event.senderFrame?.url);
  const token = input.token?.trim() || decryptToken(currentConfig.encryptedToken);
  await testGleanConnection(toBackendConfig({ ...currentConfig, gleanServerUrl: input.gleanServerUrl }, token));
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
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
    }
  });

  void mainWindow.loadFile(join(app.getAppPath(), "dist", "index.html"));
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
    gleanTimeoutMs: 45000,
    gleanStubMode: false,
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
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
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
  await writeFile(await getConfigPath(), JSON.stringify(config, null, 2));
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
  if (!url?.startsWith("file://")) {
    throw new Error("Blocked untrusted helper request.");
  }
}
