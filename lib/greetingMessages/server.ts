import { adminDb } from "@/lib/firebaseAdmin";
import { createAuditLogServer } from "@/lib/auditLogServer";
import { isSmsConfigured, normalizeSmsRecipient, sendSms } from "@/lib/smsService";
import {
  type GreetingAudience,
  type GreetingRecipient,
  type GreetingSendResult,
  MAX_GREETING_MESSAGE_LENGTH,
} from "@/lib/greetingMessages/types";

const RECIPIENT_SCAN_LIMIT = 2000;
const STAFF_ROLES = new Set(["staff", "branch_admin"]);

function pickName(data: Record<string, unknown>, fallback: string): string {
  const name = String(
    data.name || data.displayName || data.fullName || data.client || fallback,
  ).trim();
  return name || fallback;
}

function pickPhone(data: Record<string, unknown>): string | null {
  const raw = String(data.phone || data.clientPhone || data.mobile || "").trim();
  return raw || null;
}

function dedupeRecipients(rows: GreetingRecipient[]): GreetingRecipient[] {
  const seen = new Set<string>();
  const out: GreetingRecipient[] = [];
  for (const row of rows) {
    const normalized = normalizeSmsRecipient(row.phone);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ ...row, phone: normalized });
  }
  return out;
}

export async function loadCustomerRecipients(ownerUid: string): Promise<GreetingRecipient[]> {
  const snap = await adminDb()
    .collection("customers")
    .where("ownerUid", "==", ownerUid)
    .limit(RECIPIENT_SCAN_LIMIT)
    .get();

  const rows: GreetingRecipient[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const status = String(data.status || "Active").toLowerCase();
    if (status === "inactive") continue;
    const phone = pickPhone(data);
    if (!phone) continue;
    rows.push({
      id: doc.id,
      name: pickName(data, "Customer"),
      phone,
      type: "customer",
    });
  }
  return dedupeRecipients(rows);
}

export async function loadStaffRecipients(ownerUid: string): Promise<GreetingRecipient[]> {
  const snap = await adminDb()
    .collection("users")
    .where("ownerUid", "==", ownerUid)
    .limit(RECIPIENT_SCAN_LIMIT)
    .get();

  const rows: GreetingRecipient[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const role = String(data.role || data.systemRole || "").toLowerCase();
    if (!STAFF_ROLES.has(role)) continue;
    const status = String(data.status || "Active");
    if (status === "Suspended" || data.suspended === true) continue;
    const phone = pickPhone(data);
    if (!phone) continue;
    rows.push({
      id: doc.id,
      name: pickName(data, "Team member"),
      phone,
      type: "staff",
    });
  }
  return dedupeRecipients(rows);
}

export async function loadGreetingRecipients(
  ownerUid: string,
  audience: GreetingAudience,
): Promise<GreetingRecipient[]> {
  if (audience === "customers") return loadCustomerRecipients(ownerUid);
  if (audience === "staff") return loadStaffRecipients(ownerUid);
  return dedupeRecipients([
    ...(await loadCustomerRecipients(ownerUid)),
    ...(await loadStaffRecipients(ownerUid)),
  ]);
}

export function personalizeGreetingMessage(template: string, recipientName: string): string {
  const name = recipientName.trim() || "there";
  return template.replace(/\{name\}/gi, name);
}

export async function sendGreetingMessages(args: {
  ownerUid: string;
  audience: GreetingAudience;
  message: string;
  performedBy: string;
  performedByName?: string;
}): Promise<GreetingSendResult> {
  const template = args.message.trim();
  if (!template) {
    throw new Error("Message is required");
  }
  if (template.length > MAX_GREETING_MESSAGE_LENGTH) {
    throw new Error(`Message must be ${MAX_GREETING_MESSAGE_LENGTH} characters or fewer`);
  }
  if (!isSmsConfigured()) {
    throw new Error("SMS is not configured. Add TEXTBEE_API_KEY and TEXTBEE_DEVICE_ID to your environment.");
  }

  const recipients = await loadGreetingRecipients(args.ownerUid, args.audience);
  const result: GreetingSendResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    total: recipients.length,
    errors: [],
  };

  for (const recipient of recipients) {
    const body = personalizeGreetingMessage(template, recipient.name);
    const sms = await sendSms({
      to: recipient.phone,
      message: body,
      context: `custom SMS to ${recipient.type} ${recipient.id}`,
    });

    if (sms.success) {
      result.sent += 1;
    } else if (sms.skipped) {
      result.skipped += 1;
    } else {
      result.failed += 1;
      if (result.errors.length < 5 && sms.error) {
        result.errors.push(`${recipient.name}: ${sms.error}`);
      }
    }
  }

  await createAuditLogServer({
    ownerUid: args.ownerUid,
    action: "Custom SMS sent",
    actionType: "other",
    entityType: "customer",
    performedBy: args.performedBy,
    performedByName: args.performedByName,
    performedByRole: "workshop_owner",
    details: `Audience: ${args.audience}. Sent ${result.sent}/${result.total}.`,
    metadata: {
      audience: args.audience,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
      total: result.total,
      messagePreview: template.slice(0, 120),
    },
  });

  return result;
}
