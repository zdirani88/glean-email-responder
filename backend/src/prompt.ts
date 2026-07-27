import type { ReplySettings } from "@gmail-glean-reply-drafter/shared";
import type { ValidDraftRequest, ValidNewEmailRequest, ValidSlackDraftRequest } from "./schema.js";

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
- The user instruction is private drafting guidance from ${formatUser(payload)}. Use it as the highest-priority intent, but do not quote it verbatim unless it is clearly drafted email text.
- If the current draft conflicts with the user instruction, rewrite the draft to follow the user instruction.
- Resolve pronouns and ownership carefully. In user instructions, "me" and "I" usually refer to ${formatUser(payload)}. Do not reverse ownership, for example "point her to me" means route her to ${formatUser(payload)}, not to another recipient.
- Keep the audience clear. The reply is from ${formatUser(payload)} to the visible thread participants. If the user names people to respond to, address or include them naturally.
- Preserve named people and relationships from the user instruction. Do not replace a named person with a different recipient unless the thread makes that explicit.
- Do not invent commitments, dates, attachments, approvals, or facts.
- If the latest ask cannot be answered from context, use the user's instruction to write a useful reply that acknowledges the ask and proposes a next step.
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
    "- Scheduling intent detected. Use any available Glean calendar, free/busy, or connected Google Calendar action to check the user's real availability.",
    '- Use calendar identifier "primary" unless the email explicitly names another calendar or attendee calendar.',
    `- Interpret dates and times in timezone ${timezone}.`,
    "- If Glean cannot access calendar availability or no calendar action is available, state that availability still needs to be confirmed instead of pretending a slot is available.",
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

export function buildNewEmailPrompt(payload: ValidNewEmailRequest, settings: ReplySettings) {
  return `You are drafting a brand-new outbound email for ${formatNewEmailUser(payload)}.

There is no existing email thread. Build the email from the user instruction, current compose fields, and any typed draft only. If important facts are missing, use clear placeholders instead of inventing them.

Voice:
${formatVoice(settings)}

Length:
${formatLength(settings)}

Personal writing preferences:
${formatWritingPreferences(settings)}

${formatNewEmailSchedulingInstructions(payload)}

Rules:
- Return only the sendable email in this exact format:
Subject: <subject line>
Body:
<email body>
- Do not include working notes, analysis, markdown fences, or alternatives.
- Do not invent meetings, numbers, prices, approvals, customer facts, attachments, dates, deadlines, or commitments.
- Preserve any user-entered subject unless the user asks to improve it or it is empty.
- Preserve the meaning of any current draft body. Improve it only according to the user instruction.
- If recipient context is thin, keep the email generally useful and avoid specific claims.
- Never use em dashes. Replace em dashes with commas, periods, colons, semicolons, or parentheses.

User instruction:
${payload.userInstruction}

Current subject in compose:
${payload.composeSubject || "(empty)"}

Visible recipients:
${payload.recipientsVisible.length ? payload.recipientsVisible.join(", ") : "(none visible)"}

Current draft body in compose:
${payload.currentDraft || "(empty)"}
`;
}

function formatNewEmailSchedulingInstructions(payload: ValidNewEmailRequest) {
  const timezone = payload.clientTimezone || "America/New_York";
  if (!hasNewEmailSchedulingIntent(payload)) {
    return ["Scheduling support:", "- No scheduling intent detected."].join("\n");
  }

  return [
    "Scheduling support:",
    "- Scheduling intent detected. Use any available Glean calendar, free/busy, or connected Google Calendar action to check the user's real availability.",
    '- Use calendar identifier "primary" unless the email explicitly names another calendar or attendee calendar.',
    `- Interpret dates and times in timezone ${timezone}.`,
    "- If Glean cannot access calendar availability or no calendar action is available, state that availability still needs to be confirmed instead of pretending a slot is available.",
    "- Do not create or modify calendar events. Only draft the email.",
  ].join("\n");
}

function hasNewEmailSchedulingIntent(payload: ValidNewEmailRequest) {
  const text = [payload.composeSubject, payload.userInstruction, payload.currentDraft]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /\b(schedule|scheduling|calendar|available|availability|free|busy|meet|meeting|call|sync|slot|slots|time|times|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/.test(text);
}
function formatNewEmailUser(payload: ValidNewEmailRequest) {
  const name = payload.currentUser?.name;
  const email = payload.currentUser?.email;
  if (name && email) return `${name} <${email}>`;
  return name || email || "the user";
}

export function buildSlackReplyPrompt(payload: ValidSlackDraftRequest, settings: ReplySettings) {
  const selectedMessages = selectSlackMessages(payload, settings);
  const latestMessage = selectedMessages.find((message) => message.isLatestVisible) ?? selectedMessages.at(-1);
  const priorMessages = selectedMessages.filter((message) => message !== latestMessage);

  return `You are drafting a Slack response for ${formatSlackUser(payload)}.

Draft only from the visible Slack context below. Slack history may be virtualized or missing, so do not assume facts that are not present.

Voice:
${formatVoice(settings)}

Length:
${formatSlackLength(settings)}

Personal writing preferences:
${formatWritingPreferences(settings)}

${formatSlackSchedulingInstructions(payload)}

Rules:
- Return only the Slack message body as plain text.
- Do not include an email subject, greeting, sign-off, signature, or markdown fence.
- Keep the response natural for Slack: concise, conversational, and easy to send.
- Preserve Slack mentions, channel names, links, and quoted names from the context or user instruction.
- The user instruction is private drafting guidance from ${formatSlackUser(payload)}. Use it as the highest-priority intent, but do not quote it verbatim unless it is clearly drafted Slack text.
- If the current draft conflicts with the user instruction, rewrite the draft to follow the user instruction.
- Resolve pronouns and ownership carefully. In user instructions, "me" and "I" usually refer to ${formatSlackUser(payload)}.
- Do not invent commitments, dates, approvals, facts, links, or decisions.
- If the latest ask cannot be answered from context, write a useful Slack reply that acknowledges the ask and proposes a next step.
- Avoid corporate filler.
- Never use em dashes. Replace em dashes with commas, periods, colons, semicolons, or parentheses.
- Do not include working notes, analysis, reasoning, status updates, or alternatives.
- If a current draft is provided, revise that draft according to the user's instruction while preserving facts from the visible Slack context.

User instruction:
${payload.userInstruction || "(none)"}

Current draft in Slack composer:
${payload.currentDraft || "(none)"}

Workspace:
${payload.workspaceName || "(not visible)"}

Channel or DM:
${payload.channelName || "(not visible)"}

Thread title:
${payload.threadTitle || "(not visible)"}

Visible participants:
${payload.participantsVisible.length ? payload.participantsVisible.join(", ") : "(not visible)"}

Most recent visible message:
${formatSlackMessage(latestMessage)}

Prior visible Slack context, oldest to newest:
${priorMessages.length ? priorMessages.map(formatSlackMessage).join("\n\n---\n\n") : "(none)"}
`;
}

function formatSlackSchedulingInstructions(payload: ValidSlackDraftRequest) {
  const timezone = payload.clientTimezone || "America/New_York";
  if (!hasSlackSchedulingIntent(payload)) {
    return ["Scheduling support:", "- No scheduling intent detected."].join("\n");
  }

  return [
    "Scheduling support:",
    "- Scheduling intent detected. Use any available Glean calendar, free/busy, or connected Google Calendar action to check the user's real availability.",
    '- Use calendar identifier "primary" unless the Slack context explicitly names another calendar or attendee calendar.',
    `- Interpret dates and times in timezone ${timezone}.`,
    "- If Glean cannot access calendar availability or no calendar action is available, say the time still needs to be confirmed instead of pretending a slot is available.",
    "- Do not create or modify calendar events. Only draft the Slack response.",
  ].join("\n");
}

export function hasSlackSchedulingIntent(payload: ValidSlackDraftRequest) {
  const text = [
    payload.workspaceName,
    payload.channelName,
    payload.threadTitle,
    payload.userInstruction,
    payload.currentDraft,
    ...payload.messages.map((message) => message.bodyText),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /\b(schedule|scheduling|calendar|available|availability|free|busy|meet|meeting|call|sync|slot|slots|time|times|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/.test(text);
}

function formatSlackUser(payload: ValidSlackDraftRequest) {
  const name = payload.currentUser?.name;
  const email = payload.currentUser?.email;
  if (name && email) return `${name} <${email}>`;
  return name || email || "the user";
}

function formatSlackMessage(message: ValidSlackDraftRequest["messages"][number] | undefined) {
  if (!message) return "(none)";
  return [
    `From: ${message.senderName || message.senderEmail || "unknown"}`,
    message.timestampText ? `Time: ${message.timestampText}` : undefined,
    "",
    message.bodyText,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function selectSlackMessages(payload: ValidSlackDraftRequest, settings: ReplySettings) {
  if (settings.contextDepth === "latest") {
    return [payload.messages.find((message) => message.isLatestVisible) ?? payload.messages.at(-1)].filter(Boolean) as ValidSlackDraftRequest["messages"];
  }

  return payload.messages;
}

function formatSlackLength(settings: ReplySettings) {
  if (settings.defaultLength === "short") return "Keep it short: usually 1-4 Slack-sized sentences unless the context clearly requires more.";
  if (settings.defaultLength === "detailed") return "Use enough detail to fully answer the ask while still sounding natural in Slack.";
  return "Use a medium Slack length: complete, but compact.";
}
