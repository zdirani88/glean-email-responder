import type { ReplySettings } from "@gmail-glean-reply-drafter/shared";
import type { ValidDraftRequest } from "./schema.js";

export function buildReplyPrompt(payload: ValidDraftRequest, settings: ReplySettings) {
  const selectedMessages = selectMessages(payload, settings);
  const latestMessage = selectedMessages.find((message) => message.isLatestVisible) ?? selectedMessages.at(-1);
  const priorMessages = selectedMessages.filter((message) => message !== latestMessage);

  return `You are drafting an email reply for ${formatUser(payload)}.

Draft only from the visible Gmail thread context below. Some quoted history may be collapsed or missing, so do not assume facts that are not present.

Voice:
${formatVoice(settings)}

Length:
${formatLength(settings)}

Personal writing preferences:
${formatWritingPreferences(settings)}

${formatSchedulingInstructions(payload)}

Rules:
- Return only the reply draft body as plain text.
- Do not include a subject line.
- Do not invent commitments, dates, attachments, approvals, or facts.
- If the latest ask cannot be answered from context, write a useful reply that acknowledges the ask and proposes a next step.
- Avoid overly formal filler.
- Never use em dashes. Replace em dashes with commas, periods, colons, semicolons, or parentheses.
- Do not include working notes, analysis, reasoning, status updates, or alternatives.
- If a current draft is provided, revise that draft according to the user's instruction while preserving facts from the visible thread.

User instruction:
${payload.userInstruction || "(none)"}

Current draft in composer:
${payload.currentDraft || "(none)"}

Thread subject:
${payload.threadSubject || "(not visible)"}

Visible participants:
${payload.participantsVisible.length ? payload.participantsVisible.join(", ") : "(not visible)"}

Most recent visible message:
${formatMessage(latestMessage)}

Prior visible history, oldest to newest:
${priorMessages.length ? priorMessages.map(formatMessage).join("\n\n---\n\n") : "(none)"}
`;
}

function formatSchedulingInstructions(payload: ValidDraftRequest) {
  const timezone = payload.clientTimezone || "America/New_York";
  if (!hasSchedulingIntent(payload)) {
    return ["Scheduling support:", "- No scheduling intent detected."].join("\n");
  }

  return [
    "Scheduling support:",
    "- Scheduling intent detected. Use Glean's Google Calendar Find free slots action, if available, to check the user's real availability.",
    '- Use calendar identifier "primary" unless the email explicitly names another calendar or attendee calendar.',
    `- Interpret dates and times in timezone ${timezone}.`,
    "- If Glean cannot access calendar availability, say you can check and propose a reasonable next step instead of pretending a slot is available.",
    "- Do not create or modify calendar events. Only draft the email reply.",
  ].join("\n");
}

function hasSchedulingIntent(payload: ValidDraftRequest) {
  const text = [
    payload.threadSubject,
    payload.userInstruction,
    payload.currentDraft,
    ...payload.messages.map((message) => message.bodyText),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /\b(schedule|scheduling|calendar|available|availability|free|busy|meet|meeting|call|sync|slot|slots|time|times|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/.test(text);
}

function formatUser(payload: ValidDraftRequest) {
  const name = payload.currentUser?.name;
  const email = payload.currentUser?.email;
  if (name && email) return `${name} <${email}>`;
  return name || email || "the user";
}

function formatMessage(message: ValidDraftRequest["messages"][number] | undefined) {
  if (!message) return "(none)";

  const sender = [message.senderName, message.senderEmail ? `<${message.senderEmail}>` : ""]
    .filter(Boolean)
    .join(" ");

  return [
    `From: ${sender || "unknown"}`,
    message.timestampText ? `Time: ${message.timestampText}` : undefined,
    "",
    message.bodyText,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function selectMessages(payload: ValidDraftRequest, settings: ReplySettings) {
  if (settings.contextDepth === "latest") {
    return [payload.messages.find((message) => message.isLatestVisible) ?? payload.messages.at(-1)].filter(Boolean) as ValidDraftRequest["messages"];
  }

  return payload.messages;
}

function formatVoice(settings: ReplySettings) {
  const base = ["professional", "action-oriented", "sendable with light editing"];
  const tone = {
    concise: ["concise", "direct"],
    warm: ["warm", "friendly", "not overly casual"],
    formal: ["formal", "polished", "respectful"],
    direct: ["direct", "plainspoken", "efficient"],
  }[settings.defaultTone];

  return [...tone, ...base].map((item) => "- " + item).join("\n");
}

function formatLength(settings: ReplySettings) {
  if (settings.defaultLength === "short") return "Keep it short: usually 2-5 sentences unless the thread clearly requires more.";
  if (settings.defaultLength === "detailed") return "Use enough detail to fully answer the ask while staying email-appropriate.";
  return "Use a medium length: complete, but avoid unnecessary explanation.";
}

function formatWritingPreferences(settings: ReplySettings) {
  const value = settings.writingPreferences.trim();
  return value || "Do not use em dashes. Write concise, warm, direct replies.";
}
