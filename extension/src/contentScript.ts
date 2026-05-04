import type { BackgroundResponse, ContentMessage } from "./types";
import {
  extractVisibleThreadForActiveComposer,
  findActiveComposer,
  getComposerRoot,
  insertDraft,
} from "./gmailAdapter";

let lastComposer: ReturnType<typeof findActiveComposer>;

chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  if (message.type === "DRAFT_REPLY_COMMAND") {
    void draftReply();
  }
});

document.addEventListener("keydown", (event) => {
  const shortcutPressed =
    (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "g";

  if (!shortcutPressed || !location.hostname.endsWith("mail.google.com")) return;

  const composer = findActiveComposer();
  if (!composer) return;

  event.preventDefault();
  event.stopPropagation();
  void draftReply();
});

async function draftReply() {
  const existingComposer = findActiveComposer();
  const userInstruction = getInstruction(existingComposer);
  const extraction = extractVisibleThreadForActiveComposer({ userInstruction });
  const composer = extraction.ok ? extraction.composer : extraction.composer ?? findActiveComposer();
  if (composer) lastComposer = composer;

  const ui = renderUi(composer);
  if (!extraction.ok) {
    ui.setError(extraction.error);
    return;
  }

  ui.setLoading("Drafting with Glean...");
  console.info("extraction_succeeded", {
    visibleMessageCount: extraction.payload.messages.length,
    requestId: extraction.payload.clientRequestId,
  });

  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_DRAFT",
    payload: extraction.payload,
  })) as BackgroundResponse;

  if (!response.ok) {
    ui.setError(response.error);
    return;
  }

  const targetComposer = lastComposer ?? extraction.composer;
  insertDraft(targetComposer, response.data.draft);
  ui.setSuccess(response.data.summary);
}

function renderUi(composer: ReturnType<typeof findActiveComposer>) {
  const root = composer ? getComposerRoot(composer) : document.body;
  let el = root.querySelector<HTMLElement>(".ggd-inline-ui");

  if (!el) {
    el = document.createElement("div");
    el.className = "ggd-inline-ui";
    el.innerHTML = `
      <style>
        .ggd-inline-ui {
          align-items: stretch;
          background: #ffffff;
          border: 1px solid #dadce0;
          border-radius: 6px;
          box-shadow: 0 1px 3px rgba(60, 64, 67, 0.18);
          color: #202124;
          display: grid;
          grid-template-columns: minmax(220px, 1fr) auto auto;
          font: 12px/1.4 Arial, sans-serif;
          gap: 8px;
          margin: 8px 0;
          max-width: 780px;
          padding: 7px 9px;
          z-index: 9999;
        }
        .ggd-inline-ui button {
          background: #1a73e8;
          border: 0;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          font: inherit;
          padding: 5px 8px;
        }
        .ggd-inline-ui button.secondary {
          background: #f1f3f4;
          color: #202124;
        }
        .ggd-inline-ui .message {
          grid-column: 1 / -1;
          min-width: 0;
        }
        .ggd-inline-ui textarea {
          border: 1px solid #dadce0;
          border-radius: 4px;
          box-sizing: border-box;
          color: #202124;
          font: 13px/1.35 Arial, sans-serif;
          min-height: 34px;
          padding: 7px 8px;
          resize: vertical;
          width: 100%;
        }
        .ggd-inline-ui.error {
          border-color: #f6aea9;
          color: #b3261e;
        }
      </style>
      <span class="message">Ready</span>
      <textarea class="instruction" placeholder="Optional: tell Glean how to steer or revise this reply"></textarea>
      <button type="button" class="draft">Draft reply</button>
      <button type="button" class="secondary regenerate">Regenerate</button>
    `;
    root.prepend(el);
    el.querySelector<HTMLButtonElement>(".draft")?.addEventListener("click", () => void draftReply());
    el.querySelector<HTMLButtonElement>(".regenerate")?.addEventListener("click", () => void draftReply());
  }

  const message = el.querySelector<HTMLElement>(".message");
  return {
    setLoading(text: string) {
      el.classList.remove("error");
      if (message) message.textContent = text;
    },
    setError(text: string) {
      el.classList.add("error");
      if (message) message.textContent = text;
    },
    setSuccess(text: string) {
      el.classList.remove("error");
      if (message) message.textContent = text;
    },
  };
}

function getInstruction(composer: ReturnType<typeof findActiveComposer>) {
  const root = composer ? getComposerRoot(composer) : document.body;
  return root.querySelector<HTMLTextAreaElement>(".ggd-inline-ui .instruction")?.value ?? "";
}
