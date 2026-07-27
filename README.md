# Glean Email Responder

DOM-first Chrome extension and backend for drafting Gmail replies with Glean.

The MVP proves this loop:

1. Open a Gmail thread and click Reply, or select a message in the Gmail inbox.
2. Press `Cmd+Shift+Y` on macOS or `Ctrl+Shift+Y` on Windows.
3. If needed, the extension opens the selected email, starts a reply, and extracts visible Gmail thread context from the DOM.
4. The extension sends structured context to the local backend.
5. The backend calls Glean Client API chat.
6. The returned plain-text draft is inserted into the active Gmail composer.

## Project Structure

- `extension/` - Chrome Manifest V3 extension, content script, background service worker, options page.
- `backend/` - Express TypeScript backend with `POST /draft-email-reply`.
- `helper-app/` - Electron desktop helper that runs the backend locally and stores the Glean token securely.
- `shared/` - Shared request and response TypeScript types.

## New Mac Setup

For a clean setup on a new computer, follow [`docs/setup-from-scratch.md`](docs/setup-from-scratch.md).

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

By default, the backend binds to `127.0.0.1` only. Set `BACKEND_SHARED_SECRET` for any non-helper local development setup and paste the same value into the extension options page.

## Extension Setup

```bash
npm run build -w @gmail-glean-reply-drafter/extension
```

Then load `extension/dist` in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click Load unpacked.
4. Select `extension/dist`.
5. Open the extension options page and set the backend URL, usually `http://127.0.0.1:8787`.

For local development, leave `BACKEND_SHARED_SECRET` blank only when you are testing a disposable dev backend. The packaged helper app generates and requires its own local pairing secret automatically.

## Desktop Helper App

For non-technical users, package the local backend as a desktop app. For distributable builds, use the release command to create the `.dmg` and copy it into the local release output folder:

```bash
npm run release:helper:mac
```

Use `npm run package:helper:mac` when you only need to rebuild the DMG in `helper-app/dist/`.

The generated macOS installer is written under:

```text
helper-app/dist/
```

The local release copy is written under:

```text
outputs/releases/
```

Generated DMGs are intentionally not committed to source history. Push a `helper-v*` tag to attach a DMG to a GitHub Release, or run the `Build Mac Helper` workflow manually to save a DMG as a GitHub Actions artifact.

The helper app:

- Runs the local backend on `http://127.0.0.1:8787`
- Binds the backend to `127.0.0.1` and requires a generated local extension pairing secret
- Stores the Glean Client API token with Electron secure storage
- Tests the Glean token before use
- Bundles the built Chrome extension, copies it to a writable install folder, and verifies the copied manifest version before opening Chrome setup
- Opens a one-click pairing link so the extension can save the backend URL and local secret automatically
- Records the extension version reported by Chrome during pairing, so an old loaded copy is visible in the helper status
- Lets the user clear the Glean token or rotate the local extension pairing secret
- Can start at login
- Shows Chrome extension setup steps

### Glean Token Setup For Users

In the helper app, ask the user to:

1. Open Glean in their browser.
2. Click the Glean logo in the bottom-left corner.
3. Open Admin Console or Settings.
4. Open API tokens.
5. Create a Client API token.
6. Add `CHAT` and `SEARCH` scopes. If your Glean admin exposes calendar action or Google Calendar access for Client API tokens, include it.
7. Copy the token and paste it into Gmail Glean Helper.

If the user does not see API tokens or calendar access, they likely need a Glean admin or developer to create the token or enable a calendar/free-busy action for Chat. This app does not connect to Google Calendar directly.

## Reply Settings

The helper app includes recommended defaults for drafting behavior:

- Response mode: `auto`, `fast`, or `thinking`. Auto uses Fast for short single-message emails and Thinking for longer, threaded, or scheduling-related conversations.
- Tone: `concise`, `warm`, `formal`, or `direct`.
- Length: `short`, `medium`, or `detailed`.
- Draft behavior: replace the composer text or append below it.
- Context: latest message only or the visible thread.
- Timeout: 15, 30, 45, or 90 seconds.
- Writing preferences: saved locally and added to every draft prompt.

For the Glean Chat API, Fast maps to `agentConfig.mode = QUICK`; Thinking maps to `agentConfig.mode = DEFAULT`. If a Glean instance rejects that mode field, the backend retries without it. Scheduling-related requests are forced to Thinking mode and instruct Glean to use any available calendar/free-busy action when available.

## Current MVP Behavior

- Works only on `mail.google.com`.
- Extracts visible DOM content only.
- On the inbox, the shortcut attempts to open the selected or first visible email, click Reply, and draft automatically.
- Replaces existing composer text when drafting or revising.
- Returns inline errors without clearing composer content.
- Inserts plain text into the focused Gmail editor.
- Never auto-sends.
- Shows exact Glean token/model metadata when the Chat API response includes it, otherwise falls back to approximate token counts. The authoritative place for exact model/provider/token accounting may be Glean customer event logs such as `LLM_CALL`.
- Vendor-list-price cost estimates are directional only and may not match Glean billing or contracted pricing.
- Does not request Gmail API scopes or calendar tokens. Calendar availability is requested only through Glean actions when Glean supports it.

## Useful Commands

```bash
npm run build
npm run typecheck
npm run dev:backend
npm run dev:helper
npm run package:helper:mac
npm run release:helper:mac
npm run clean
```
