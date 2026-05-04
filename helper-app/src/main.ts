import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { createBackendApp, testGleanConnection, type AppConfig } from "@gmail-glean-reply-drafter/backend";

interface HelperConfig {
  port: number;
  gleanServerUrl: string;
  encryptedToken?: string;
  launchAtLogin: boolean;
}

interface PublicStatus {
  running: boolean;
  port: number;
  gleanServerUrl: string;
  hasToken: boolean;
  launchAtLogin: boolean;
  extensionPath: string;
  serverError?: string;
}

const DEFAULT_CONFIG: HelperConfig = {
  port: 8787,
  gleanServerUrl: "https://scio-prod-be.glean.com",
  launchAtLogin: false,
};

let mainWindow: BrowserWindow | undefined;
let server: Server | undefined;
let currentConfig = DEFAULT_CONFIG;
let lastServerError: string | undefined;

app.whenReady().then(async () => {
  currentConfig = await loadHelperConfig();
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

ipcMain.handle("helper:get-status", async (): Promise<PublicStatus> => getPublicStatus());

ipcMain.handle("helper:save-config", async (_event, input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean }) => {
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
  const token = input.token?.trim() || decryptToken(currentConfig.encryptedToken);
  await testGleanConnection(toBackendConfig({ ...currentConfig, gleanServerUrl: input.gleanServerUrl }, token));
  return { ok: true };
});

ipcMain.handle("helper:restart-server", async () => {
  await restartLocalServerSafely();
  return getPublicStatus();
});

ipcMain.handle("helper:open-url", async (_event, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle("helper:open-extension-folder", async () => {
  const result = await shell.openPath(getBundledExtensionPath());
  if (result) throw new Error(result);
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
    },
  });

  void mainWindow.loadFile(join(app.getAppPath(), "dist", "index.html"));
}

async function startLocalServer() {
  if (server) return;

  const token = decryptToken(currentConfig.encryptedToken);
  const backend = createBackendApp(toBackendConfig(currentConfig, token));

  await new Promise<void>((resolve, reject) => {
    server = backend
      .listen(currentConfig.port, () => resolve())
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
    gleanServerUrl: config.gleanServerUrl,
    gleanTimeoutMs: 45000,
    gleanStubMode: false,
  };

  if (token) backendConfig.gleanApiToken = token;
  return backendConfig;
}

function getPublicStatus(): PublicStatus {
  const status: PublicStatus = {
    running: Boolean(server?.listening),
    port: currentConfig.port,
    gleanServerUrl: currentConfig.gleanServerUrl,
    hasToken: Boolean(currentConfig.encryptedToken),
    launchAtLogin: currentConfig.launchAtLogin,
    extensionPath: getBundledExtensionPath(),
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
