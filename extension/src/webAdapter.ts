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
  if (active instanceof HTMLElement && !active.closest(".ggd-inline-ui")) {
    const activeEditor = getEditableElement(active);
    if (activeEditor && isUsableEditor(activeEditor) && isVisibleEditor(activeEditor)) {
      return { editor: activeEditor, root: findContextRoot(activeEditor) };
    }
  }

  const editor = findBestVisibleEditor();
  return editor ? { editor, root: findContextRoot(editor) } : undefined;
}

export function isWebComposerUsable(composer: WebComposerTarget) {
  return composer.editor.isConnected && composer.root.isConnected && isUsableEditor(composer.editor) && isVisibleEditor(composer.editor);
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
  const insertedText = mode === "append" && current ? `\n\n${draft.trim()}` : draft.trim();

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
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: insertedText }));
    if (!document.execCommand("insertText", false, insertedText)) {
      if (mode === "append" && current) editor.append(document.createElement("br"), document.createElement("br"), document.createTextNode(draft.trim()));
      else editor.replaceChildren(document.createTextNode(draft.trim()));
    }
  }

  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: insertedText }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  if (!(editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) && !containsDraftText(getWebComposerDraftText(composer), draft)) {
    editor.replaceChildren(document.createTextNode(nextValue));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return containsDraftText(getWebComposerDraftText(composer), draft);
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
  return element.closest<HTMLElement>("[contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'][contenteditable]:not([contenteditable='false'])") ?? undefined;
}

function isUsableEditor(editor: HTMLElement) {
  if (editor instanceof HTMLInputElement) {
    return !editor.disabled && !editor.readOnly && ["text", "search", "email", "url", "tel"].includes(editor.type);
  }
  if (editor instanceof HTMLTextAreaElement) return !editor.disabled && !editor.readOnly;
  return editor.isContentEditable || ["true", "plaintext-only"].includes(editor.getAttribute("contenteditable") ?? "");
}

function findBestVisibleEditor() {
  const editors = Array.from(document.querySelectorAll<HTMLElement>([
    "textarea",
    "input[type='text']",
    "input[type='email']",
    "input[type='url']",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "[role='textbox'][contenteditable]:not([contenteditable='false'])",
  ].join(", ")))
    .filter((editor) => !editor.closest(".ggd-inline-ui") && isUsableEditor(editor) && isVisibleEditor(editor));

  return editors.sort((left, right) => scoreEditor(right) - scoreEditor(left))[0];
}

function scoreEditor(editor: HTMLElement) {
  const identity = collectEditorIdentity(editor);
  let score = 0;
  if (editor.matches("textarea, [contenteditable], [role='textbox']")) score += 80;
  if (editor instanceof HTMLInputElement) score -= 80;
  if (editor.getAttribute("role") === "textbox") score += 30;
  if (editor.closest("[role='dialog']")) score += 30;
  if (/(message|messaging|compose|composer|reply|inmail|conversation|msg-form)/i.test(identity)) score += 180;
  if (/(search|filter|navigation)/i.test(identity)) score -= 180;
  const rect = editor.getBoundingClientRect();
  score += Math.max(0, Math.min(30, (rect.top / Math.max(window.innerHeight, 1)) * 30));
  return score;
}

function collectEditorIdentity(editor: HTMLElement) {
  const parts: string[] = [];
  let element: HTMLElement | null = editor;
  for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
    parts.push(element.id, element.className, element.getAttribute("aria-label") ?? "", element.getAttribute("data-view-name") ?? "");
  }
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

function isVisibleEditor(editor: HTMLElement) {
  const style = window.getComputedStyle(editor);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = editor.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function containsDraftText(value: string, draft: string) {
  const normalizedValue = normalizeText(value);
  const normalizedDraft = normalizeText(draft);
  return Boolean(normalizedDraft && normalizedValue.includes(normalizedDraft));
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
  return extractTextWithoutAssistantUi(composer.root);
}

function extractPageText() {
  const root = document.querySelector<HTMLElement>("main, [role='main'], article") ?? document.body;
  return extractTextWithoutAssistantUi(root);
}

function extractTextWithoutAssistantUi(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".ggd-inline-ui, .ggd-toast").forEach((element) => element.remove());
  return normalizeText(clone.textContent || "");
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
