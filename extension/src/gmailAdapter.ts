import type { DraftRequestPayload, ExtractedMessage, NewEmailRequestPayload } from "@gmail-glean-reply-drafter/shared";

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

export interface ExtractionOptions {
  userInstruction?: string;
}

export interface NewEmailExtractionResult {
  ok: true;
  payload: NewEmailRequestPayload;
  composer: ComposerTarget;
}

export interface NewEmailExtractionFailure {
  ok: false;
  error: string;
  composer?: ComposerTarget;
}

interface OpenEmailResult {
  ok: true;
}

interface OpenEmailFailure {
  ok: false;
  error: string;
}

const EDITOR_SELECTORS = [
  "[role='textbox'][contenteditable='true'][aria-label*='Message Body']",
  "[role='textbox'][contenteditable='true'][aria-label*='Body']",
  "div.Am.Al.editable[contenteditable='true']",
  "[contenteditable='true'][g_editable='true']",
  "[role='textbox'][contenteditable='true']",
];

export function extractVisibleThreadForActiveComposer(options: ExtractionOptions = {}): ExtractionResult | ExtractionFailure {
  const composer = findActiveComposer();
  if (!composer) {
    return { ok: false, error: "Open a Gmail reply box and place your cursor in it first." };
  }

  const messages = extractVisibleMessages(composer);
  if (messages.length < 1) {
    return { ok: false, error: "Could not find at least one usable visible message in this Gmail thread.", composer };
  }

  const composerText = getComposerText(composer.editor).trim();
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
  const timezone = inferClientTimezone();
  if (currentUser) payload.currentUser = currentUser;
  if (timezone) payload.clientTimezone = timezone;
  if (options.userInstruction?.trim()) payload.userInstruction = options.userInstruction.trim();
  if (composerText && !isProgressComposerText(composerText)) payload.currentDraft = composerText;

  return { ok: true, payload, composer };
}

export function extractNewEmailForActiveComposer(options: ExtractionOptions = {}): NewEmailExtractionResult | NewEmailExtractionFailure {
  const composer = findActiveComposer();
  if (!composer) {
    return { ok: false, error: "Open a new Gmail compose window and place your cursor in the body first." };
  }

  const userInstruction = options.userInstruction?.trim() ?? "";
  const composerText = getComposerText(composer.editor).trim();
  if (!userInstruction && !composerText) {
    return { ok: false, error: "Describe what this new email should accomplish, then click Draft.", composer };
  }

  const payload: NewEmailRequestPayload = {
    composeSubject: extractComposeSubject(composer),
    recipientsVisible: extractComposeRecipients(composer),
    userInstruction: userInstruction || "Finish and polish the current draft into a sendable new email.",
    activeComposerDetected: true,
    pageUrl: location.href,
    timestamp: new Date().toISOString(),
    clientRequestId: crypto.randomUUID(),
  };
  const currentUser = inferCurrentUser();
  const timezone = inferClientTimezone();
  if (currentUser) payload.currentUser = currentUser;
  if (timezone) payload.clientTimezone = timezone;
  if (composerText && !isProgressComposerText(composerText)) payload.currentDraft = composerText;

  return { ok: true, payload, composer };
}

export function insertNewEmailDraft(composer: ComposerTarget, draft: string, subject?: string, mode: "replace" | "append" = "replace") {
  if (subject?.trim()) insertComposeSubject(composer, subject.trim());
  insertDraft(composer, draft, mode);
}

export function insertDraft(composer: ComposerTarget, draft: string, mode: "replace" | "append" = "replace") {
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

  if (mode === "append" && getComposerText(composer.editor).trim()) {
    composer.editor.append(document.createElement("br"));
    composer.editor.append(document.createElement("br"));
    composer.editor.append(fragment);
  } else {
    composer.editor.replaceChildren(fragment);
  }
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

export function getComposerDraftText(composer: ComposerTarget) {
  return getComposerText(composer.editor);
}

export async function openEmailAndReplyFromList(): Promise<OpenEmailResult | OpenEmailFailure> {
  const row = findTargetEmailRow();
  if (!row) {
    return { ok: false, error: "Open an email thread or select a message in Gmail first." };
  }

  row.click();
  const threadOpened = await waitFor(() => extractVisibleMessages().length > 0 && Boolean(extractSubject()), 8000);
  if (!threadOpened) {
    return { ok: false, error: "I could not open the selected Gmail message. Open the email and try again." };
  }

  const existingComposer = findActiveComposer();
  if (existingComposer) return { ok: true };

  const replyButton = findThreadReplyButton();
  if (!replyButton) {
    return { ok: false, error: "I opened the email, but could not find Gmail's reply button. Open a reply box and try again." };
  }

  replyButton.click();
  const composerOpened = await waitFor(() => findActiveComposer(), 6000);
  if (!composerOpened) {
    return { ok: false, error: "I opened the email, but Gmail did not open a reply box. Click Reply and try again." };
  }

  return { ok: true };
}

function findTargetEmailRow() {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("tr[role='row'], .zA") : undefined;
  if (active && isVisible(active) && looksLikeEmailRow(active)) return active;

  const selected = Array.from(document.querySelectorAll<HTMLElement>("tr[aria-selected='true'], .zA[aria-selected='true']")).find((row) => isVisible(row) && looksLikeEmailRow(row));
  if (selected) return selected;

  return Array.from(document.querySelectorAll<HTMLElement>("tr.zA, .zA, tr[role='row']")).find((row) => isVisible(row) && looksLikeEmailRow(row));
}

function looksLikeEmailRow(row: HTMLElement) {
  const text = normalizeText(row.innerText || row.textContent || "");
  if (text.length < 8) return false;
  if (/^(inbox|starred|snoozed|sent|drafts|labels)$/i.test(text)) return false;
  const rect = row.getBoundingClientRect();
  return rect.width > 320 && rect.height >= 20;
}

function findThreadReplyButton() {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>("[role='button'][aria-label], [data-tooltip], .ams.bkH, .ams"))
    .filter(isVisible)
    .filter((button) => {
      const label = [button.getAttribute("aria-label"), button.getAttribute("data-tooltip"), button.innerText].filter(Boolean).join(" ");
      return /(^|\b)reply(\b|$)/i.test(label) && !/reply all/i.test(label);
    });

  return buttons.at(-1);
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  return undefined;
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

function isProgressComposerText(value: string) {
  const normalized = value.replace(/[*_`]/g, "").trim().toLowerCase();
  return normalized === "checking your writing style" || normalized === "drafting your reply";
}

function extractSubject() {
  const subject =
    document.querySelector<HTMLElement>("h2[data-thread-perm-id]") ??
    document.querySelector<HTMLElement>("h2.hP") ??
    document.querySelector<HTMLElement>("[role='main'] h2");

  return normalizeText(subject?.innerText ?? "");
}

function extractVisibleMessages(composer?: ComposerTarget): ExtractedMessage[] {
  const composerTop = composer ? composer.root.getBoundingClientRect().top : undefined;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[role='listitem'], .adn.ads, .gs"));
  const seen = new Set<string>();
  const messages: ExtractedMessage[] = [];

  for (const candidate of candidates) {
    if (!isVisible(candidate)) continue;
    if (composerTop !== undefined && candidate.getBoundingClientRect().top >= composerTop - 8) continue;

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

function inferClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
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

function extractComposeSubject(composer: ComposerTarget) {
  const input = composer.root.querySelector<HTMLInputElement>("input[name='subjectbox'], input[aria-label='Subject']");
  return normalizeText(input?.value ?? "");
}

function insertComposeSubject(composer: ComposerTarget, subject: string) {
  const input = composer.root.querySelector<HTMLInputElement>("input[name='subjectbox'], input[aria-label='Subject']");
  if (!input) return;
  input.focus();
  input.value = subject;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: subject }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function extractComposeRecipients(composer: ComposerTarget) {
  const values = Array.from(composer.root.querySelectorAll<HTMLElement>("[email], [data-hovercard-id], [aria-label*='@'], textarea[name='to'], textarea[name='cc'], textarea[name='bcc']"))
    .flatMap((node) => [
      node.getAttribute("email"),
      node.getAttribute("data-hovercard-id"),
      node.getAttribute("aria-label"),
      node instanceof HTMLTextAreaElement ? node.value : undefined,
      node.innerText,
    ])
    .map((value) => normalizeText(value ?? ""))
    .filter((value) => value.includes("@") || value.length > 1)
    .map((value) => value.replace(/^To:\s*/i, "").replace(/^Cc:\s*/i, "").replace(/^Bcc:\s*/i, ""));

  return Array.from(new Set(values)).slice(0, 12);
}
