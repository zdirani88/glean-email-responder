import type { WebDraftRequestPayload } from "@gmail-glean-reply-drafter/shared";

export interface WebComposerTarget {
  editor: HTMLElement;
  root: HTMLElement;
}

export interface WebExtractionOptions {
  userInstruction?: string;
  composer?: WebComposerTarget | undefined;
}

const MAX_SELECTED_TEXT = 8_000;
const MAX_NEARBY_TEXT = 16_000;
const MAX_PAGE_TEXT = 20_000;

export function findActiveWebComposer(): WebComposerTarget | undefined {
  const active = getDeepActiveElement();
  if (!(active instanceof HTMLElement) || active.closest(".ggd-inline-ui")) return undefined;

  const editor = getEditableElement(active);
  if (!editor || !isUsableEditor(editor)) return undefined;

  return { editor, root: findContextRoot(editor) };
}

export function extractWebContext(options: WebExtractionOptions = {}): WebDraftRequestPayload {
  const composer = options.composer;
  const selection = normalizeText(window.getSelection()?.toString() ?? "").slice(0, MAX_SELECTED_TEXT);
  const nearbyText = composer ? extractNearbyText(composer).slice(0, MAX_NEARBY_TEXT) : "";
  const pageText = extractPageText().slice(0, MAX_PAGE_TEXT);
  const timezone = inferClientTimezone();
  const payload: WebDraftRequestPayload = {
    pageTitle: normalizeText(document.title).slice(0, 500),
    pageUrl: location.href,
    selectedText: selection,
    nearbyText,
    pageText,
    activeFieldText: composer ? getWebComposerDraftText(composer).slice(0, 10_000) : "",
    userInstruction: options.userInstruction?.trim() || "Draft a context-appropriate response to the visible page.",
    activeComposerDetected: Boolean(composer),
    timestamp: new Date().toISOString(),
    clientRequestId: crypto.randomUUID(),
  };
  if (timezone) payload.clientTimezone = timezone;
  return payload;
}

export function getWebComposerDraftText(composer: WebComposerTarget) {
  if (composer.editor instanceof HTMLInputElement || composer.editor instanceof HTMLTextAreaElement) {
    return composer.editor.value;
  }
  return normalizeText(composer.editor.innerText || composer.editor.textContent || "");
}

export function insertWebDraft(composer: WebComposerTarget, draft: string, mode: "replace" | "append" = "replace") {
  const editor = composer.editor;
  editor.focus();
  const current = getWebComposerDraftText(composer).trim();
  const nextValue = mode === "append" && current ? `${current}\n\n${draft.trim()}` : draft.trim();

  if (editor instanceof HTMLTextAreaElement) {
    setNativeValue(editor, nextValue, HTMLTextAreaElement.prototype);
    editor.setSelectionRange(nextValue.length, nextValue.length);
  } else if (editor instanceof HTMLInputElement) {
    setNativeValue(editor, nextValue, HTMLInputElement.prototype);
    editor.setSelectionRange(nextValue.length, nextValue.length);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (mode === "append" && current) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const textToInsert = mode === "append" && current ? `\n\n${draft.trim()}` : draft.trim();
    if (!document.execCommand("insertText", false, textToInsert)) {
      if (mode === "append" && current) editor.append(document.createElement("br"), document.createElement("br"), document.createTextNode(draft.trim()));
      else editor.replaceChildren(document.createTextNode(draft.trim()));
    }
  }

  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: draft }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string, prototype: typeof HTMLInputElement.prototype | typeof HTMLTextAreaElement.prototype) {
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function getEditableElement(element: HTMLElement) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element;
  return element.closest<HTMLElement>("[contenteditable='true'], [role='textbox'][contenteditable]:not([contenteditable='false'])") ?? undefined;
}

function isUsableEditor(editor: HTMLElement) {
  if (editor instanceof HTMLInputElement) {
    return !editor.disabled && !editor.readOnly && ["text", "search", "email", "url", "tel"].includes(editor.type);
  }
  if (editor instanceof HTMLTextAreaElement) return !editor.disabled && !editor.readOnly;
  return editor.isContentEditable || editor.getAttribute("contenteditable") === "true";
}

function findContextRoot(editor: HTMLElement) {
  const semantic = editor.closest<HTMLElement>("[role='dialog'], article, section, main, [data-view-name*='message'], [class*='messaging'], [class*='conversation']");
  if (semantic && normalizeText(semantic.innerText).length >= 80) return semantic;

  let candidate: HTMLElement | null = editor.parentElement;
  while (candidate && candidate !== document.body) {
    const length = normalizeText(candidate.innerText).length;
    if (length >= 250 && length <= MAX_NEARBY_TEXT * 2) return candidate;
    candidate = candidate.parentElement;
  }
  return document.querySelector<HTMLElement>("main, [role='main']") ?? document.body;
}

function extractNearbyText(composer: WebComposerTarget) {
  return normalizeText(composer.root.innerText || composer.root.textContent || "");
}

function extractPageText() {
  const root = document.querySelector<HTMLElement>("main, [role='main'], article") ?? document.body;
  return normalizeText(root.innerText || root.textContent || "");
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function inferClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
