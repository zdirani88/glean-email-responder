import type { BackgroundResponse, ContentMessage } from "./types";
import type { DraftRequestPayload, DraftResponsePayload, DraftVariant } from "@gmail-glean-reply-drafter/shared";
import {
  extractVisibleThreadForActiveComposer,
  findActiveComposer,
  getComposerRoot,
  insertDraft,
  openEmailAndReplyFromList,
} from "./gmailAdapter";

let lastComposer: ReturnType<typeof findActiveComposer>;
let lastDebugState: DebugState | undefined;

interface DebugState {
  request?: DraftRequestPayload;
  response?: DraftResponsePayload;
  error?: string;
  selectedVariantIndex?: number;
}


chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  if (message.type === "DRAFT_REPLY_COMMAND") {
    void draftReply();
  }
});

document.addEventListener("keydown", (event) => {
  const shortcutPressed =
    (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "y";

  if (!shortcutPressed || !location.hostname.endsWith("mail.google.com")) return;

  event.preventDefault();
  event.stopPropagation();
  void draftReply();
});

async function draftReply(instructionOverride = "") {
  const existingComposer = findActiveComposer();
  const userInstruction = combineInstructions(getInstruction(existingComposer), instructionOverride);
  const extraction = extractVisibleThreadForActiveComposer({ userInstruction });
  const composer = extraction.ok ? extraction.composer : extraction.composer ?? findActiveComposer();
  if (composer) lastComposer = composer;

  if (!extraction.ok) {
    if (!composer) {
      renderToast("Opening the selected email and preparing a reply...");
      const opened = await openEmailAndReplyFromList();
      if (!opened.ok) {
        renderToast(opened.error);
        return;
      }
      await wait(300);
      void draftReply();
      return;
    }

    const ui = renderUi(composer);
    ui.setError(extraction.error);
    return;
  }

  const ui = renderUi(composer);
  ui.setLoading("Drafting with Glean...");
  console.info("extraction_succeeded", {
    visibleMessageCount: extraction.payload.messages.length,
    requestId: extraction.payload.clientRequestId,
  });

  lastDebugState = { request: extraction.payload };
  ui.setDebugState(lastDebugState);

  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_DRAFT",
    payload: extraction.payload,
  })) as BackgroundResponse;

  if (!response.ok) {
    lastDebugState = { request: extraction.payload, error: response.error };
    ui.setDebugState(lastDebugState);
    ui.setError(response.error);
    return;
  }

  lastDebugState = { request: extraction.payload, response: response.data, selectedVariantIndex: response.data.selectedVariantIndex ?? 0 };
  ui.setDebugState(lastDebugState);

  const targetComposer = lastComposer ?? extraction.composer;
  const variants = response.data.variants?.length ? response.data.variants : [{ draft: response.data.draft, label: "Draft 1" }];
  const selectedIndex = response.data.selectedVariantIndex ?? 0;
  insertDraft(targetComposer, variants[selectedIndex]?.draft ?? response.data.draft, response.data.overwriteBehavior);
  ui.setSuccess(response.data.summary);
  ui.setVariants(variants, targetComposer, selectedIndex);
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
          align-items: center;
          background: rgba(255, 255, 255, 0.96);
          border: 1px solid #dfe3ea;
          border-radius: 12px;
          box-shadow: 0 10px 28px rgba(32, 33, 36, 0.12), 0 1px 2px rgba(32, 33, 36, 0.10);
          color: #202124;
          display: grid;
          grid-template-columns: auto minmax(260px, 1fr) auto auto auto auto;
          font: 13px/1.35 Arial, sans-serif;
          gap: 10px;
          margin: 10px 0;
          max-width: min(860px, calc(100vw - 64px));
          padding: 10px;
          z-index: 9999;
        }
        .ggd-inline-ui .brand {
          align-items: center;
          color: #3c4043;
          display: inline-flex;
          font-size: 12px;
          font-weight: 700;
          gap: 7px;
          min-width: max-content;
        }
        .ggd-inline-ui .close {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 999px;
          box-shadow: none;
          color: #5f6368;
          cursor: pointer;
          display: inline-flex;
          font: 700 18px/1 Arial, sans-serif;
          height: 28px;
          justify-content: center;
          min-width: 28px;
          padding: 0;
          width: 28px;
        }
        .ggd-inline-ui .close svg {
          height: 16px;
          width: 16px;
        }
        .ggd-inline-ui .close:hover {
          background: #f1f3f4;
          box-shadow: none;
          color: #202124;
        }
        .ggd-inline-ui .spark {
          align-items: center;
          background: #eef4ff;
          border: 1px solid #d7e5ff;
          border-radius: 999px;
          color: #1967d2;
          display: inline-flex;
          height: 24px;
          justify-content: center;
          width: 24px;
        }
        .ggd-inline-ui button {
          align-items: center;
          background: #1a73e8;
          border: 0;
          border-radius: 9px;
          box-shadow: 0 1px 2px rgba(26, 115, 232, 0.24);
          color: white;
          cursor: pointer;
          display: inline-flex;
          font: 700 13px/1 Arial, sans-serif;
          height: 38px;
          justify-content: center;
          min-width: 78px;
          padding: 0 14px;
          transition: background 120ms ease, box-shadow 120ms ease, transform 120ms ease;
        }
        .ggd-inline-ui button:hover {
          background: #1765cc;
          box-shadow: 0 2px 5px rgba(26, 115, 232, 0.28);
        }
        .ggd-inline-ui button:active {
          transform: translateY(1px);
        }
        .ggd-inline-ui button:disabled {
          cursor: default;
          opacity: 0.68;
          transform: none;
        }
        .ggd-inline-ui button.secondary {
          background: #f5f7fb;
          box-shadow: inset 0 0 0 1px #e3e7ee;
          color: #3c4043;
        }
        .ggd-inline-ui button.secondary:hover {
          background: #edf1f7;
        }
        .ggd-inline-ui .message {
          align-items: center;
          color: #5f6368;
          display: flex;
          font-size: 12px;
          gap: 8px;
          grid-column: 2 / -1;
          min-height: 16px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: normal;
        }
        .ggd-inline-ui .variants {
          align-items: center;
          display: none;
          gap: 8px;
          grid-column: 2 / -1;
        }
        .ggd-inline-ui .debug-panel {
          background: #f8fafc;
          border: 1px solid #e3e7ee;
          border-radius: 10px;
          display: none;
          gap: 10px;
          grid-column: 1 / -1;
          padding: 10px;
        }
        .ggd-inline-ui.debug-open .debug-panel {
          display: grid;
        }
        .ggd-inline-ui .debug-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: 1fr 1fr;
        }
        .ggd-inline-ui .debug-box {
          background: #ffffff;
          border: 1px solid #e3e7ee;
          border-radius: 8px;
          box-sizing: border-box;
          color: #3c4043;
          font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          max-height: 180px;
          min-height: 110px;
          overflow: auto;
          padding: 10px;
          white-space: pre-wrap;
        }
        .ggd-inline-ui .debug-panel label {
          color: #3c4043;
          display: grid;
          font-size: 12px;
          font-weight: 700;
          gap: 6px;
        }
        .ggd-inline-ui .debug-actions {
          align-items: center;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .ggd-inline-ui.has-variants .variants {
          display: flex;
        }
        .ggd-inline-ui .variant-count {
          color: #5f6368;
          font-size: 12px;
          min-width: max-content;
        }
        .ggd-inline-ui .variant-button {
          background: #f5f7fb;
          box-shadow: inset 0 0 0 1px #e3e7ee;
          color: #3c4043;
          height: 30px;
          min-width: 34px;
          padding: 0 10px;
        }
        .ggd-inline-ui .message strong {
          color: #202124;
        }
        .ggd-inline-ui .message .muted {
          color: #6f7681;
        }
        .ggd-inline-ui .spinner {
          animation: ggdSpin 900ms linear infinite;
          border: 2px solid #d8e2f3;
          border-top-color: #1a73e8;
          border-radius: 999px;
          box-sizing: border-box;
          display: inline-block;
          flex: 0 0 auto;
          height: 14px;
          width: 14px;
        }
        .ggd-inline-ui textarea {
          background: #f8fafc;
          border: 1px solid #dfe3ea;
          border-radius: 10px;
          box-sizing: border-box;
          color: #202124;
          font: 13px/1.35 Arial, sans-serif;
          height: 38px;
          min-height: 38px;
          padding: 10px 12px;
          resize: vertical;
          transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, height 120ms ease;
          width: 100%;
        }
        .ggd-inline-ui textarea::placeholder {
          color: #8a9099;
        }
        .ggd-inline-ui textarea:focus {
          background: #ffffff;
          border-color: #8ab4f8;
          box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
          height: 68px;
          outline: none;
        }
        .ggd-inline-ui.error {
          border-color: #f2b8b5;
          box-shadow: 0 10px 28px rgba(179, 38, 30, 0.12), 0 1px 2px rgba(32, 33, 36, 0.10);
        }
        .ggd-inline-ui.error .message {
          color: #b3261e;
        }
        .ggd-inline-ui.loading .spark {
          animation: ggdPulse 1s ease-in-out infinite;
          background: #e8f0fe;
        }
        @keyframes ggdPulse {
          0%, 100% { opacity: 0.72; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.06); }
        }
        @keyframes ggdSpin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 720px) {
          .ggd-inline-ui {
            grid-template-columns: 1fr auto;
          }
          .ggd-inline-ui .brand {
            grid-column: 1 / 2;
          }
          .ggd-inline-ui textarea {
            grid-column: 1 / -1;
          }
          .ggd-inline-ui .close {
            grid-column: 2 / 3;
            grid-row: 1 / 2;
          }
          .ggd-inline-ui .message,
          .ggd-inline-ui .variants,
          .ggd-inline-ui .debug-panel {
            grid-column: 1 / -1;
          }
          .ggd-inline-ui .debug-grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <div class="brand"><span class="spark">G</span><span>Glean reply</span></div>
      <textarea class="instruction" placeholder="Add guidance or revision notes"></textarea>
      <button type="button" class="draft">Draft</button>
      <button type="button" class="secondary regenerate">Revise</button>
      <button type="button" class="secondary debug-toggle" title="Open debug assistant">Debug</button>
      <button type="button" class="close" title="Close" aria-label="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M5.8 5.8 14.2 14.2M14.2 5.8 5.8 14.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
      <span class="message">Ready when you are.</span>
      <div class="variants" aria-live="polite">
        <button type="button" class="variant-button previous" title="Previous draft" aria-label="Previous draft">‹</button>
        <span class="variant-count">Draft 1 of 1</span>
        <button type="button" class="variant-button next" title="Next draft" aria-label="Next draft">›</button>
      </div>
      <div class="debug-panel">
        <div class="debug-grid">
          <label>Last request payload<pre class="debug-box request-debug">No request yet.</pre></label>
          <label>Last response or error<pre class="debug-box response-debug">No response yet.</pre></label>
        </div>
        <label>Improve this draft
          <textarea class="debug-instruction" placeholder="Example: make this warmer, remove the scheduling caveat, and keep it under 4 sentences"></textarea>
        </label>
        <div class="debug-actions">
          <button type="button" class="secondary copy-debug">Copy debug</button>
          <button type="button" class="improve-debug">Improve draft</button>
        </div>
      </div>
    `;
    root.prepend(el);
    el.querySelector<HTMLButtonElement>(".draft")?.addEventListener("click", () => void draftReply());
    el.querySelector<HTMLButtonElement>(".regenerate")?.addEventListener("click", () => void draftReply());
    const uiEl = el;
    el.querySelector<HTMLButtonElement>(".debug-toggle")?.addEventListener("click", () => uiEl.classList.toggle("debug-open"));
    el.querySelector<HTMLButtonElement>(".improve-debug")?.addEventListener("click", () => {
      const instruction = uiEl.querySelector<HTMLTextAreaElement>(".debug-instruction")?.value.trim() ?? "";
      if (instruction) void draftReply(instruction);
    });
    el.querySelector<HTMLButtonElement>(".copy-debug")?.addEventListener("click", () => {
      void navigator.clipboard?.writeText(formatDebugState(lastDebugState));
    });
    el.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", () => uiEl.remove());
  }

  const message = el.querySelector<HTMLElement>(".message");
  const variantCount = el.querySelector<HTMLElement>(".variant-count");
  const previousVariant = el.querySelector<HTMLButtonElement>(".previous");
  const nextVariant = el.querySelector<HTMLButtonElement>(".next");
  const requestDebug = el.querySelector<HTMLElement>(".request-debug");
  const responseDebug = el.querySelector<HTMLElement>(".response-debug");
  let variants: Array<{ draft: string; label: string }> = [];
  let selectedVariantIndex = 0;
  let variantComposer: ReturnType<typeof findActiveComposer> | undefined;
  const applyVariant = (nextIndex: number) => {
    if (!variantComposer || variants.length < 1) return;
    selectedVariantIndex = (nextIndex + variants.length) % variants.length;
    const selectedVariant = variants[selectedVariantIndex];
    if (!selectedVariant) return;
    insertDraft(variantComposer, selectedVariant.draft, "replace");
    if (variantCount) variantCount.textContent = `${selectedVariant.label} of ${variants.length}`;
    if (lastDebugState) lastDebugState.selectedVariantIndex = selectedVariantIndex;
    renderDebugState(requestDebug, responseDebug, lastDebugState);
  };
  if (previousVariant) previousVariant.onclick = () => applyVariant(selectedVariantIndex - 1);
  if (nextVariant) nextVariant.onclick = () => applyVariant(selectedVariantIndex + 1);
  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("button:not(.close)"));
  return {
    setLoading(text: string) {
      el.classList.remove("error");
      el.classList.add("loading");
      el.classList.remove("has-variants");
      buttons.forEach((button) => {
        button.disabled = true;
      });
      if (message) {
        message.innerHTML = `<span class="spinner" aria-hidden="true"></span><strong>${escapeHtml(text)}</strong><span class="muted">This usually takes a few seconds.</span>`;
      }
    },
    setError(text: string) {
      el.classList.remove("loading");
      el.classList.add("error");
      buttons.forEach((button) => {
        button.disabled = false;
      });
      if (message) message.innerHTML = formatErrorMessage(text);
    },
    setSuccess(text: string) {
      el.classList.remove("error", "loading");
      buttons.forEach((button) => {
        button.disabled = false;
      });
      if (message) message.textContent = text;
    },
    setDebugState(state: DebugState) {
      renderDebugState(requestDebug, responseDebug, state);
    },
    setVariants(nextVariants: DraftVariant[], composerTarget: ReturnType<typeof findActiveComposer>, selectedIndex: number) {
      variants = nextVariants;
      selectedVariantIndex = selectedIndex;
      variantComposer = composerTarget;
      el.classList.toggle("has-variants", variants.length > 1);
      if (variantCount) {
        variantCount.textContent = `${variants[selectedVariantIndex]?.label ?? "Draft 1"} of ${variants.length}`;
      }
      renderDebugState(requestDebug, responseDebug, lastDebugState);
    },
  };
}

function combineInstructions(primary: string, override: string) {
  return [primary.trim(), override.trim()].filter(Boolean).join("\n\nAdditional revision request:\n");
}

function renderDebugState(requestDebug: HTMLElement | null, responseDebug: HTMLElement | null, state: DebugState | undefined) {
  if (requestDebug) requestDebug.textContent = state?.request ? JSON.stringify(redactDebugPayload(state.request), null, 2) : "No request yet.";
  if (responseDebug) {
    responseDebug.textContent = state?.response
      ? JSON.stringify({
          selectedVariantIndex: state.selectedVariantIndex ?? state.response.selectedVariantIndex,
          effectiveGleanMode: state.response.effectiveGleanMode,
          summary: state.response.summary,
          variants: state.response.variants,
          warnings: state.response.warnings,
          requestId: state.response.requestId,
        }, null, 2)
      : state?.error
        ? state.error
        : "No response yet.";
  }
}

function formatDebugState(state: DebugState | undefined) {
  return JSON.stringify({
    request: state?.request ? redactDebugPayload(state.request) : undefined,
    response: state?.response,
    error: state?.error,
    selectedVariantIndex: state?.selectedVariantIndex,
  }, null, 2);
}

function redactDebugPayload(payload: DraftRequestPayload) {
  return {
    ...payload,
    pageUrl: payload.pageUrl.replace(/[#?].*$/, ""),
  };
}

function formatErrorMessage(text: string) {
  const [title, ...rest] = text.split(":");
  const detail = rest.join(":").trim();
  if (!detail) return escapeHtml(text);
  return `<strong>${escapeHtml(title ?? "Error")}:</strong> <span>${escapeHtml(detail)}</span>`;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getInstruction(composer: ReturnType<typeof findActiveComposer>) {
  const root = composer ? getComposerRoot(composer) : document.body;
  return root.querySelector<HTMLTextAreaElement>(".ggd-inline-ui .instruction")?.value ?? "";
}

function renderToast(text: string) {
  document.querySelector<HTMLElement>(".ggd-toast")?.remove();

  const toast = document.createElement("div");
  toast.className = "ggd-toast";
  toast.innerHTML = `
    <style>
      .ggd-toast {
        align-items: flex-start;
        background: #ffffff;
        border: 1px solid #dfe3ea;
        border-left: 4px solid #1a73e8;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(32, 33, 36, 0.18), 0 1px 2px rgba(32, 33, 36, 0.12);
        color: #202124;
        display: grid;
        font: 13px/1.4 Arial, sans-serif;
        gap: 12px;
        grid-template-columns: auto 1fr auto;
        left: 50%;
        max-width: min(480px, calc(100vw - 32px));
        min-width: min(420px, calc(100vw - 32px));
        padding: 14px 14px 14px 16px;
        position: fixed;
        top: 18px;
        transform: translateX(-50%);
        z-index: 2147483647;
      }
      .ggd-toast .spark {
        align-items: center;
        background: #eef4ff;
        border: 1px solid #d7e5ff;
        border-radius: 999px;
        color: #1967d2;
        display: inline-flex;
        font-weight: 700;
        height: 24px;
        justify-content: center;
        width: 24px;
      }
      .ggd-toast .copy {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .ggd-toast .title {
        color: #202124;
        font-weight: 700;
      }
      .ggd-toast .detail {
        color: #5f6368;
      }
      .ggd-toast .close {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 999px;
        color: #5f6368;
        cursor: pointer;
        display: inline-flex;
        font: 700 18px/1 Arial, sans-serif;
        height: 28px;
        justify-content: center;
        padding: 0;
        width: 28px;
      }
      .ggd-toast .close svg {
        height: 16px;
        width: 16px;
      }
      .ggd-toast .close:hover {
        background: #f1f3f4;
        color: #202124;
      }
    </style>
    <span class="spark">G</span>
    <span class="copy"><span class="title">No active reply box</span><span class="detail">${escapeHtml(text)}</span></span>
    <button type="button" class="close" title="Close" aria-label="Close">
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M5.8 5.8 14.2 14.2M14.2 5.8 5.8 14.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>
  `;

  document.body.append(toast);
  toast.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", () => toast.remove());
  window.setTimeout(() => toast.remove(), 6000);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}
