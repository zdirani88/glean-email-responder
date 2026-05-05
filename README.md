# Gmail Glean Reply Drafter

DOM-first Chrome extension and backend for drafting Gmail replies with Glean.

The MVP proves this loop:

1. Open a Gmail thread and click Reply.
2. Press `Cmd+Shift+Y` on macOS or `Ctrl+Shift+Y` on Windows.
3. The extension extracts visible Gmail thread context from the DOM.
4. The extension sends structured context to the local backend.
5. The backend calls Glean Client API chat.
6. The returned plain-text draft is inserted into the active Gmail composer.

## Project Structure

- `extension/` - Chrome Manifest V3 extension, content script, background service worker, options page.
- `backend/` - Express TypeScript backend with `POST /draft-email-reply`.
- `helper-app/` - Electron desktop helper that runs the backend locally and stores the Glean token securely.
- `shared/` - Shared request and response TypeScript types.

## Backend Setup

```bash
cp backend/.env.example backend/.env
npm install
npm run dev:backend
```

For a local dry run, keep `GLEAN_STUB_MODE=true`. To call Glean, set:

```bash
GLEAN_STUB_MODE=false
GLEAN_SERVER_URL=https://your-instance-be.glean.com
GLEAN_API_TOKEN=your-user-scoped-token
```

The backend sends Glean chat requests to:

```text
POST /rest/api/v1/chat
Authorization: Bearer <GLEAN_API_TOKEN>
Content-Type: application/json
```

with:

```json
{
  "messages": [{ "author": "USER", "fragments": [{ "text": "..." }] }],
  "stream": false
}
```

The token is read only from backend environment variables and is never bundled into the extension.

## Extension Setup

```bash
npm run build -w @gmail-glean-reply-drafter/extension
```

Then load `extension/dist` in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click Load unpacked.
4. Select `extension/dist`.
5. Open the extension options page and set the backend URL, usually `http://localhost:8787`.

For local development, leave `BACKEND_SHARED_SECRET` blank. If you set it on the backend, enter the same value in the extension options page.

## Desktop Helper App

For non-technical users, package the local backend as a desktop app. For distributable builds, use the release command so the helper app patch version increments before the `.dmg` is created:

```bash
npm run release:helper:mac
```

Use `npm run package:helper:mac` only for throwaway local packaging tests when you do not want to bump the app version.

The generated macOS installer is written under:

```text
helper-app/dist/
```

The helper app:

- Runs the local backend on `http://localhost:8787`
- Stores the Glean Client API token with Electron secure storage
- Tests the Glean token before use
- Bundles the built Chrome extension and copies it to `~/Desktop/Gmail Glean Reply Extension` for Load unpacked setup
- Can start at login
- Shows Chrome extension setup steps

### Glean Token Setup For Users

In the helper app, ask the user to:

1. Open Glean in their browser.
2. Click the Glean logo in the bottom-left corner.
3. Open Admin Console or Settings.
4. Open API tokens.
5. Create a Client API token.
6. Add `CHAT` and `SEARCH` scopes.
7. Copy the token and paste it into Gmail Glean Helper.

If the user does not see API tokens, they likely need a Glean admin or developer to create the token.

## Current MVP Behavior

- Works only on `mail.google.com`.
- Extracts visible DOM content only.
- Replaces existing composer text when drafting or revising.
- Returns inline errors without clearing composer content.
- Inserts plain text into the focused Gmail editor.
- Never auto-sends.
- Does not request Gmail API scopes.

## Useful Commands

```bash
npm run build
npm run typecheck
npm run dev:backend
npm run dev:helper
npm run package:helper:mac
npm run release:helper:mac
```
