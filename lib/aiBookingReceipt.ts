export type ReceiptChannel = "email" | "sms";
export type ReceiptState = "accepted" | "skipped" | "unknown" | "already_attempted" | "storage_unavailable";
export type AiBookingReceipt = {
  bookingId: string; bookingCode: string; ownerUid: string; workshopName: string;
  branchName: string; date: string; time: string; timezone: string;
  customerName: string; customerEmail: string; customerPhone: string;
  services: string[]; vehicleNumber: string; totalPrice: number;
};
export interface ReceiptDependencies {
  claim(channel: ReceiptChannel): Promise<boolean>;
  record(channel: ReceiptChannel, status: ReceiptState): Promise<void>;
  email(input: { to: string; subject: string; html: string }): Promise<ReceiptState>;
  sms(input: { to: string; message: string }): Promise<ReceiptState>;
}
const html = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function bookingReceiptContent(input: AiBookingReceipt) {
  const details = [
    ["Reference", input.bookingCode], ["Workshop", input.workshopName], ["Branch", input.branchName],
    ["Requested drop-off", `${input.date} ${input.time} (${input.timezone})`],
    ["Services", input.services.join(", ")], ["Vehicle", input.vehicleNumber],
    ["Quoted total", Number.isFinite(input.totalPrice) ? `AUD ${input.totalPrice.toFixed(2)}` : "Staff will verify"],
  ];
  const pending = "Your booking request was received and is pending staff approval. The requested drop-off time is not confirmed. The workshop will contact you to confirm.";
  return {
    subject: `Booking request received — ${input.workshopName} (${input.bookingCode})`,
    html: `<p>Hello ${html(input.customerName)},</p><p>${pending}</p><table>${details.map(([label, value]) => `<tr><th align="left">${html(label!)}</th><td>${html(value!)}</td></tr>`).join("")}</table>`,
    sms: `${input.workshopName}: Request ${input.bookingCode} received, pending staff approval. Requested drop-off: ${input.date} ${input.time} (${input.timezone}). Branch: ${input.branchName}. Services: ${input.services.join(", ")}. Vehicle: ${input.vehicleNumber}. Quoted total: ${Number.isFinite(input.totalPrice) ? `AUD ${input.totalPrice.toFixed(2)}` : "staff will verify"}. This time is not confirmed; staff will contact you.`,
  };
}

/** Channels run independently. Claims persist before provider calls; uncertain sends are not retried. */
export async function deliverAiBookingReceipt(input: AiBookingReceipt, dependencies: ReceiptDependencies) {
  const content = bookingReceiptContent(input);
  const send = async (channel: ReceiptChannel): Promise<ReceiptState> => {
    try {
      if (!await dependencies.claim(channel)) return "already_attempted";
      let status: ReceiptState;
      try {
        status = channel === "email"
          ? input.customerEmail ? await dependencies.email({ to: input.customerEmail, subject: content.subject, html: content.html }) : "skipped"
          : input.customerPhone ? await dependencies.sms({ to: input.customerPhone, message: content.sms }) : "skipped";
      } catch { status = "unknown"; }
      await dependencies.record(channel, status);
      return status;
    } catch { return "storage_unavailable"; }
  };
  const [email, sms] = await Promise.all([send("email"), send("sms")]);
  return { email, sms };
}
