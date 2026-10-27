export type SophieOwnerEmailInput = {
  product: "black" | "trade";
  confirmed: boolean;
  reference: string;
  ownerName?: string | null;
  businessName?: string | null;
  customerName: string;
  serviceNames: string[];
  date?: string | null;
  time?: string | null;
  branchName?: string | null;
  staffNames?: string[];
};

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]!));
}

function calendarDate(value?: string | null): string {
  if (!value) return "To be arranged";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value + "T12:00:00Z");
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-AU", {
    weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(parsed);
}

/** Table layout and inline styles keep the owner alert usable in email clients. */
export function renderSophieOwnerEmail(input: SophieOwnerEmailInput): string {
  const trade = input.product === "trade";
  const brand = trade ? "BMS PRO TRADE" : "BMS PRO BLACK";
  const accent = trade ? "#2563eb" : "#b7791f";
  const state = input.confirmed ? (trade ? "Visit scheduled" : "Booking confirmed") : "Your review is needed";
  const title = input.confirmed ? (trade ? "A visit, taken care of." : "A booking, taken care of.") : "A new request for you.";
  const lead = input.confirmed
    ? (trade ? "I've scheduled the inspection and assigned an available team member." : "I've confirmed the booking and assigned available staff to the services.")
    : "I've saved this request. Please review the details and arrange the next step in your dashboard.";
  const badgeBg = input.confirmed ? "#e8f5ee" : "#fff3d6";
  const badgeText = input.confirmed ? "#236345" : "#895c0b";
  const staff = [...new Set(input.staffNames?.filter(Boolean) || [])].join(", ");
  const rows = [
    { label: "Customer", value: input.customerName },
    { label: input.serviceNames.length > 1 ? "Services" : "Service", value: input.serviceNames.filter(Boolean).join(", ") || "Service request" },
    ...(input.branchName ? [{ label: "Branch", value: input.branchName }] : []),
  ];
  const details = rows.map(row => `<tr><td class="detail-label" width="112" style="padding:15px 0;vertical-align:top;border-bottom:1px solid #edf0f2;color:#78818e;font-size:13px;">${escape(row.label)}</td><td style="padding:15px 0;border-bottom:1px solid #edf0f2;color:#202a37;font-size:14px;font-weight:600;line-height:1.6;overflow-wrap:anywhere;">${escape(row.value)}</td></tr>`).join("");
  const preheader = `${state} · ${input.reference} · ${input.customerName}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(state)}</title>
<style>@media only screen and (max-width:620px){.outer{padding:16px 8px!important}.content{padding:28px 22px!important}.header{padding:25px 22px!important}.headline{font-size:30px!important}.detail-label{width:86px!important}.schedule-cell{display:block!important;width:auto!important;padding:0!important}.schedule-right{padding-top:18px!important;border-left:0!important}.footer{padding:22px!important}}</style></head>
<body style="margin:0;padding:0;background:#f2f3f5;font-family:Arial,Helvetica,sans-serif;color:#202a37;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;"><tr><td class="outer" align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 8px 15px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:11px;font-weight:700;letter-spacing:1.8px;color:#687382;">${brand}</td><td align="right" style="font-size:11px;color:#87919e;">OWNER UPDATE</td></tr></table></td></tr>
<tr><td style="border:1px solid #e4e7eb;border-radius:20px;overflow:hidden;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td class="header" bgcolor="#17212d" style="padding:30px 36px;background:#17212d;border-top:4px solid ${accent};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="52" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="42" height="42" bgcolor="#f4dca7" style="width:42px;height:42px;border-radius:13px;background:#f4dca7;color:#28313b;font-size:24px;font-weight:700;">S</td></tr></table></td><td valign="middle"><p style="margin:0;color:#ffffff;font-size:21px;font-weight:700;letter-spacing:-0.4px;">Sophie</p><p style="margin:5px 0 0;color:#aeb8c4;font-size:12px;">Your AI receptionist</p></td><td align="right" valign="middle" style="color:#d7dee7;font-size:11px;line-height:1.8;">${escape(input.businessName || (trade ? "Your business" : "Your workshop"))}</td></tr></table>
</td></tr>
<tr><td class="content" style="padding:34px 36px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${badgeBg}" style="padding:7px 12px;border-radius:6px;background:${badgeBg};color:${badgeText};font-size:11px;line-height:1.5;font-weight:700;letter-spacing:0.3px;">${input.confirmed ? "&#10003; &nbsp;" : "&#8226; &nbsp;"}${escape(state)}</td></tr></table>
<h1 class="headline" style="margin:20px 0 14px;font-size:35px;line-height:1.2;letter-spacing:-1.2px;font-weight:700;color:#17212d;">${escape(title)}</h1>
<p style="margin:0 0 8px;color:#243242;font-size:14px;line-height:1.8;">Hi ${escape(input.ownerName?.trim() || "there")},</p>
<p style="margin:0 0 26px;color:#667281;font-size:14px;line-height:1.8;">${escape(lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f7f8fa" style="background:#f7f8fa;border:1px solid #e8ebef;border-radius:12px;"><tr><td style="padding:20px 22px;">
<p style="margin:0 0 8px;color:#7b8592;font-size:10px;font-weight:700;letter-spacing:1.4px;">${trade ? "INSPECTION REFERENCE" : "BOOKING REFERENCE"}</p>
<p style="margin:0;color:#263445;font-family:Consolas,'Courier New',monospace;font-size:17px;font-weight:700;line-height:1.5;overflow-wrap:anywhere;">${escape(input.reference)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">${details}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr>
<td class="schedule-cell" width="55%" valign="top" style="padding:0 18px 0 0;"><p style="margin:0 0 8px;color:#7b8592;font-size:10px;font-weight:700;letter-spacing:1.2px;">DATE</p><p style="margin:0;color:#263445;font-size:14px;font-weight:600;line-height:1.6;">${escape(calendarDate(input.date))}</p></td>
<td class="schedule-cell schedule-right" width="45%" valign="top" style="padding:0 0 0 20px;border-left:1px solid #e8ebef;"><p style="margin:0 0 8px;color:#7b8592;font-size:10px;font-weight:700;letter-spacing:1.2px;">${trade ? "VISIT WINDOW" : "DROP-OFF / PICK-UP"}</p><p style="margin:0;color:#263445;font-size:14px;font-weight:600;line-height:1.6;">${escape(input.time || "To be arranged")}</p></td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;background:${input.confirmed ? "#eef6f1" : "#fff8e9"};border-left:3px solid ${input.confirmed ? "#428263" : "#d6a44a"};"><tr><td style="padding:17px 18px;">
<p style="margin:0 0 6px;color:${badgeText};font-size:12px;font-weight:700;">${input.confirmed ? "Your team is assigned" : "Next step: review this request"}</p>
<p style="margin:0;color:#586777;font-size:13px;line-height:1.7;">${escape(input.confirmed ? (staff || "Staff assignment is saved with the request.") : "Open your dashboard to review availability and confirm the request when you are ready.")}</p>
</td></tr></table>
<p style="margin:27px 0 0;color:#667281;font-size:13px;line-height:1.8;">I'll keep you updated.<br><strong style="color:#263445;">Sophie</strong></p>
</td></tr>
<tr><td class="footer" style="padding:21px 36px;border-top:1px solid #edf0f2;background:#fafbfc;"><p style="margin:0;color:#8b94a0;font-size:11px;line-height:1.8;">Sent by Sophie for ${escape(input.businessName || (trade ? "your business" : "your workshop"))}.<br>You received this update as the business owner.</p></td></tr>
</table></td></tr>
<tr><td align="center" style="padding:19px 10px 0;color:#939ca8;font-size:10px;letter-spacing:0.4px;">${brand} &nbsp; / &nbsp; A little less admin. A little more time.</td></tr>
</table></td></tr></table></body></html>`;
}

