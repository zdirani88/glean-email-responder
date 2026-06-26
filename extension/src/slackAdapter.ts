import type { ExtractedMessage, SlackDraftRequestPayload } from "@gmail-glean-reply-drafter/shared";

interface ComposerTarget {
  editor: HTMLElement;
  root: HTMLElement;
}

export interface SlackExtractionResult {
  ok: true;
  payload: SlackDraftRequestPayload;
  composer: ComposerTarget;
}

export interface SlackExtractionFailure {
  ok: false;
  error: string;
  composer?: ComposerTarget;
}

export interface SlackExtractionOptions {
  userInstruction?: string;
}

const SLACK_EDITOR_SELECTORS = [
  "[data-qa='message_input'] [contenteditable='true']",
  "[data-qa='message_input'] .ql-editor",
  ".ql-editor[contenteditable='true']",
  "[role='textbox'][contenteditable='true']",
  "[contenteditable='true'][data-qa='message_input']",
  "[contenteditable='true']",
];

const SLACK_MESSAGE_SELECTORS = [
  "[data-qa='message_container']",
  ".c-message_kit__background",
  ".c-message_kit__message",
  "[data-qa='virtual-list-item']",
  "[role='listitem']",
];

export function extractVisibleSlackContextForActiveComposer(options: SlackExtractionOptions = {}): SlackExtractionResult | SlackExtractionFailure {
  const composer = findActiveSlackComposer();
  if (!composer) {
    return { ok: false, error: "Open a Slack message box or thread reply box and place your cursor in it first." };
  }

  const messages = extractVisibleSlackMessages(composer);
  if (messages.length < 1) {
    return { ok: false, error: "Could not find at least one usable visible Slack message near this composer.", composer };
  }

  const payload: SlackDraftRequestPayload = {
    participantsVisible: extractParticipants(messages),
    messages,
    activeComposerDetected: true,
    pageUrl: location.href,
    timestamp: new Date().toISOString(),
    clientRequestId: crypto.randomUUID(),
  };
  const workspaceName = extractWorkspaceName();
  const channelName = extractChannelName();
  const threadTitle = extractThreadTitle(composer);
  const timezone = inferClientTimezone();
  const currentDraft = getSlackComposerDraftText(composer).trim();
  if (workspaceName) payload.workspaceName = workspaceName;
  if (channelName) payload.channelName = channelName;
  if (threadTitle) payload.threadTitle = threadTitle;
  if (timezone) payload.clientTimezone = timezone;
  if (options.userInstruction?.trim()) payload.userInstruction = options.userInstruction.trim();
  if (currentDraft && !isSlackPlaceholderText(currentDraft)) payload.currentDraft = currentDraft;

  return { ok: true, payload, composer };
}

export function findActiveSlackComposer(): ComposerTarget | undefined {
  const active = document.activeElement;
  const activeEditor = active instanceof HTMLElement ? closestSlackEditor(active) : undefined;
  if (activeEditor) {
    return { editor: activeEditor, root: findSlackComposerRoot(activeEditor) };
  }

  for (const selector of SLACK_EDITOR_SELECTORS) {
    const editors = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(isVisible)
      .filter((editor) => !editor.closest(".ggd-inline-ui"));
    const editor = editors.at(-1);
    if (editor) {
      return { editor, root: findSlackComposerRoot(editor) };
    }
  }

  return undefined;
}

export function getSlackComposerRoot(composer: ComposerTarget) {
  return composer.root;
}

export function getSlackComposerDraftText(composer: ComposerTarget) {
  return getSlackEditorText(composer.editor);
}

export function insertSlackDraft(composer: ComposerTarget, draft: string, mode: "replace" | "append" = "replace") {
  composer.editor.focus();
  const fragment = createSlackDraftFragment(draft);

  if (mode === "append" && getSlackEditorText(composer.editor).trim()) {
    composer.editor.append(document.createElement("br"));
    composer.editor.append(document.createElement("br"));
    composer.editor.append(fragment);
  } else {
    composer.editor.replaceChildren(fragment);
  }

  composer.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: draft }));
  composer.editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function closestSlackEditor(element: HTMLElement) {
  for (const selector of SLACK_EDITOR_SELECTORS) {
    const editor = element.closest<HTMLElement>(selector);
    if (editor && isVisible(editor) && !editor.closest(".ggd-inline-ui")) return editor;
  }
  return undefined;
}

function findSlackComposerRoot(editor: HTMLElement) {
  return (
    editor.closest<HTMLElement>("[data-qa='message_input']") ??
    editor.closest<HTMLElement>("[data-qa='message_input_container']") ??
    editor.closest<HTMLElement>("[role='dialog']") ??
    editor.closest<HTMLElement>(".p-threads_view") ??
    editor.closest<HTMLElement>(".p-workspace__primary_view") ??
    editor.parentElement ??
    editor
  );
}

function extractVisibleSlackMessages(composer: ComposerTarget): ExtractedMessage[] {
  const scope = getSlackMessageScope(composer);
  const composerTop = composer.root.getBoundingClientRect().top;
  const candidates = SLACK_MESSAGE_SELECTORS.flatMap((selector) => Array.from(scope.querySelectorAll<HTMLElement>(selector)));
  const seenNodes = new Set<HTMLElement>();
  const seenBodies = new Set<string>();
  const messages: ExtractedMessage[] = [];

  for (const candidate of candidates) {
    if (seenNodes.has(candidate) || !isVisible(candidate) || candidate.contains(composer.root)) continue;
    seenNodes.add(candidate);
    if (candidate.getBoundingClientRect().top >= composerTop - 8) continue;

    const bodyText = cleanSlackMessageBody(candidate.innerText || candidate.textContent || "");
    if (bodyText.length < 2 || seenBodies.has(bodyText) || isNonMessageText(bodyText)) continue;
    seenBodies.add(bodyText);

    const message: ExtractedMessage = {
      bodyText,
      isLatestVisible: false,
    };
    const senderName = extractSlackSender(candidate, bodyText);
    const timestampText = extractSlackTimestamp(candidate);
    if (senderName) message.senderName = senderName;
    if (timestampText) message.timestampText = timestampText;
    messages.push(message);
  }

  const usefulMessages = messages.slice(-12);
  const latest = usefulMessages.at(-1);
  if (latest) latest.isLatestVisible = true;
  return usefulMessages;
}

function getSlackMessageScope(composer: ComposerTarget) {
  return (
    composer.root.closest<HTMLElement>(".p-threads_view") ??
    composer.root.closest<HTMLElement>("[data-qa='slack_kit_scrollbar']") ??
    document.querySelector<HTMLElement>("[data-qa='slack_kit_scrollbar']") ??
    document.body
  );
}

function extractSlackSender(candidate: HTMLElement, bodyText: string) {
  const sender =
    candidate.querySelector<HTMLElement>("[data-qa='message_sender']") ??
    candidate.querySelector<HTMLElement>("[data-qa='message_sender_name']") ??
    candidate.querySelector<HTMLElement>(".c-message__sender") ??
    candidate.querySelector<HTMLElement>("button[data-message-sender]");
  const value = normalizeText(sender?.innerText || sender?.textContent || "");
  if (value) return value;
  const firstLine = bodyText.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine && firstLine.length <= 80 ? firstLine : undefined;
}

function extractSlackTimestamp(candidate: HTMLElement) {
  const timestamp =
    candidate.querySelector<HTMLElement>("a[data-qa='message_timestamp']") ??
    candidate.querySelector<HTMLElement>("[data-qa='message_timestamp']") ??
    candidate.querySelector<HTMLElement>("time") ??
    candidate.querySelector<HTMLElement>(".c-timestamp");
  return normalizeText(timestamp?.getAttribute("aria-label") || timestamp?.getAttribute("datetime") || timestamp?.innerText || timestamp?.textContent || "");
}

function extractWorkspaceName() {
  const workspace =
    document.querySelector<HTMLElement>("[data-qa='workspace_switcher_button']") ??
    document.querySelector<HTMLElement>("[data-qa='team_menu_button']") ??
    document.querySelector<HTMLElement>(".p-ia4_top_nav__team__name");
  const value = normalizeText(workspace?.getAttribute("aria-label") || workspace?.innerText || workspace?.textContent || "");
  return value.replace(/^Switch workspace\s*/i, "") || undefined;
}

function extractChannelName() {
  const header =
    document.querySelector<HTMLElement>("[data-qa='channel_header_name']") ??
    document.querySelector<HTMLElement>("[data-qa='channel_name']") ??
    document.querySelector<HTMLElement>(".p-view_header__channel_title") ??
    document.querySelector<HTMLElement>("header h1");
  const value = normalizeText(header?.innerText || header?.textContent || document.title.replace(/\s*\|\s*Slack.*$/i, ""));
  return value || undefined;
}

function extractThreadTitle(composer: ComposerTarget) {
  const threadRoot = composer.root.closest<HTMLElement>(".p-threads_view, [data-qa='thread_view']");
  const title =
    threadRoot?.querySelector<HTMLElement>("[data-qa='thread_header']") ??
    threadRoot?.querySelector<HTMLElement>("h1, h2");
  const value = normalizeText(title?.innerText || title?.textContent || "");
  return value || undefined;
}

function extractParticipants(messages: ExtractedMessage[]) {
  return Array.from(
    new Set(
      messages
        .map((message) => message.senderName || message.senderEmail)
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
    )
  ).slice(0, 24);
}

function createSlackDraftFragment(draft: string) {
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

  return fragment;
}

function getSlackEditorText(editor: HTMLElement) {
  return cleanSlackComposerText(editor.innerText || editor.textContent || "");
}

function cleanSlackComposerText(value: string) {
  return normalizeText(value.replace(/\u200b/g, ""));
}

function cleanSlackMessageBody(value: string) {
  const lines = value
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .filter((line) => !/^(reply|more actions|add reaction|save for later|share message)$/i.test(line))
    .filter((line) => !/^\d+\s+repl(?:y|ies)$/i.test(line))
    .filter((line) => !/^edited$/i.test(line));

  return lines.join("\n").trim();
}

function isNonMessageText(value: string) {
  return /^(jump to|new messages|view thread|also send to|message |send message|add a bookmark)$/i.test(value);
}

function isSlackPlaceholderText(value: string) {
  const normalized = normalizeText(value).toLowerCase();
  return !normalized || /^message\s+#?/.test(normalized) || /^send a message/.test(normalized) || /^reply to thread/.test(normalized);
}

function inferClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}
