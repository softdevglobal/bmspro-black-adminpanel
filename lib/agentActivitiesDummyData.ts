export type AgentActivityType =
  | "call_answered"
  | "call_missed"
  | "call_outbound"
  | "chat_claimed"
  | "chat_closed"
  | "notification_reviewed"
  | "customer_called";

export type AgentActivity = {
  id: string;
  type: AgentActivityType;
  agentName: string;
  agentEmail: string;
  workshopName: string;
  customerName: string;
  customerPhone: string;
  direction?: "inbound" | "outbound";
  purpose?: string;
  outcome?: string;
  durationSeconds?: number;
  notes?: string;
  callAnswer?: string;
  bookingCode?: string;
  timestamp: Date;
  status: "completed" | "missed" | "in_progress";
};

const hoursAgo = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(d.getHours() - h, d.getMinutes() - m, 0, 0);
  return d;
};

export const DUMMY_AGENT_ACTIVITIES: AgentActivity[] = [
  {
    id: "act-001",
    type: "call_answered",
    agentName: "Sarah Mitchell",
    agentEmail: "sarah.m@callcenter.bmspro.com",
    workshopName: "Precision Auto Sydney",
    customerName: "James Wilson",
    customerPhone: "+61 412 345 678",
    direction: "inbound",
    purpose: "booking",
    outcome: "booking_created",
    durationSeconds: 342,
    notes: "Customer requested oil change + brake inspection for next Tuesday.",
    callAnswer:
      "Confirmed availability at Parramatta branch, 9:30 AM slot. Sent SMS confirmation and added vehicle rego to booking.",
    bookingCode: "BMS-28471",
    timestamp: hoursAgo(0, 25),
    status: "completed",
  },
  {
    id: "act-002",
    type: "call_answered",
    agentName: "David Chen",
    agentEmail: "david.c@callcenter.bmspro.com",
    workshopName: "Metro Mechanics Melbourne",
    customerName: "Emma Thompson",
    customerPhone: "+61 423 891 204",
    direction: "inbound",
    purpose: "progress_check",
    outcome: "info_provided",
    durationSeconds: 198,
    notes: "Customer asked if car is ready for pickup.",
    callAnswer:
      "Checked workshop dashboard — vehicle still on hoist for transmission service. Estimated ready by 4 PM today. Customer will call back at 3:30 PM.",
    bookingCode: "BMS-28102",
    timestamp: hoursAgo(1, 10),
    status: "completed",
  },
  {
    id: "act-003",
    type: "call_missed",
    agentName: "Sarah Mitchell",
    agentEmail: "sarah.m@callcenter.bmspro.com",
    workshopName: "Coastal Car Care Brisbane",
    customerName: "Unknown caller",
    customerPhone: "+61 407 552 991",
    direction: "inbound",
    purpose: "general_inquiry",
    outcome: "callback_scheduled",
    durationSeconds: 0,
    notes: "Missed during peak — voicemail left. Callback queued for Sarah.",
    callAnswer: "—",
    timestamp: hoursAgo(1, 45),
    status: "missed",
  },
  {
    id: "act-004",
    type: "call_outbound",
    agentName: "Priya Sharma",
    agentEmail: "priya.s@callcenter.bmspro.com",
    workshopName: "Elite Workshop Perth",
    customerName: "Michael O'Brien",
    customerPhone: "+61 401 778 332",
    direction: "outbound",
    purpose: "extra_work_approval",
    outcome: "extra_work_accepted",
    durationSeconds: 415,
    notes: "Follow-up on additional brake rotor replacement quote.",
    callAnswer:
      "Explained quote breakdown ($480 parts + labour). Customer approved extra work via phone; updated booking and notified branch manager.",
    bookingCode: "BMS-27988",
    timestamp: hoursAgo(2, 30),
    status: "completed",
  },
  {
    id: "act-005",
    type: "notification_reviewed",
    agentName: "David Chen",
    agentEmail: "david.c@callcenter.bmspro.com",
    workshopName: "Precision Auto Sydney",
    customerName: "Lisa Nguyen",
    customerPhone: "+61 498 221 045",
    purpose: "estimate_approval",
    outcome: "reviewed",
    notes: "Opened estimate notification — customer approved $1,240 major service online.",
    callAnswer: "Marked notification as reviewed. No call required — customer self-approved in portal.",
    bookingCode: "BMS-28350",
    timestamp: hoursAgo(3),
    status: "completed",
  },
  {
    id: "act-006",
    type: "customer_called",
    agentName: "Priya Sharma",
    agentEmail: "priya.s@callcenter.bmspro.com",
    workshopName: "Metro Mechanics Melbourne",
    customerName: "Robert Clarke",
    customerPhone: "+61 433 667 890",
    direction: "outbound",
    purpose: "complaint",
    outcome: "resolved",
    durationSeconds: 521,
    notes: "Customer unhappy about delayed pickup from last week.",
    callAnswer:
      "Apologised for delay, offered 10% discount on next service. Customer satisfied. Logged complaint resolution in CRM notes.",
    timestamp: hoursAgo(4, 15),
    status: "completed",
  },
  {
    id: "act-007",
    type: "chat_claimed",
    agentName: "Sarah Mitchell",
    agentEmail: "sarah.m@callcenter.bmspro.com",
    workshopName: "Coastal Car Care Brisbane",
    customerName: "Workshop Owner — Tom Harris",
    customerPhone: "—",
    purpose: "direct_chat",
    outcome: "chat_active",
    notes: "Claimed 1:1 support chat from workshop owner regarding booking sync issue.",
    callAnswer: "Connected to live chat. Investigating duplicate booking entries from book-now widget.",
    timestamp: hoursAgo(0, 55),
    status: "in_progress",
  },
  {
    id: "act-008",
    type: "chat_closed",
    agentName: "Sarah Mitchell",
    agentEmail: "sarah.m@callcenter.bmspro.com",
    workshopName: "Hillside Motors Adelaide",
    customerName: "Workshop Owner — Anna Kowalski",
    customerPhone: "—",
    purpose: "direct_chat",
    outcome: "resolved",
    durationSeconds: 1240,
    notes: "Helped reset branch admin password and verified Yeastar extension mapping.",
    callAnswer:
      "Walked owner through settings → staff extensions. Confirmed click-to-call working. Chat closed with satisfaction.",
    timestamp: hoursAgo(5),
    status: "completed",
  },
  {
    id: "act-009",
    type: "call_answered",
    agentName: "James Okonkwo",
    agentEmail: "james.o@callcenter.bmspro.com",
    workshopName: "Hillside Motors Adelaide",
    customerName: "Sophie Martin",
    customerPhone: "+61 422 109 773",
    direction: "inbound",
    purpose: "booking",
    outcome: "booking_rescheduled",
    durationSeconds: 267,
    notes: "Customer needs to move appointment from Friday to Monday.",
    callAnswer:
      "Rescheduled booking BMS-28501 to Monday 11:00 AM. Sent updated calendar invite and SMS reminder.",
    bookingCode: "BMS-28501",
    timestamp: hoursAgo(6, 20),
    status: "completed",
  },
  {
    id: "act-010",
    type: "call_answered",
    agentName: "James Okonkwo",
    agentEmail: "james.o@callcenter.bmspro.com",
    workshopName: "Elite Workshop Perth",
    customerName: "Daniel Foster",
    customerPhone: "+61 415 882 601",
    direction: "inbound",
    purpose: "general_inquiry",
    outcome: "info_provided",
    durationSeconds: 156,
    notes: "Asked about warranty on previous repair.",
    callAnswer:
      "Confirmed 12-month parts & labour warranty still active until Aug 2026. Emailed warranty certificate copy to customer.",
    bookingCode: "BMS-27120",
    timestamp: hoursAgo(7),
    status: "completed",
  },
  {
    id: "act-011",
    type: "call_missed",
    agentName: "David Chen",
    agentEmail: "david.c@callcenter.bmspro.com",
    workshopName: "Precision Auto Sydney",
    customerName: "Unknown caller",
    customerPhone: "+61 400 331 229",
    direction: "inbound",
    purpose: "booking",
    durationSeconds: 0,
    notes: "Ring timeout — all agents busy. Auto-reply SMS sent with book-now link.",
    callAnswer: "—",
    timestamp: hoursAgo(8, 40),
    status: "missed",
  },
  {
    id: "act-012",
    type: "notification_reviewed",
    agentName: "Priya Sharma",
    agentEmail: "priya.s@callcenter.bmspro.com",
    workshopName: "Metro Mechanics Melbourne",
    customerName: "Chris Walker",
    customerPhone: "+61 491 002 118",
    purpose: "additional_issue",
    outcome: "callback_scheduled",
    notes: "New additional issue flagged — worn timing belt. Requires customer approval call.",
    callAnswer: "Reviewed issue photos and quote. Scheduled outbound call for 2 PM today.",
    bookingCode: "BMS-28290",
    timestamp: hoursAgo(9),
    status: "completed",
  },
  {
    id: "act-013",
    type: "call_outbound",
    agentName: "Sarah Mitchell",
    agentEmail: "sarah.m@callcenter.bmspro.com",
    workshopName: "Coastal Car Care Brisbane",
    customerName: "Karen Phillips",
    customerPhone: "+61 428 556 701",
    direction: "outbound",
    purpose: "booking",
    outcome: "booking_created",
    durationSeconds: 389,
    notes: "Return call from missed inbound — customer wants rego check booking.",
    callAnswer:
      "Booked rego inspection for Thu 2 PM at Southport branch. Collected vehicle details and payment method on file.",
    bookingCode: "BMS-28512",
    timestamp: hoursAgo(10, 5),
    status: "completed",
  },
  {
    id: "act-014",
    type: "call_answered",
    agentName: "Priya Sharma",
    agentEmail: "priya.s@callcenter.bmspro.com",
    workshopName: "Precision Auto Sydney",
    customerName: "Andrew Lee",
    customerPhone: "+61 404 990 221",
    direction: "inbound",
    purpose: "complaint",
    outcome: "escalated",
    durationSeconds: 612,
    notes: "Billing dispute — charged twice for same service.",
    callAnswer:
      "Verified duplicate Stripe charge. Escalated to workshop owner finance team. Promised callback within 24 hours with refund status.",
    bookingCode: "BMS-27844",
    timestamp: hoursAgo(11),
    status: "completed",
  },
  {
    id: "act-015",
    type: "customer_called",
    agentName: "James Okonkwo",
    agentEmail: "james.o@callcenter.bmspro.com",
    workshopName: "Hillside Motors Adelaide",
    customerName: "Patricia Gomez",
    customerPhone: "+61 437 114 558",
    direction: "outbound",
    purpose: "progress_check",
    outcome: "info_provided",
    durationSeconds: 184,
    notes: "Proactive update call — parts arrived early.",
    callAnswer:
      "Informed customer repair will complete today instead of tomorrow. Customer pleased with update.",
    bookingCode: "BMS-28405",
    timestamp: hoursAgo(12, 30),
    status: "completed",
  },
];

export const ACTIVITY_TYPE_CONFIG: Record<
  AgentActivityType,
  { label: string; icon: string; color: string; bgColor: string }
> = {
  call_answered: {
    label: "Call answered",
    icon: "fa-phone-volume",
    color: "text-emerald-700",
    bgColor: "bg-emerald-100",
  },
  call_missed: {
    label: "Missed call",
    icon: "fa-phone-slash",
    color: "text-red-700",
    bgColor: "bg-red-100",
  },
  call_outbound: {
    label: "Outbound call",
    icon: "fa-phone-arrow-up-right",
    color: "text-blue-700",
    bgColor: "bg-blue-100",
  },
  chat_claimed: {
    label: "Chat claimed",
    icon: "fa-comments",
    color: "text-violet-700",
    bgColor: "bg-violet-100",
  },
  chat_closed: {
    label: "Chat closed",
    icon: "fa-comment-check",
    color: "text-indigo-700",
    bgColor: "bg-indigo-100",
  },
  notification_reviewed: {
    label: "Notification reviewed",
    icon: "fa-bell",
    color: "text-amber-700",
    bgColor: "bg-amber-100",
  },
  customer_called: {
    label: "Customer called",
    icon: "fa-headset",
    color: "text-teal-700",
    bgColor: "bg-teal-100",
  },
};

export const PURPOSE_LABELS: Record<string, string> = {
  booking: "Booking",
  progress_check: "Progress check",
  extra_work_approval: "Extra work approval",
  general_inquiry: "General inquiry",
  complaint: "Complaint",
  direct_chat: "Direct chat",
  estimate_approval: "Estimate approval",
  additional_issue: "Additional issue",
};

export const OUTCOME_LABELS: Record<string, string> = {
  booking_created: "Booking created",
  booking_rescheduled: "Rescheduled",
  info_provided: "Info provided",
  callback_scheduled: "Callback scheduled",
  extra_work_accepted: "Extra work accepted",
  reviewed: "Reviewed",
  resolved: "Resolved",
  chat_active: "Chat active",
  escalated: "Escalated",
};

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function getActivityStats(activities: AgentActivity[]) {
  const calls = activities.filter((a) =>
    ["call_answered", "call_missed", "call_outbound", "customer_called"].includes(a.type)
  );
  const answered = activities.filter((a) => a.type === "call_answered" || a.type === "customer_called");
  const missed = activities.filter((a) => a.type === "call_missed");
  const withDuration = calls.filter((a) => (a.durationSeconds ?? 0) > 0);
  const avgSeconds =
    withDuration.length > 0
      ? Math.round(
          withDuration.reduce((sum, a) => sum + (a.durationSeconds ?? 0), 0) / withDuration.length
        )
      : 0;
  const agents = new Set(activities.map((a) => a.agentEmail));

  return {
    totalActivities: activities.length,
    totalCalls: calls.length,
    answered: answered.length,
    missed: missed.length,
    avgDuration: formatDuration(avgSeconds),
    activeAgents: agents.size,
  };
}
