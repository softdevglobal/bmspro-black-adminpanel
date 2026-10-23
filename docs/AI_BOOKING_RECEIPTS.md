# AI booking request receipts

The authenticated call-center booking POST sends customer email and SMS after
an AI booking is durably committed. It uses the saved canonical customer contacts
and includes the reference, workshop/branch, requested drop-off date/time and
timezone, service names, registration and quoted total. Both channels explicitly
say the request is pending staff approval, not a confirmed appointment.

Deploy the Black admin panel and the updated `firestore.rules` for this change.
The legacy catch-all excludes the receipt ledger so clients cannot alter send claims.
No Command Centre backend or voice
bridge deployment is required. Email uses Black's existing ZeptoMail `request`
sender (`ZEPTOMAIL_REQUEST_TOKEN`, or `ZEPTOMAIL_TOKEN` fallback, and its authorized
sender settings). SMS uses Black's existing TextBee configuration and per-workshop
SMS credit checks. These are separate from the backend's onboarding sender.
No new environment variables or SQL migration is required.

Email and SMS run independently, so an email failure does not suppress SMS.
Provider acceptance is not proof of inbox/handset delivery. A server-only
`ai_booking_receipts` Firestore document per booking/channel claims each send
before contacting a provider. Replays do not send another receipt; interrupted
or uncertain sends require staff to inspect provider history before resending.
No background retry worker is provided. Receipt failures do not reject the saved
booking. Existing account welcome messages remain separate and contain login
information rather than this booking receipt.

Offline checks use fake stores/providers and do not create bookings or send messages:

```bash
node --import tsx --test tests/ai-booking-receipt.test.ts tests/ai-booking-commit.test.ts
```
