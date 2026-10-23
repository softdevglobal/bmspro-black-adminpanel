import "server-only";
import { adminDb } from "./firebaseAdmin";
import { sendEmail } from "./email";
import { sendSms, isSmsConfigured } from "./smsService";
import { deliverAiBookingReceipt, type AiBookingReceipt, type ReceiptChannel } from "./aiBookingReceipt";

export async function sendAiBookingRequestReceipt(input: AiBookingReceipt) {
  const db = adminDb();
  const reference = (channel: ReceiptChannel) => db.collection("ai_booking_receipts").doc(`${input.bookingId}_${channel}`);
  const result = await deliverAiBookingReceipt(input, {
    async claim(channel) {
      return db.runTransaction(async transaction => {
        const ref = reference(channel);
        const existing = await transaction.get(ref);
        if (existing.exists) return false;
        transaction.create(ref, { bookingId: input.bookingId, ownerUid: input.ownerUid, channel, status: "processing", createdAt: new Date() });
        return true;
      });
    },
    async record(channel, status) {
      await reference(channel).update({ status, updatedAt: new Date() });
    },
    async email(message) {
      // Booking messages use Black's request sender, separately from onboarding.
      if (!(process.env.ZEPTOMAIL_REQUEST_TOKEN || process.env.ZEPTOMAIL_TOKEN)) return "skipped";
      const sent = await sendEmail({ sender: "request", to: message.to, subject: message.subject, htmlBody: message.html });
      return sent.ok ? "accepted" : "unknown";
    },
    async sms(message) {
      if (!isSmsConfigured()) return "skipped";
      const sent = await sendSms({ to: message.to, message: message.message, ownerUid: input.ownerUid,
        source: "ai_booking_request_receipt", senderName: input.workshopName, receiverName: input.customerName });
      return sent.success ? "accepted" : sent.skipped ? "skipped" : "unknown";
    },
  });
  console.log("[ai-booking-receipt] Provider acceptance", { bookingId: input.bookingId, ...result });
  return result;
}
