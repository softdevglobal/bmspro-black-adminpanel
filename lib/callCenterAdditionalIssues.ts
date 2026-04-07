/**
 * Normalize additional-issue rows for call-center JSON APIs (list + detail + sub-routes).
 * Handles Firestore Timestamp fields by converting to ISO strings.
 */

function toJsonScalar(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toDate?: () => Date }).toDate === "function"
  ) {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" && !Number.isNaN(v)) return String(v);
  return "";
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type CallCenterAdditionalIssuePayload = {
  id: string;
  issueTitle: string;
  description: string;
  recommendedRepair: string;
  partsRequired: string;
  labourTimeHours: number | null;
  imageUrl: string | null;
  price: number | null;
  status: string;
  serviceId: string | null;
  reportedAt: string | number | boolean | null;
  reportedByStaffUid: string;
  reportedByStaffName: string;
  priceSetAt: string | number | boolean | null;
  priceSetByUid: string;
  priceSetByName: string;
  customerResponse: string | null;
  customerRespondedAt: string | number | boolean | null;
  customerRespondedBy: string;
  completionStatus: string | null;
  completedAt: string | number | boolean | null;
  completedByStaffUid: string;
  completedByStaffName: string;
  completionNote: string;
  completionImageUrl: string | null;
};

export function serializeAdditionalIssueForCallCenterApi(
  raw: unknown
): CallCenterAdditionalIssuePayload {
  const i = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    id: str(i.id),
    issueTitle: str(i.issueTitle),
    description: str(i.description),
    recommendedRepair: str(i.recommendedRepair),
    partsRequired: str(i.partsRequired),
    labourTimeHours: numOrNull(i.labourTimeHours),
    imageUrl: i.imageUrl == null ? null : str(i.imageUrl) || null,
    price: numOrNull(i.price),
    status: str(i.status) || "pending",
    serviceId: i.serviceId == null ? null : str(i.serviceId) || null,
    reportedAt: toJsonScalar(i.reportedAt),
    reportedByStaffUid: str(i.reportedByStaffUid),
    reportedByStaffName: str(i.reportedByStaffName),
    priceSetAt: toJsonScalar(i.priceSetAt),
    priceSetByUid: str(i.priceSetByUid),
    priceSetByName: str(i.priceSetByName),
    customerResponse: i.customerResponse == null ? null : str(i.customerResponse) || null,
    customerRespondedAt: toJsonScalar(i.customerRespondedAt),
    customerRespondedBy: str(i.customerRespondedBy),
    completionStatus: i.completionStatus == null ? null : str(i.completionStatus) || null,
    completedAt: toJsonScalar(i.completedAt),
    completedByStaffUid: str(i.completedByStaffUid),
    completedByStaffName: str(i.completedByStaffName),
    completionNote: str(i.completionNote),
    completionImageUrl:
      i.completionImageUrl == null ? null : str(i.completionImageUrl) || null,
  };
}

export function serializeAdditionalIssuesForCallCenterApi(
  list: unknown
): CallCenterAdditionalIssuePayload[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => serializeAdditionalIssueForCallCenterApi(item));
}
