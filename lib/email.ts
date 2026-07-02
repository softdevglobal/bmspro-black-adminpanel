import "server-only";

import { SendMailClient } from "zeptomail";

const ZEPTOMAIL_URL =
  process.env.ZEPTOMAIL_URL ?? "https://api.zeptomail.com.au/v1.1/email";

/**
 * Two separate ZeptoMail senders, each backed by its own mail-agent token:
 *  - `system`  → noreply@bmspros.com.au (account creation, onboarding, etc.)
 *  - `request` → request@bmspros.com.au (inspection / booking request updates)
 */
export type EmailSender = "system" | "request";

type SenderConfig = {
  token: string;
  fromAddress: string;
  fromName: string;
};

function readSenderConfig(sender: EmailSender): SenderConfig {
  if (sender === "request") {
    return {
      token:
        process.env.ZEPTOMAIL_REQUEST_TOKEN ??
        process.env.ZEPTOMAIL_TOKEN ??
        "",
      fromAddress:
        process.env.ZEPTOMAIL_REQUEST_FROM_ADDRESS ?? "request@bmspros.com.au",
      fromName: process.env.ZEPTOMAIL_REQUEST_FROM_NAME ?? "BMS Pro Black",
    };
  }
  return {
    token:
      process.env.ZEPTOMAIL_SYSTEM_TOKEN ?? process.env.ZEPTOMAIL_TOKEN ?? "",
    fromAddress:
      process.env.ZEPTOMAIL_SYSTEM_FROM_ADDRESS ?? "noreply@bmspros.com.au",
    fromName: process.env.ZEPTOMAIL_SYSTEM_FROM_NAME ?? "BMS Pro Black",
  };
}

const clientCache = new Map<string, SendMailClient>();

function getClient(token: string): SendMailClient | null {
  if (!token) return null;
  let client = clientCache.get(token);
  if (!client) {
    client = new SendMailClient({ url: ZEPTOMAIL_URL, token });
    clientCache.set(token, client);
  }
  return client;
}

/** A file to attach to the email. `content` must be base64-encoded. */
export type EmailAttachment = {
  content: string;
  mimeType: string;
  name: string;
};

export type SendEmailInput = {
  /** Which sender mailbox to send from. Defaults to the system mailbox. */
  sender?: EmailSender;
  to: string;
  toName?: string | null;
  subject: string;
  htmlBody: string;
  replyTo?: string | null;
  attachments?: EmailAttachment[];
};

export function isZeptoMailConfigured(): boolean {
  return !!(
    process.env.ZEPTOMAIL_SYSTEM_TOKEN ||
    process.env.ZEPTOMAIL_REQUEST_TOKEN ||
    process.env.ZEPTOMAIL_TOKEN
  );
}

export type SendEmailResult =
  | { ok: true }
  | { ok: false; message: string; code?: string };

function parseZeptoMailError(error: unknown): { message: string; code?: string } {
  if (error && typeof error === "object") {
    const root = error as Record<string, unknown>;
    const payload =
      (root.error as Record<string, unknown> | undefined)?.error ??
      root.error ??
      root;
    if (payload && typeof payload === "object") {
      const body = payload as Record<string, unknown>;
      const message =
        typeof body.message === "string" ? body.message : undefined;
      const code = typeof body.code === "string" ? body.code : undefined;
      if (message) {
        return { message, code };
      }
    }
  }
  if (error instanceof Error && error.message) {
    return { message: error.message };
  }
  return { message: "ZeptoMail delivery failed" };
}

/**
 * Sends a transactional email through ZeptoMail. Best-effort: never throws so
 * notification flows are not blocked when email delivery fails or is not
 * configured.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const sender = input.sender ?? "system";
  const config = readSenderConfig(sender);
  const client = getClient(config.token);
  const recipient = input.to?.trim();

  if (!recipient) {
    console.warn("[email] skipped — no recipient address.", {
      sender,
      subject: input.subject,
    });
    return { ok: false, message: "No recipient address" };
  }

  if (!client) {
    console.warn(`[email] skipped — no token for "${sender}" sender.`, {
      subject: input.subject,
      to: recipient,
    });
    return {
      ok: false,
      message: `ZeptoMail is not configured for the "${sender}" sender`,
    };
  }

  console.log("[email] sending…", {
    sender,
    from: config.fromAddress,
    to: recipient,
    subject: input.subject,
  });

  try {
    const replyTo = input.replyTo?.trim();
    const attachments =
      input.attachments && input.attachments.length > 0
        ? input.attachments.map((file) => ({
            content: file.content,
            mime_type: file.mimeType,
            name: file.name,
          }))
        : null;
    await client.sendMail({
      from: { address: config.fromAddress, name: config.fromName },
      to: [
        {
          email_address: {
            address: recipient,
            name: input.toName?.trim() || recipient,
          },
        },
      ],
      subject: input.subject,
      htmlbody: input.htmlBody,
      ...(replyTo
        ? { reply_to: [{ address: replyTo, name: replyTo }] }
        : {}),
      ...(attachments ? { attachments } : {}),
    });
    console.log("[email] sent OK", {
      sender,
      from: config.fromAddress,
      to: recipient,
      subject: input.subject,
    });
    return { ok: true };
  } catch (error) {
    const parsed = parseZeptoMailError(error);
    console.error("[email] send FAILED", {
      sender,
      from: config.fromAddress,
      to: recipient,
      subject: input.subject,
      code: parsed.code,
      message: parsed.message,
      error,
    });
    return { ok: false, ...parsed };
  }
}

/** Route legacy `from` addresses to the correct ZeptoMail sender mailbox. */
export function senderForFromAddress(from: string): EmailSender {
  const normalized = from.trim().toLowerCase();
  if (
    normalized.includes("noreply") ||
    normalized === "noreply@bmspros.com.au"
  ) {
    return "system";
  }
  return "request";
}

export type LegacyMailMessage = {
  to: string;
  from: string;
  subject: string;
  html: string;
  attachments?: Array<{
    content: string;
    filename?: string;
    name?: string;
    type?: string;
    mimeType?: string;
  }>;
};

/** Adapter used by `emailService.ts` (replaces SendGrid `sgMail.send`). */
export async function dispatchMail(msg: LegacyMailMessage): Promise<void> {
  const attachments: EmailAttachment[] | undefined = msg.attachments?.map(
    (file) => ({
      content: file.content,
      mimeType: file.type || file.mimeType || "application/octet-stream",
      name: file.filename || file.name || "attachment",
    })
  );

  const result = await sendEmail({
    sender: senderForFromAddress(msg.from),
    to: msg.to,
    subject: msg.subject,
    htmlBody: msg.html,
    attachments,
  });

  if (!result.ok) {
    const detail = result.code
      ? `${result.code}: ${result.message}`
      : result.message;
    throw new Error(detail);
  }
}
