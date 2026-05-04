import type { ValidDraftRequest } from "./schema.js";

export function buildReplyPrompt(payload: ValidDraftRequest) {
  const latestMessage = payload.messages.find((message) => message.isLatestVisible) ?? payload.messages.at(-1);
  const priorMessages = payload.messages.filter((message) => message !== latestMessage);

  return `You are drafting an email reply for ${formatUser(payload)}.

Draft only from the visible Gmail thread context below. Some quoted history may be collapsed or missing, so do not assume facts that are not present.

Voice:
- concise
- direct
- professional
- action-oriented
- sendable with light editing

Rules:
- Return only the reply draft body as plain text.
- Do not include a subject line.
- Do not invent commitments, dates, attachments, approvals, or facts.
- If the latest ask cannot be answered from context, write a useful reply that acknowledges the ask and proposes a next step.
- Avoid overly formal filler.
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
