import assert from "node:assert/strict";
import test from "node:test";
import { bookingReceiptContent, deliverAiBookingReceipt, type AiBookingReceipt, type ReceiptChannel, type ReceiptDependencies } from "../lib/aiBookingReceipt.js";

const booking: AiBookingReceipt = {
  bookingId: "booking-a", bookingCode: "BK-123", ownerUid: "owner-a", workshopName: "Test Workshop",
  branchName: "Main", date: "2026-11-01", time: "09:00", timezone: "Australia/Sydney",
  customerName: "Customer", customerEmail: "customer@example.test", customerPhone: "+61400000000",
  services: ["Oil service"], vehicleNumber: "ABC123", totalPrice: 120,
};
function fixture() {
  const states = new Map<ReceiptChannel, string>();
  const sent: string[] = [];
  const deps: ReceiptDependencies = {
    async claim(channel) { if (states.has(channel)) return false; states.set(channel, "processing"); return true; },
    async record(channel, status) { states.set(channel, status); },
    async email(input) { sent.push(`email:${input.to}`); return "accepted"; },
    async sms(input) { sent.push(`sms:${input.to}`); return "accepted"; },
  };
  return { states, sent, deps };
}

test("booking receipt contains customer details and pending approval wording with escaped email content", () => {
  const content = bookingReceiptContent({ ...booking, customerName: "<script>" });
  for (const value of ["BK-123", "Main", "2026-11-01", "09:00", "Australia/Sydney", "Oil service", "ABC123", "120.00"])
    assert.ok(content.html.includes(value) && content.sms.includes(value));
  assert.match(content.html, /pending staff approval/);
  assert.match(content.sms, /not confirmed/);
  assert.ok(content.html.includes("&lt;script&gt;") && !content.html.includes("<script>"));
});

test("concurrent receipt attempts send each channel once using the saved customer contacts", async () => {
  const f = fixture();
  await Promise.all([deliverAiBookingReceipt(booking, f.deps), deliverAiBookingReceipt(booking, f.deps)]);
  assert.deepEqual(f.sent.sort(), [`email:${booking.customerEmail}`, `sms:${booking.customerPhone}`]);
  const replay = await deliverAiBookingReceipt(booking, { ...f.deps });
  assert.deepEqual(replay, { email: "already_attempted", sms: "already_attempted" });
  assert.equal(f.sent.length, 2);
});

test("email failure does not block SMS and uncertain attempts are not automatically resent", async () => {
  const f = fixture();
  f.deps.email = async () => { throw new Error("provider outcome uncertain"); };
  const result = await deliverAiBookingReceipt(booking, f.deps);
  assert.deepEqual(result, { email: "unknown", sms: "accepted" });
  assert.equal(f.states.get("email"), "unknown");
  assert.equal(f.sent.length, 1);
  await deliverAiBookingReceipt(booking, f.deps);
  assert.equal(f.sent.length, 1);
});

test("missing contact skips that channel without blocking the other; failed claim never sends", async () => {
  const f = fixture();
  const missing = await deliverAiBookingReceipt({ ...booking, customerEmail: "" }, f.deps);
  assert.deepEqual(missing, { email: "skipped", sms: "accepted" });
  const g = fixture();
  g.deps.claim = async () => { throw new Error("database unavailable"); };
  const result = await deliverAiBookingReceipt(booking, g.deps);
  assert.deepEqual(result, { email: "storage_unavailable", sms: "storage_unavailable" });
  assert.equal(g.sent.length, 0);
});
