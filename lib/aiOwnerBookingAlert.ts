import "server-only";

import { adminDb } from "@/lib/firebaseAdmin";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/smsService";
import { renderSophieOwnerEmail } from "@/lib/sophieOwnerEmail";

export type AiOwnerBookingAlert = {
  ownerUid: string;
  bookingCode: string;
  clientName: string;
  branchName?: string | null;
  serviceNames: string[];
  date: string;
  time: string;
  status: string;
  confirmed: boolean;
  staffNames?: string[];
};

/** Best-effort email and SMS to the workshop owner after an AI booking action. */
export async function sendAiOwnerBookingAlert(input: AiOwnerBookingAlert): Promise<void> {
  try {
    const ownerSnap = await adminDb().collection("users").doc(input.ownerUid).get();
    const owner = ownerSnap.data() ?? {};
    const email = [owner.email, owner.ownerEmail].find(value => typeof value === "string" && value.trim()) as string | undefined;
    const phone = [owner.contactPhone, owner.phone, owner.phoneNumber, owner.mobile].find(value => typeof value === "string" && value.trim()) as string | undefined;
    const title = input.confirmed ? "Sophie confirmed a booking" : "Sophie created a booking request";
    const services = input.serviceNames.filter(Boolean).join(", ") || "Service request";
    const staff = input.staffNames?.filter(Boolean).join(", ") || "Not assigned";
    console.info("[ai-owner-alert] Sending owner booking alert.", {
      bookingCode: input.bookingCode,
      status: input.status,
      emailPresent: Boolean(email),
      phonePresent: Boolean(phone),
    });
    const tasks: Promise<unknown>[] = [];
    const channels: string[] = [];
    if (email) {
      channels.push("email");
      tasks.push(sendEmail({
        sender: "sophie",
        to: email,
        toName: typeof owner.name === "string" ? owner.name : undefined,
        subject: `${title} · ${input.bookingCode}`,
        htmlBody: renderSophieOwnerEmail({
          product: "black",
          confirmed: input.confirmed,
          reference: input.bookingCode,
          ownerName: owner.name || owner.displayName,
          businessName: owner.workshopName || owner.salonName || owner.businessName,
          customerName: input.clientName,
          serviceNames: input.serviceNames,
          date: input.date,
          time: input.time,
          branchName: input.branchName,
          staffNames: input.staffNames,
        }),
      }));
    }
    if (phone) {
      channels.push("sms");
      tasks.push(sendSms({
        to: phone,
        ownerUid: input.ownerUid,
        source: "sophie_booking_owner_alert",
        senderName: "BMS Pro Black",
        receiverName: typeof owner.name === "string" ? owner.name : "Workshop owner",
        message: `${title}. ${input.bookingCode}: ${input.clientName}, ${services}, ${input.date} ${input.time}. ${input.confirmed ? `Staff: ${staff}.` : "Please review the request."}`,
      }));
    }
    const results = await Promise.allSettled(tasks);
    results.forEach((result, index) => {
      const value = result.status === "fulfilled" ? result.value as { ok?: boolean; success?: boolean; skipped?: boolean; message?: string; error?: string; statusDetail?: string } : undefined;
      const accepted = value?.ok === true || value?.success === true;
      const details = {
        bookingCode: input.bookingCode,
        channel: channels[index],
        accepted,
        skipped: value?.skipped === true,
        detail: value?.message || value?.error || value?.statusDetail || (result.status === "rejected" ? String(result.reason) : undefined),
      };
      if (accepted) console.info("[ai-owner-alert] Provider accepted owner alert.", details);
      else console.warn("[ai-owner-alert] Owner alert was not accepted.", details);
    });
    if (!email) console.warn("[ai-owner-alert] Email skipped: owner profile has no email.", { ownerUid: input.ownerUid });
    if (!phone) console.warn("[ai-owner-alert] SMS skipped: owner profile has no phone.", { ownerUid: input.ownerUid });
    if (!email && !phone) console.warn("[ai-owner-alert] Owner has no email or phone on their profile.", { ownerUid: input.ownerUid });
  } catch (error) {
    console.error("[ai-owner-alert] Could not send owner alert.", { bookingCode: input.bookingCode, error });
  }
}
