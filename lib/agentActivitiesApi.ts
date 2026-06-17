import type { AgentActivityType } from "@/lib/agentActivitiesDummyData";

/** Row shape returned by GET /api/call-center/agent-activities */
export type AgentActivityApiRecord = {
  id: string;
  callId: string;
  agentName: string;
  agentUserId: string;
  agentEmail: string;
  agentRole: string;
  recordedByKind: "agent" | "tenant_admin";
  callerNumber: string;
  callerName: string;
  agentNote: string;
  didNumber: string;
  ownerId: string;
  ownerName: string;
  ownerTimezone: string;
  branchId: string;
  branchName: string;
  queueId: string;
  queueName: string;
  recordingUrl: string;
  recordingFileName: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentActivityRow = {
  id: string;
  type: AgentActivityType;
  agentName: string;
  agentUserId: string;
  agentEmail: string;
  agentRole: string;
  workshopName: string;
  ownerName: string;
  ownerTimezone: string;
  customerName: string;
  customerPhone: string;
  callId: string;
  agentNote: string;
  didNumber: string;
  branchName: string;
  queueName: string;
  recordingUrl: string;
  recordingFileName: string;
  timestamp: Date;
  status: "completed";
};

export function mapApiRecordToRow(
  record: AgentActivityApiRecord,
  workshopName: string
): AgentActivityRow {
  const ts = record.createdAt ? new Date(record.createdAt) : new Date();
  const resolvedWorkshop = record.ownerName || workshopName;
  return {
    id: record.id,
    type: "call_answered",
    agentName: record.agentName || "Unknown agent",
    agentUserId: record.agentUserId || "",
    agentEmail: record.agentEmail || "",
    agentRole: record.agentRole || "",
    workshopName: record.branchName || resolvedWorkshop,
    ownerName: resolvedWorkshop,
    ownerTimezone: record.ownerTimezone || "Australia/Sydney",
    customerName: record.callerName || "Unknown caller",
    customerPhone: record.callerNumber || "—",
    callId: record.callId || "",
    agentNote: record.agentNote || "",
    didNumber: record.didNumber || "",
    branchName: record.branchName || "",
    queueName: record.queueName || "",
    recordingUrl: record.recordingUrl || "",
    recordingFileName: record.recordingFileName || "",
    timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
    status: "completed",
  };
}

export function getAgentActivityStats(activities: AgentActivityRow[]) {
  const withNote = activities.filter((a) => a.agentNote.trim().length > 0);
  const withRecording = activities.filter((a) => a.recordingUrl.trim().length > 0);
  const agents = new Set(activities.map((a) => a.agentUserId || a.agentName).filter(Boolean));
  return {
    totalActivities: activities.length,
    totalCalls: activities.length,
    answered: withNote.length,
    missed: activities.length - withNote.length,
    withRecording: withRecording.length,
    avgDuration: "—",
    activeAgents: agents.size,
  };
}

export function getAgentActivityRecordingUrl(
  activityId: string,
  ownerId: string,
  download = false
): string {
  const params = new URLSearchParams({ ownerId });
  if (download) params.set("download", "1");
  return `/api/call-center/agent-activities/${encodeURIComponent(activityId)}/recording?${params}`;
}

export async function fetchAgentActivityRecordingBlob(
  activityId: string,
  ownerId: string,
  token: string,
  download = false
): Promise<Blob> {
  const res = await fetch(getAgentActivityRecordingUrl(activityId, ownerId, download), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load recording (${res.status})`);
  }
  return res.blob();
}

export async function fetchAgentActivitiesForOwner(
  ownerId: string,
  token: string,
  limit = 100
): Promise<AgentActivityApiRecord[]> {
  const params = new URLSearchParams({ ownerId, limit: String(limit) });
  const res = await fetch(`/api/call-center/agent-activities?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load activities (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.activities) ? data.activities : [];
}
