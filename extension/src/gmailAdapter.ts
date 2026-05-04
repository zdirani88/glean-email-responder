import type { DraftRequestPayload, ExtractedMessage } from "@gmail-glean-reply-drafter/shared";

interface ComposerTarget {
  editor: HTMLElement;
  root: HTMLElement;
}

export interface ExtractionResult {
  ok: true;
  payload: DraftRequestPayload;
  composer: ComposerTarget;
}

export interface ExtractionFailure {
  ok: false;
  error: string;
  composer?: ComposerTarget;
}

const EDITOR_SELECTORS = [
  "[role='textbox'][contenteditable='true'][aria-label*='Message Body']",
  "[role='textbox'][contenteditable='true'][aria-label*='Body']",
  "div.Am.Al.editable[contenteditable='true']",
  "[contenteditable='true'][g_editable='true']",
  "[role='textbox'][contenteditable='true']",
];

export function extractVisibleThreadForActiveComposer(): ExtractionResult | ExtractionFailure {
  const composer = findActiveComposer();
  if (!composer) {
    return { ok: false, error: "Open a Gmail reply box and place your cursor in it first." };
  }

  if (getComposerText(composer.editor).trim()) {
    return { ok: false, error: "The active composer is not empty. Clear it before drafting.", composer };
  }

  const messages = extractVisibleMessages();
  if (messages.length < 1) {
    return { ok: false, error: "Could not find at least one usable visible message in this Gmail thread.", composer };
  }

  const payload: DraftRequestPayload = {
    threadSubject: extractSubject(),
    participantsVisible: extractParticipants(messages),
    messages,
    activeComposerDetected: true,
    pageUrl: location.href,
    timestamp: new Date().toISOString(),
    clientRequestId: crypto.randomUUID(),
  };
  const currentUser = inferCurrentUser();
  if (currentUser) payload.currentUser = currentUser;

  return { ok: true, payload, composer };
}

export function insertDraft(composer: ComposerTarget, draft: string) {
  composer.editor.focus();
  const paragraphs = draft
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const fragment = document.createDocumentFragment();
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      fragment.append(document.createElement("br"));
      fragment.append(document.createElement("br"));
    }
    fragment.append(document.createTextNode(paragraph));
  });

  composer.editor.replaceChildren(fragment);
  composer.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: draft }));
  composer.editor.dispatchEvent(new Event("change", { bubbles: true }));
}

export function findActiveComposer(): ComposerTarget | undefined {
  const active = document.activeElement;
  const activeEditor = active instanceof HTMLElement ? closestEditor(active) : undefined;
  if (activeEditor) {
    return { editor: activeEditor, root: findComposerRoot(activeEditor) };
  }

  for (const selector of EDITOR_SELECTORS) {
    const editors = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
    const editor = editors.at(-1);
    if (editor) {
      return { editor, root: findComposerRoot(editor) };
    }
  }

  return undefined;
}

export function getComposerRoot(composer: ComposerTarget) {
  return composer.root;
}

function closestEditor(element: HTMLElement) {
  for (const selector of EDITOR_SELECTORS) {
    const editor = element.closest<HTMLElement>(selector);
    if (editor && isVisible(editor)) return editor;
  }
  return undefined;
}

function findComposerRoot(editor: HTMLElement) {
  return (
    editor.closest<HTMLElement>("[role='dialog']") ??
    editor.closest<HTMLElement>("form") ??
    editor.closest<HTMLElement>(".M9") ??
    editor.parentElement ??
    editor
  );
}

function getComposerText(editor: HTMLElement) {
  return normalizeText(editor.innerText || editor.textContent || "");
}

function extractSubject() {
  const subject =
    document.querySelector<HTMLElement>("h2[data-thread-perm-id]") ??
    document.querySelector<HTMLElement>("h2.hP") ??
    document.querySelector<HTMLElement>("[role='main'] h2");

  return normalizeText(subject?.innerText ?? "");
}

function extractVisibleMessages(): ExtractedMessage[] {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[role='listitem'], .adn.ads, .gs"));
  const seen = new Set<string>();
  const messages: ExtractedMessage[] = [];

  for (const candidate of candidates) {
    if (!isVisible(candidate)) continue;

    const bodyNode =
      candidate.querySelector<HTMLElement>(".a3s.aiL") ??
      candidate.querySelector<HTMLElement>(".a3s") ??
      candidate.querySelector<HTMLElement>("[dir='ltr']");

    const bodyText = cleanMessageBody(bodyNode?.innerText ?? "");
    if (bodyText.length < 12 || seen.has(bodyText)) continue;

    seen.add(bodyText);
    const message: ExtractedMessage = {
      senderName: normalizeText(
        candidate.querySelector<HTMLElement>(".gD")?.getAttribute("name") ??
          candidate.querySelector<HTMLElement>(".gD")?.innerText ??
          candidate.querySelector<HTMLElement>(".go")?.innerText ??
          ""
      ),
      timestampText: normalizeText(
        candidate.querySelector<HTMLElement>(".g3")?.getAttribute("title") ??
          candidate.querySelector<HTMLElement>(".g3")?.innerText ??
          candidate.querySelector<HTMLElement>(".gH .g3")?.innerText ??
          ""
      ),
      bodyText,
      isLatestVisible: false,
    };
    const senderEmail = extractEmail(
      candidate.querySelector<HTMLElement>(".gD")?.getAttribute("email") ??
        candidate.querySelector<HTMLElement>(".gD")?.getAttribute("data-hovercard-id") ??
        candidate.innerText
    );
    if (senderEmail) message.senderEmail = senderEmail;
    messages.push(message);
  }

  const usefulMessages = messages.slice(-8);
  const latest = usefulMessages.at(-1);
  if (latest) latest.isLatestVisible = true;
  return usefulMessages;
}

function extractParticipants(messages: ExtractedMessage[]) {
  return Array.from(
    new Set(
      messages
        .flatMap((message) => [message.senderEmail, message.senderName])
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
    )
  ).slice(0, 20);
}

function inferCurrentUser() {
  const accountNode =
    document.querySelector<HTMLElement>("a[aria-label*='Google Account']") ??
    document.querySelector<HTMLElement>("img[alt*='Google Account']");
  const label = accountNode?.getAttribute("aria-label") ?? accountNode?.getAttribute("alt") ?? "";
  const email = extractEmail(label);
  return email ? { email } : undefined;
}

function cleanMessageBody(value: string) {
  const lines = value
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line)) break;
    if (/^--\s*$/.test(line)) break;
    if (/^(confidentiality notice|this email and any attachments|privileged and confidential)/i.test(line)) break;
    if (/^(reply|forward|show trimmed content)$/i.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractEmail(value: string | null | undefined) {
  return value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}
