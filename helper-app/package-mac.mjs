import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const helperDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(helperDir, "..");
const appName = "Gmail Glean Helper";
const bundleId = "com.gmailglean.replyhelper";
const packageJson = JSON.parse(await readFile(join(helperDir, "package.json"), "utf8"));
const appVersion = packageJson.version ?? "0.0.0";
const electronApp = resolve(rootDir, "node_modules", "electron", "dist", "Electron.app");
const electronInstaller = resolve(rootDir, "node_modules", "electron", "install.js");
const releaseDir = join(helperDir, "dist", "mac");
const appBundle = join(releaseDir, `${appName}.app`);
const resourcesDir = join(appBundle, "Contents", "Resources");
const appPayloadDir = join(resourcesDir, "app");
const plistBuddy = "/usr/libexec/PlistBuddy";
const plistPath = join(appBundle, "Contents", "Info.plist");
const dmgPath = join(helperDir, "dist", `${appName}-mac.dmg`);
const zipPath = join(helperDir, "dist", `${appName}-mac.zip`);

if (!existsSync(electronApp) && existsSync(electronInstaller)) {
  console.log("Electron.app was not found. Downloading the Electron runtime...");
  await execFileAsync(process.execPath, [electronInstaller]);
}

if (!existsSync(electronApp)) {
  throw new Error(
    `Electron.app was not found at ${electronApp}. Run npm install, or run node node_modules/electron/install.js and try again.`,
  );
}

if (!existsSync(join(rootDir, "extension", "dist", "manifest.json"))) {
  throw new Error("Built extension was not found. Run npm run build -w @gmail-glean-reply-drafter/extension first.");
}

await rm(releaseDir, { recursive: true, force: true });
await rm(dmgPath, { force: true });
await rm(zipPath, { force: true });
await mkdir(releaseDir, { recursive: true });

await execFileAsync("ditto", [electronApp, appBundle]);
await rm(join(resourcesDir, "default_app.asar"), { force: true });
await rm(join(resourcesDir, "electron.asar"), { force: true });
await mkdir(appPayloadDir, { recursive: true });

await mkdir(join(appPayloadDir, "dist"), { recursive: true });
await Promise.all(
  ["main.cjs", "preload.cjs", "renderer.js", "index.html"].map((file) =>
    cp(join(helperDir, "dist", file), join(appPayloadDir, "dist", file)),
  ),
);
await cp(join(rootDir, "extension", "dist"), join(resourcesDir, "extension"), { recursive: true });

await writeFile(
  join(appPayloadDir, "package.json"),
  JSON.stringify(
    {
      name: "gmail-glean-helper",
      version: appVersion,
      main: "dist/main.cjs",
      type: "commonjs",
    },
    null,
    2,
  ),
);

await updatePlist(plistPath, [
  ["Set", ":CFBundleDisplayName", appName],
  ["Set", ":CFBundleExecutable", "Electron"],
  ["Set", ":CFBundleIdentifier", bundleId],
  ["Set", ":CFBundleName", "Electron"],
  ["Set", ":CFBundleShortVersionString", appVersion],
  ["Set", ":CFBundleVersion", appVersion],
  ["Set", ":LSApplicationCategoryType", "public.app-category.productivity"],
]);
await deletePlistKey(plistPath, ":ElectronAsarIntegrity");
await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appBundle, zipPath]);
console.log(`Created ${zipPath}`);

await symlink("/Applications", join(releaseDir, "Applications"));

try {
  await execFileAsync("hdiutil", [
    "create",
    "-volname",
    appName,
    "-srcfolder",
    releaseDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
  console.log(`Created ${dmgPath}`);
} catch (error) {
  const detail = error instanceof Error && error.message ? error.message.split("\n")[0] : String(error);
  console.warn(`DMG creation was unavailable. The signed app zip is ready at ${zipPath}. ${detail}`);
}

async function updatePlist(path, entries) {
  for (const [command, key, value] of entries) {
    try {
      await execFileAsync(plistBuddy, ["-c", `${command} ${key} ${value}`, path]);
    } catch (error) {
      if (command !== "Set") throw error;
      await execFileAsync(plistBuddy, ["-c", `Add ${key} string ${value}`, path]);
    }
  }
}

async function deletePlistKey(path, key) {
  try {
    await execFileAsync(plistBuddy, ["-c", `Delete ${key}`, path]);
  } catch {
    // Electron versions without this key do not need any cleanup.
  }
}
