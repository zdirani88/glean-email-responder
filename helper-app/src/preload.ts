import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gmailGleanHelper", {
  getStatus: () => ipcRenderer.invoke("helper:get-status"),
  saveConfig: (input: { gleanServerUrl: string; token?: string; launchAtLogin: boolean }) =>
    ipcRenderer.invoke("helper:save-config", input),
  testGlean: (input: { gleanServerUrl: string; token?: string }) => ipcRenderer.invoke("helper:test-glean", input),
  restartServer: () => ipcRenderer.invoke("helper:restart-server"),
  openUrl: (url: string) => ipcRenderer.invoke("helper:open-url", url),
  openExtensionFolder: () => ipcRenderer.invoke("helper:open-extension-folder"),
});
