/** Read call-center agent attribution from a Firestore notification document. */
export function agentTrackingFieldsFromFirestore(d: Record<string, unknown>): {
  notificationReviewedByUid: string | null;
  notificationReviewedByName: string | null;
  notificationReviewedByDisplayName: string | null;
  notificationReviewedByEmail: string | null;
  calledCustomerByUid: string | null;
  calledCustomerByName: string | null;
  calledCustomerByDisplayName: string | null;
  calledCustomerByEmail: string | null;
} {
  const s = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t || null;
  };
  const revName = s(d.notificationReviewedByName);
  const revDisp = s(d.notificationReviewedByDisplayName);
  const callName = s(d.calledCustomerByName);
  const callDisp = s(d.calledCustomerByDisplayName);
  return {
    notificationReviewedByUid: s(d.notificationReviewedByUid),
    notificationReviewedByName: revName || revDisp,
    notificationReviewedByDisplayName: revDisp || revName,
    notificationReviewedByEmail: s(d.notificationReviewedByEmail),
    calledCustomerByUid: s(d.calledCustomerByUid),
    calledCustomerByName: callName || callDisp,
    calledCustomerByDisplayName: callDisp || callName,
    calledCustomerByEmail: s(d.calledCustomerByEmail),
  };
}
