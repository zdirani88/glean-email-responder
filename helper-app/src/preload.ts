import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gmailGleanHelper", {
  getStatus: () => ipcRenderer.invoke("helper:get-status"),
  saveConfig: (input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean; gleanTimeoutMs?: number; replySettings?: unknown }) =>
    ipcRenderer.invoke("helper:save-config", input),
  testGlean: (input: { gleanServerUrl: string; token?: string }) => ipcRenderer.invoke("helper:test-glean", input),
  restartServer: () => ipcRenderer.invoke("helper:restart-server"),
  openExtensionFolder: () => ipcRenderer.invoke("helper:open-extension-folder"),
  copyManualPairingSettings: () => ipcRenderer.invoke("helper:copy-manual-pairing-settings"),
  clearGleanToken: () => ipcRenderer.invoke("helper:clear-glean-token"),
  rotateLocalSecret: () => ipcRenderer.invoke("helper:rotate-local-secret"),
});
