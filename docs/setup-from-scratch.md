# Setup From Scratch

Use this when setting up the project on a new Mac.

## 1. Install system tools

Install Apple command line tools:

```bash
xcode-select --install
```

Install Node.js LTS from the official macOS installer. Confirm both commands work:

```bash
node --version
npm --version
```

## 2. Get the code

```bash
git clone https://github.com/zdirani88/glean-email-responder.git
cd glean-email-responder
npm install
```

## 3. Local backend development

```bash
cp backend/.env.example backend/.env
npm run dev:backend
```

Stub mode is enabled in `backend/.env.example`, so the backend can start without a real Glean token. To call Glean for real, set:

```bash
GLEAN_STUB_MODE=false
GLEAN_SERVER_URL=https://your-instance-be.glean.com
GLEAN_API_TOKEN=your-client-api-token
```

## 4. Chrome extension development

```bash
npm run build -w @gmail-glean-reply-drafter/extension
```

Then open `chrome://extensions`, enable Developer Mode, click Load unpacked, and select:

```text
extension/dist
```

## 5. Mac helper app

For a test package:

```bash
npm run package:helper:mac
```

For a local release copy:

```bash
npm run release:helper:mac
```

The DMG is created at:

```text
helper-app/dist/Gmail Glean Helper-mac.dmg
```

The local release copy is written to:

```text
outputs/releases/
```

`outputs/` is intentionally ignored by Git. Do not commit generated DMGs to source history.

## 6. Save DMGs in GitHub

DMGs are saved through GitHub Actions.

To make a GitHub Release with a DMG attached:

```bash
git tag helper-v0.1.27
git push origin helper-v0.1.27
```

Replace `0.1.27` with the helper version in `helper-app/package.json`.

You can also run the `Build Mac Helper` workflow manually in GitHub Actions. Manual runs upload the DMG as a workflow artifact.

## 7. Clean local generated files

```bash
npm run clean
```

This removes generated `dist/` folders and local release copies. It does not remove `node_modules`.

To fully reset local dependencies:

```bash
rm -rf node_modules package-lock.json
git checkout -- package-lock.json
npm install
```

Only use that reset when dependency installation itself seems corrupted.

## 8. What should stay out of Git

Do not commit:

- `node_modules/`
- `.pnpm-store/`
- `dist/`
- `outputs/`
- `.env` files
- `.DS_Store`

Do commit:

- Source files
- `package.json`
- `package-lock.json`
- `backend/.env.example`
- GitHub workflow files
