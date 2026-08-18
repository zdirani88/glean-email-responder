import type { BackgroundResponse, ContentMessage } from "./types";
import type { DraftResponsePayload, DraftVariant, OverwriteBehavior, WebDraftRequestPayload } from "@gmail-glean-reply-drafter/shared";
import {
  extractVisibleThreadForActiveComposer,
  findActiveComposer,
  getComposerDraftText,
  extractNewEmailForActiveComposer,
  insertNewEmailDraft,
  openEmailAndReplyFromList,
} from "./gmailAdapter";
import {
  extractVisibleSlackContextForActiveComposer,
  findActiveSlackComposer,
  getSlackComposerDraftText,
  insertSlackDraft,
} from "./slackAdapter";
import {
  extractWebContext,
  findActiveWebComposer,
  getWebComposerDraftText,
  insertWebDraft,
  isWebComposerUsable,
} from "./webAdapter";

type ComposerTarget = { editor: HTMLElement; root: HTMLElement };
type DraftSurface = "gmail" | "slack" | "web";

let lastComposer: ComposerTarget | undefined;
let pendingWebContext: WebDraftRequestPayload | undefined;
let draftRequestSequence = 0;
let lastPanelOpenAt = 0;

interface VariantUiState {
  variants: DraftVariant[];
  selectedVariantIndex: number;
  variantComposer: ComposerTarget | undefined;
  originalComposerText: string;
  overwriteBehavior: OverwriteBehavior;
  surface: DraftSurface;
}

type GgdUiElement = HTMLElement & { __ggdVariantState?: VariantUiState };


chrome.runtime.onMessage.addListener((message: ContentMessage) => {
  if (message.type === "DRAFT_REPLY_COMMAND") {
    void openDraftPanel();
  }
});

document.addEventListener("keydown", (event) => {
  const shortcutPressed =
    (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "y";

  if (!shortcutPressed) return;

  event.preventDefault();
  event.stopPropagation();
  void openDraftPanel();
});

async function openDraftPanel() {
  const now = Date.now();
  if (now - lastPanelOpenAt < 250) return;
  lastPanelOpenAt = now;

  if (isSlackSurface()) {
    openSlackDraftPanel();
    return;
  }

  if (!isGmailSurface()) {
    openWebDraftPanel();
    return;
  }

  const existingComposer = findActiveComposer();
  if (existingComposer) {
    lastComposer = existingComposer;
    const ui = renderUi(existingComposer);
    const replyContext = extractVisibleThreadForActiveComposer();
    ui.setReady(replyContext.ok ? "Add context, then press Enter or click Draft." : "Describe the new email, then press Enter or click Draft.");
    ui.setPlaceholder(replyContext.ok ? "Add context or revision notes, then press Enter" : "What should this email accomplish?");
    ui.focusInstruction();
    return;
  }

  renderToast("Opening the selected email and preparing a reply...");
  const opened = await openEmailAndReplyFromList();
  if (!opened.ok) {
    renderToast(opened.error);
    return;
  }

  await wait(300);
  const composer = findActiveComposer();
  if (!composer) {
    renderToast("Reply box is open, but I could not focus it yet. Click the reply box and press the shortcut again.");
    return;
  }

  lastComposer = composer;
  const ui = renderUi(composer);
  ui.setReady("Add context, then press Enter or click Draft.");
  ui.setPlaceholder("Add context or revision notes, then press Enter");
  ui.focusInstruction();
}

function openWebDraftPanel() {
  draftRequestSequence += 1;
  const composer = findActiveWebComposer();
  lastComposer = composer;
  pendingWebContext = extractWebContext({ composer });
  const ui = renderUi(composer);
  ui.reset();
  ui.setReady(composer ? "Page context ready. Add guidance, then draft." : "Page context ready. The result will be available to copy.");
  ui.setPlaceholder("What response should Glean draft?");
  ui.focusInstruction();
}

function openSlackDraftPanel() {
  const composer = findActiveSlackComposer();
  if (!composer) {
    renderToast("Open a Slack message box or thread reply box, then press the shortcut again.");
    return;
  }

  lastComposer = composer;
  const ui = renderUi(composer);
  ui.setReady("Add context, then press Enter or click Draft.");
  ui.setPlaceholder("Add context or revision notes, then press Enter");
  ui.focusInstruction();
}

async function draftReply(instructionOverride = "") {
  if (isSlackSurface()) {
    await draftSlackReply(instructionOverride);
    return;
  }
  if (!isGmailSurface()) {
    await draftWebResponse(instructionOverride);
    return;
  }

  const requestSequence = ++draftRequestSequence;

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
      if (requestSequence !== draftRequestSequence) return;
      void openDraftPanel();
      return;
    }

    if (extraction.error.includes("visible message")) {
      await draftNewEmail(instructionOverride, requestSequence);
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

  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_DRAFT",
    payload: extraction.payload,
  })) as BackgroundResponse;

  if (requestSequence !== draftRequestSequence) return;

  if (!response.ok) {
    ui.setError(response.error);
    return;
  }

  const targetComposer = extraction.composer;
  if (!isComposerUsable(targetComposer)) {
    ui.setError("The original Gmail composer is no longer available. Open the compose box and try again.");
    return;
  }

  const variants = response.data.variants?.length ? response.data.variants : [createFallbackVariant(response.data.draft, response.data.subject)];
  const selectedIndex = response.data.selectedVariantIndex ?? 0;
  const originalComposerText = getComposerDraftText(targetComposer);
  insertNewEmailDraft(targetComposer, variants[selectedIndex]?.draft ?? response.data.draft, variants[selectedIndex]?.subject ?? response.data.subject, response.data.overwriteBehavior);
  ui.setSuccess(response.data.summary);
  ui.setGroundingState(response.data);
  ui.setVariants(variants, targetComposer, selectedIndex, response.data.overwriteBehavior, originalComposerText);
}

async function draftNewEmail(instructionOverride = "", requestSequence = ++draftRequestSequence) {
  const existingComposer = findActiveComposer();
  const userInstruction = combineInstructions(getInstruction(existingComposer), instructionOverride);
  const extraction = extractNewEmailForActiveComposer({ userInstruction });
  const composer = extraction.ok ? extraction.composer : extraction.composer ?? findActiveComposer();
  if (composer) lastComposer = composer;

  if (!extraction.ok) {
    if (composer) {
      const ui = renderUi(composer);
      ui.setPlaceholder("What should this email accomplish?");
      ui.setError(extraction.error);
      return;
    }
    renderToast(extraction.error);
    return;
  }

  const ui = renderUi(extraction.composer);
  ui.setPlaceholder("What should this email accomplish?");
  ui.setLoading("Drafting new email with Glean...");
  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_NEW_EMAIL_DRAFT",
    payload: extraction.payload,
  })) as BackgroundResponse;

  if (requestSequence !== draftRequestSequence) return;

  if (!response.ok) {
    ui.setError(response.error);
    return;
  }

  const targetComposer = extraction.composer;
  if (!isComposerUsable(targetComposer)) {
    ui.setError("The original Gmail composer is no longer available. Open the compose box and try again.");
    return;
  }

  const variants = response.data.variants?.length ? response.data.variants : [createFallbackVariant(response.data.draft, response.data.subject)];
  const selectedIndex = response.data.selectedVariantIndex ?? 0;
  const selected = variants[selectedIndex] ?? variants[0];
  const originalComposerText = getComposerDraftText(targetComposer);
  insertNewEmailDraft(targetComposer, selected?.draft ?? response.data.draft, selected?.subject ?? response.data.subject, response.data.overwriteBehavior);
  ui.setSuccess(response.data.summary);
  ui.setGroundingState(response.data);
  ui.setVariants(variants, targetComposer, selectedIndex, response.data.overwriteBehavior, originalComposerText);
}

async function draftSlackReply(instructionOverride = "") {
  const requestSequence = ++draftRequestSequence;
  const existingComposer = findActiveSlackComposer();
  const userInstruction = combineInstructions(getInstruction(existingComposer), instructionOverride);
  const extraction = extractVisibleSlackContextForActiveComposer({ userInstruction });
  const composer = extraction.ok ? extraction.composer : extraction.composer ?? findActiveSlackComposer();
  if (composer) lastComposer = composer;

  if (!extraction.ok) {
    if (composer) {
      const ui = renderUi(composer);
      ui.setError(extraction.error);
      return;
    }
    renderToast(extraction.error);
    return;
  }

  const ui = renderUi(extraction.composer);
  ui.setLoading("Drafting Slack response with Glean...");
  console.info("slack_extraction_succeeded", {
    visibleMessageCount: extraction.payload.messages.length,
    requestId: extraction.payload.clientRequestId,
  });

  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_SLACK_DRAFT",
    payload: extraction.payload,
  })) as BackgroundResponse;

  if (requestSequence !== draftRequestSequence) return;

  if (!response.ok) {
    ui.setError(response.error);
    return;
  }

  const targetComposer = extraction.composer;
  if (!isComposerUsable(targetComposer)) {
    ui.setError("The original Slack composer is no longer available. Open the message box and try again.");
    return;
  }

  const variants = response.data.variants?.length ? response.data.variants : [createFallbackVariant(response.data.draft, response.data.subject)];
  const selectedIndex = response.data.selectedVariantIndex ?? 0;
  const originalComposerText = getDraftText(targetComposer, "slack");
  insertDraftForSurface(targetComposer, variants[selectedIndex]?.draft ?? response.data.draft, undefined, response.data.overwriteBehavior, "slack");
  ui.setSuccess(response.data.summary);
  ui.setGroundingState(response.data);
  ui.setVariants(variants, targetComposer, selectedIndex, response.data.overwriteBehavior, originalComposerText, "slack");
}

async function draftWebResponse(instructionOverride = "") {
  const requestSequence = ++draftRequestSequence;
  const discoveredComposer = findActiveWebComposer();
  const composer = discoveredComposer ?? (lastComposer && isWebComposerUsable(lastComposer) ? lastComposer : undefined);
  lastComposer = composer;
  const ui = renderUi(composer);
  const userInstruction = combineInstructions(getInstruction(composer), instructionOverride);
  const freshContext = extractWebContext({ userInstruction, composer });
  const capturedSelection = pendingWebContext?.pageUrl === freshContext.pageUrl ? pendingWebContext.selectedText : "";
  const payload: WebDraftRequestPayload = {
    ...freshContext,
    selectedText: freshContext.selectedText || capturedSelection,
    userInstruction: userInstruction || freshContext.userInstruction,
  };
  pendingWebContext = undefined;
  ui.setLoading("Drafting from this page with Glean...");

  const response = (await chrome.runtime.sendMessage({
    type: "REQUEST_WEB_DRAFT",
    payload,
  })) as BackgroundResponse;
  if (requestSequence !== draftRequestSequence) return;

  if (!response.ok) {
    ui.setError(response.error);
    return;
  }

  const variants = response.data.variants?.length ? response.data.variants : [createFallbackVariant(response.data.draft)];
  const selectedIndex = response.data.selectedVariantIndex ?? 0;
  const selected = variants[selectedIndex] ?? variants[0];
  const draft = selected?.draft ?? response.data.draft;
  let targetComposer = composer;
  let originalComposerText = targetComposer ? getWebComposerDraftText(targetComposer) : "";
  let inserted = false;
  if (targetComposer && isWebComposerUsable(targetComposer)) {
    insertWebDraft(targetComposer, draft, response.data.overwriteBehavior);
    await wait(80);
    inserted = webDraftWasInserted(targetComposer, draft);
  }
  if (!inserted) {
    const retryComposer = findActiveWebComposer() ?? targetComposer;
    if (retryComposer && isWebComposerUsable(retryComposer)) {
      if (retryComposer.editor !== targetComposer?.editor) {
        originalComposerText = getWebComposerDraftText(retryComposer);
      }
      targetComposer = retryComposer;
      lastComposer = retryComposer;
      insertWebDraft(retryComposer, draft, response.data.overwriteBehavior);
      await wait(80);
      inserted = webDraftWasInserted(retryComposer, draft);
    }
  }
  ui.setSuccess(inserted ? response.data.summary : `${response.data.summary} I could not insert it reliably, so copy the result below.`);
  ui.setGroundingState(response.data);
  ui.setVariants(variants, inserted ? targetComposer : undefined, selectedIndex, response.data.overwriteBehavior, originalComposerText, "web");
}

function renderUi(composer: ComposerTarget | undefined) {
  const floating = isSlackSurface() || !isGmailSurface();
  const root = floating ? document.body : composer?.root ?? document.body;
  let el = root.querySelector<GgdUiElement>(".ggd-inline-ui");

  if (!el) {
    el = document.createElement("div") as GgdUiElement;
    el.className = `ggd-inline-ui${floating ? " floating" : ""}`;
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
          grid-template-columns: auto minmax(260px, 1fr) auto auto auto;
          font: 13px/1.35 Arial, sans-serif;
          gap: 10px;
          margin: 10px 0;
          max-width: min(860px, calc(100vw - 64px));
          padding: 10px;
          z-index: 9999;
        }
        .ggd-inline-ui.hidden {
          display: none;
        }
        .ggd-inline-ui.floating {
          bottom: 18px;
          box-sizing: border-box;
          left: auto;
          margin: 0;
          max-height: min(560px, calc(100vh - 36px));
          max-width: min(720px, calc(100vw - 36px));
          overflow: auto;
          position: fixed;
          right: 18px;
          width: min(720px, calc(100vw - 36px));
          z-index: 2147483647;
        }
        .ggd-inline-ui.floating .brand {
          cursor: move;
          user-select: none;
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
        .ggd-inline-ui.has-draft .variants {
          display: flex;
        }
        .ggd-inline-ui .sources {
          background: #f8fafc;
          border: 1px solid #e3e7ee;
          border-radius: 10px;
          display: none;
          gap: 8px;
          grid-column: 1 / -1;
          padding: 10px;
        }
        .ggd-inline-ui.has-draft .sources {
          display: grid;
        }
        .ggd-inline-ui .sources-title {
          color: #3c4043;
          font-size: 12px;
          font-weight: 700;
        }
        .ggd-inline-ui .sources-list {
          display: grid;
          gap: 6px;
        }
        .ggd-inline-ui .source-item {
          color: #5f6368;
          font-size: 12px;
          line-height: 1.35;
        }
        .ggd-inline-ui .source-item strong {
          color: #202124;
        }
        .ggd-inline-ui .source-warning {
          background: #fff8e1;
          border: 1px solid #f9dc8c;
          border-radius: 8px;
          color: #5f4700;
          font-size: 12px;
          line-height: 1.35;
          padding: 8px 10px;
        }
        .ggd-inline-ui .result {
          align-items: start;
          background: #f8fafc;
          border: 1px solid #e3e7ee;
          border-radius: 10px;
          display: none;
          gap: 10px;
          grid-column: 1 / -1;
          grid-template-columns: 1fr auto;
          padding: 10px;
        }
        .ggd-inline-ui.web-result .result {
          display: grid;
        }
        .ggd-inline-ui .result-text {
          color: #202124;
          font-size: 13px;
          line-height: 1.45;
          max-height: 180px;
          overflow: auto;
          white-space: pre-wrap;
        }
        .ggd-inline-ui .variant-button:disabled {
          opacity: 0.42;
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
          .ggd-inline-ui .sources,
          .ggd-inline-ui .result {
            grid-column: 1 / -1;
          }
        }
      </style>
      <div class="brand" title="Drag to move"><span class="spark">G</span><span>Glean reply</span></div>
      <textarea class="instruction" rows="1" placeholder="Add context or revision notes, then press Enter"></textarea>
      <button type="button" class="draft">Draft</button>
      <button type="button" class="secondary regenerate">Revise</button>
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
      <div class="sources" aria-live="polite">
        <span class="sources-title">Used for this draft</span>
        <div class="sources-list">No draft yet.</div>
      </div>
      <div class="result" aria-live="polite">
        <div class="result-text"></div>
        <button type="button" class="secondary copy-result">Copy</button>
      </div>
    `;
    root.prepend(el);
    const instructionEl = el.querySelector<HTMLTextAreaElement>(".instruction");
    el.querySelector<HTMLButtonElement>(".draft")?.addEventListener("click", () => void draftReply());
    el.querySelector<HTMLButtonElement>(".regenerate")?.addEventListener("click", () => void draftReply());
    instructionEl?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void draftReply();
    });
    const uiEl = el;
    el.querySelector<HTMLButtonElement>(".copy-result")?.addEventListener("click", async () => {
      const value = uiEl.querySelector<HTMLElement>(".result-text")?.textContent ?? "";
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        const status = uiEl.querySelector<HTMLElement>(".message");
        if (status) status.textContent = "Draft copied to clipboard.";
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        const result = uiEl.querySelector<HTMLElement>(".result-text");
        if (result) {
          range.selectNodeContents(result);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    });
    el.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", () => {
      if (uiEl.classList.contains("floating")) {
        uiEl.classList.add("hidden");
        return;
      }
      uiEl.remove();
    });
    setupDraggablePanel(el);
  }

  el.classList.remove("hidden");
  el.classList.toggle("floating", floating);

  const instruction = el.querySelector<HTMLTextAreaElement>(".instruction");
  const draftButton = el.querySelector<HTMLButtonElement>(".draft");
  const message = el.querySelector<HTMLElement>(".message");
  const variantCount = el.querySelector<HTMLElement>(".variant-count");
  const previousVariant = el.querySelector<HTMLButtonElement>(".previous");
  const nextVariant = el.querySelector<HTMLButtonElement>(".next");
  const resultText = el.querySelector<HTMLElement>(".result-text");
  const sourcesList = el.querySelector<HTMLElement>(".sources-list");
  const uiState = el.__ggdVariantState ??= { variants: [], selectedVariantIndex: 0, variantComposer: undefined, originalComposerText: "", overwriteBehavior: "replace", surface: "gmail" };
  const applyVariant = (nextIndex: number) => {
    if (uiState.variants.length < 1) return;
    if (uiState.variantComposer && !isComposerUsable(uiState.variantComposer)) {
      if (message) message.innerHTML = formatErrorMessage("Composer unavailable: Open the compose box and draft again.");
      return;
    }

    uiState.selectedVariantIndex = (nextIndex + uiState.variants.length) % uiState.variants.length;
    const selectedVariant = uiState.variants[uiState.selectedVariantIndex];
    if (!selectedVariant) return;
    if (uiState.variantComposer) {
      insertDraftForSurface(uiState.variantComposer, getVariantDraftForInsert(uiState, selectedVariant), selectedVariant.subject, "replace", uiState.surface);
    }
    if (resultText) resultText.textContent = selectedVariant.draft;
    if (variantCount) variantCount.textContent = `${selectedVariant.label} of ${uiState.variants.length}`;
  };
  if (previousVariant) previousVariant.onclick = () => applyVariant(uiState.selectedVariantIndex - 1);
  if (nextVariant) nextVariant.onclick = () => applyVariant(uiState.selectedVariantIndex + 1);
  const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("button:not(.close)"));
  return {
    reset() {
      draftRequestSequence += 1;
      uiState.variants = [];
      uiState.selectedVariantIndex = 0;
      uiState.variantComposer = undefined;
      uiState.originalComposerText = "";
      uiState.overwriteBehavior = "replace";
      uiState.surface = "web";
      el.classList.remove("error", "loading", "has-draft", "has-variants", "web-result");
      if (instruction) instruction.value = "";
      if (resultText) resultText.textContent = "";
      if (sourcesList) sourcesList.textContent = "No draft yet.";
      if (variantCount) variantCount.textContent = "Draft 1 of 1";
      buttons.forEach((button) => {
        button.disabled = false;
      });
    },
    focusInstruction() {
      instruction?.focus();
      instruction?.setSelectionRange(instruction.value.length, instruction.value.length);
    },
    setPlaceholder(text: string) {
      if (instruction) instruction.placeholder = text;
    },
    setReady(text: string) {
      el.classList.remove("error", "loading");
      buttons.forEach((button) => {
        button.disabled = false;
      });
      if (message) message.textContent = text;
    },
    setLoading(text: string) {
      el.classList.remove("error");
      el.classList.add("loading");
      el.classList.remove("has-draft", "has-variants", "web-result");
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
    setGroundingState(response: DraftResponsePayload) {
      renderGroundingState(sourcesList, response);
    },
    setVariants(nextVariants: DraftVariant[], composerTarget: ComposerTarget | undefined, selectedIndex: number, overwriteBehavior: OverwriteBehavior, originalComposerText: string, surface: DraftSurface = "gmail") {
      uiState.variants = nextVariants;
      uiState.selectedVariantIndex = Math.min(Math.max(selectedIndex, 0), Math.max(nextVariants.length - 1, 0));
      uiState.variantComposer = composerTarget;
      uiState.originalComposerText = originalComposerText;
      uiState.overwriteBehavior = overwriteBehavior;
      uiState.surface = surface;
      el.classList.add("has-draft");
      el.classList.toggle("web-result", surface === "web");
      el.classList.toggle("has-variants", uiState.variants.length > 1);
      if (resultText) resultText.textContent = uiState.variants[uiState.selectedVariantIndex]?.draft ?? "";
      const hasMultipleVariants = uiState.variants.length > 1;
      if (previousVariant) {
        previousVariant.disabled = !hasMultipleVariants;
        previousVariant.title = hasMultipleVariants ? "Previous draft" : "Only one draft returned";
      }
      if (nextVariant) {
        nextVariant.disabled = !hasMultipleVariants;
        nextVariant.title = hasMultipleVariants ? "Next draft" : "Only one draft returned";
      }
      if (variantCount) {
        variantCount.textContent = hasMultipleVariants ? `${uiState.variants[uiState.selectedVariantIndex]?.label ?? "Draft 1"} of ${uiState.variants.length}` : "1 draft returned";
      }
    },
  };
}

function renderGroundingState(element: HTMLElement | null, response: DraftResponsePayload) {
  if (!element) return;
  const sourceItems = response.groundingSources
    .filter((source) => source.label !== "Glean mode")
    .map((source) => `<span class="source-item"><strong>${escapeHtml(source.label)}:</strong> ${escapeHtml(source.detail)}</span>`);
  const contextItems = sourceItems.length
    ? sourceItems
    : ['<span class="source-item">No source details returned.</span>'];
  const warnings = response.warnings.map((warning) => `<span class="source-warning">${escapeHtml(warning)}</span>`);
  element.innerHTML = [...contextItems, ...warnings].join("");
}

function createFallbackVariant(draft: string, subject?: string): DraftVariant {
  const variant: DraftVariant = { draft, label: "Draft 1" };
  if (subject) variant.subject = subject;
  return variant;
}

function combineInstructions(primary: string, override: string) {
  return [primary.trim(), override.trim()].filter(Boolean).join("\n\nAdditional revision request:\n");
}

function isComposerUsable(composer: ComposerTarget) {
  return composer.editor.isConnected && composer.root.isConnected;
}

function getVariantDraftForInsert(uiState: VariantUiState, selectedVariant: DraftVariant) {
  if (uiState.overwriteBehavior !== "append" || !uiState.originalComposerText.trim()) {
    return selectedVariant.draft;
  }

  return [uiState.originalComposerText.trim(), selectedVariant.draft.trim()].filter(Boolean).join("\n\n");
}

function getDraftText(composer: ComposerTarget, surface: DraftSurface) {
  if (surface === "slack") return getSlackComposerDraftText(composer);
  if (surface === "web") return getWebComposerDraftText(composer);
  return getComposerDraftText(composer);
}

function webDraftWasInserted(composer: ComposerTarget, draft: string) {
  if (!isWebComposerUsable(composer)) return false;
  const normalize = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normalizedDraft = normalize(draft);
  return Boolean(normalizedDraft && normalize(getWebComposerDraftText(composer)).includes(normalizedDraft));
}

function insertDraftForSurface(composer: ComposerTarget, draft: string, subject: string | undefined, mode: OverwriteBehavior, surface: DraftSurface) {
  if (surface === "slack") {
    insertSlackDraft(composer, draft, mode);
    return;
  }
  if (surface === "web") {
    insertWebDraft(composer, draft, mode);
    return;
  }

  insertNewEmailDraft(composer, draft, subject, mode);
}

function setupDraggablePanel(panel: HTMLElement) {
  const handle = panel.querySelector<HTMLElement>(".brand");
  if (!handle) return;

  handle.addEventListener("pointerdown", (event) => {
    if (!panel.classList.contains("floating") || event.button !== 0) return;

    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.setPointerCapture(event.pointerId);
    event.preventDefault();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
      const nextLeft = Math.min(Math.max(8, moveEvent.clientX - offsetX), maxLeft);
      const nextTop = Math.min(Math.max(8, moveEvent.clientY - offsetY), maxTop);
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      panel.releasePointerCapture(upEvent.pointerId);
      panel.removeEventListener("pointermove", onPointerMove);
      panel.removeEventListener("pointerup", onPointerUp);
      panel.removeEventListener("pointercancel", onPointerUp);
    };

    panel.addEventListener("pointermove", onPointerMove);
    panel.addEventListener("pointerup", onPointerUp);
    panel.addEventListener("pointercancel", onPointerUp);
  });
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

function getInstruction(composer: ComposerTarget | undefined) {
  const root = composer?.root ?? document.body;
  return root.querySelector<HTMLTextAreaElement>(".ggd-inline-ui .instruction")?.value
    ?? document.querySelector<HTMLTextAreaElement>(".ggd-inline-ui .instruction")?.value
    ?? "";
}

function isGmailSurface() {
  return location.hostname.endsWith("mail.google.com");
}

function isSlackSurface() {
  return location.hostname.endsWith("slack.com") || location.hostname === "app.slack.com";
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
