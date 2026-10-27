import type { DocumentData, DocumentReference, Firestore, Transaction, Timestamp } from "firebase-admin/firestore";
import { approvedLeaveBlocksBookingOnDate, parseBookingYmd } from "./leaveBookingAssignment";
import { getDayOfWeekFromYmd, resolveBranchDaySchedule } from "./callCenterBranchForBooking";

type Row = Record<string, any>;
export type StaffAssignmentSource = "sophie" | "customer_portal";
export type StaffAssignmentSummary = { status: "assigned" | "needs_review"; reason: string; staffIds: string[]; assignedBy: StaffAssignmentSource };
export function clockMinutes(value: unknown): number | null {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Plans work after drop-off, without changing the customer's drop-off time. All or none. */
export function planBlackStaffAssignment(input: {
  booking: Row; branch: Row; staff: Row[]; catalog: Row[]; leave: Row[]; bookings: Row[]; assignedBy?: StaffAssignmentSource;
}): { services: Row[]; summary: StaffAssignmentSummary } {
  const { booking, branch, staff, catalog, leave, bookings } = input;
  const assignedBy = input.assignedBy ?? "sophie";
  const fail = (reason: string) => ({ services: booking.services, summary: { status: "needs_review" as const, reason, staffIds: [], assignedBy } });
  const date = parseBookingYmd(booking.date);
  if (!date) return fail("Invalid booking date.");
  const day = getDayOfWeekFromYmd(booking.date);
  const hours = resolveBranchDaySchedule(branch.hours, day);
  const open = clockMinutes(hours.open), close = clockMinutes(hours.close), dropOff = clockMinutes(booking.time);
  if (hours.closed || open == null || close == null || dropOff == null || close <= open) return fail("Working hours need review.");
  const busy = new Map<string, Array<[number, number]>>();
  const block = (id: string, start: number, end: number) => busy.set(id, [...(busy.get(id) || []), [start, end]]);
  for (const existing of bookings) {
    if (["Canceled", "Completed"].includes(existing.status)) continue;
    const services = Array.isArray(existing.services) && existing.services.length ? existing.services : [existing];
    for (const service of services) {
      if (!service.staffId || service.approvalStatus === "rejected") continue;
      const start = clockMinutes(service.plannedStartTime ?? service.time ?? existing.time);
      const end = clockMinutes(service.plannedEndTime);
      const duration = Number(service.duration ?? existing.duration);
      block(service.staffId, start ?? 0, end ?? (start != null && duration > 0 ? start + duration : 1440));
    }
  }
  const result: Row[] = [];
  let nextStart = Math.max(open, dropOff);
  for (const service of booking.services) {
    const definition = catalog.find(item => item.id === service.id);
    const duration = Number(service.duration);
    if (!definition || definition.status === "Inactive" || definition.isActive === false || !Array.isArray(definition.staffIds) || !definition.staffIds.length) return fail("A service has no configured eligible staff.");
    if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) return fail("A service duration needs review.");
    const candidates: Array<{ member: Row; start: number; load: number }> = [];
    for (const member of staff) {
      if (!["staff", "branch_admin"].includes(String(member.role).toLowerCase()) || member.suspended === true || String(member.status).toLowerCase() !== "active" || !definition.staffIds.includes(member.id)) continue;
      const scheduled = member.weeklySchedule ? member.weeklySchedule[day] : null;
      if (member.weeklySchedule && (!scheduled || scheduled.closed === true)) continue;
      if (String(scheduled?.branchId || member.branchId || "") !== booking.branchId) continue;
      if (leave.some(item => item.staffId === member.id && ["pending", "approved"].includes(String(item.status).toLowerCase()) && approvedLeaveBlocksBookingOnDate({ ...item, status: "approved" }, date))) continue;
      const memberOpen = scheduled?.open ? clockMinutes(scheduled.open) : open;
      const memberClose = scheduled?.close ? clockMinutes(scheduled.close) : close;
      if (memberOpen == null || memberClose == null) continue;
      const occupied = busy.get(member.id) || [];
      // Unknown schedule/break windows are never interpreted as an exclusive appointment.
      const breaks = Array.isArray(scheduled?.breaks) ? scheduled.breaks : [];
      for (let start = Math.max(nextStart, memberOpen); start + duration <= Math.min(close, memberClose); start += 15) {
        if (occupied.some(([a, b]) => start < b && a < start + duration)) continue;
        if (breaks.some((entry: Row) => { const a = clockMinutes(entry.start ?? entry.startTime), b = clockMinutes(entry.end ?? entry.endTime); return a == null || b == null || (start < b && a < start + duration); })) continue;
        candidates.push({ member, start, load: occupied.reduce((sum, [a, b]) => sum + b - a, 0) });
        break;
      }
    }
    candidates.sort((a, b) => a.start - b.start || a.load - b.load || String(a.member.id).localeCompare(String(b.member.id)));
    const chosen = candidates[0];
    if (!chosen) return fail("No eligible staff member has enough free working time for every service.");
    const end = chosen.start + duration;
    result.push({ ...service, staffId: chosen.member.id, staffName: chosen.member.displayName || chosen.member.name || "Staff", approvalStatus: "pending", plannedStartTime: clock(chosen.start), plannedEndTime: clock(end), assignedBy });
    block(chosen.member.id, chosen.start, end);
    nextStart = end;
  }
  return { services: result, summary: { status: "assigned", reason: "Eligible service staff selected within working hours; awaiting staff approval.", staffIds: [...new Set(result.map(item => String(item.staffId)))], assignedBy } };
}

/** All reads run in the booking transaction; concurrent AI assignments retry. */
export async function readBlackStaffAssignment(db: Firestore, tx: Transaction, booking: DocumentData, branch: DocumentData, assignedBy: StaffAssignmentSource = "sophie") {
  const [staff, leave, bookings] = await Promise.all([
    tx.get(db.collection("users").where("ownerUid", "==", booking.ownerUid)),
    tx.get(db.collection("leave_requests").where("ownerUid", "==", booking.ownerUid)),
    tx.get(db.collection("bookings").where("ownerUid", "==", booking.ownerUid).where("date", "==", booking.date)),
  ]);
  const catalog = await tx.getAll(...booking.services.map((item: Row) => db.collection("services").doc(item.id)));
  const definitions: Row[] = catalog.map(doc => ({ ...(doc.data() as Row), id: doc.id }));
  if (definitions.some(item => item.ownerUid !== booking.ownerUid || !Array.isArray(item.branches) || !item.branches.includes(booking.branchId))) {
    return { services: booking.services, summary: { status: "needs_review" as const, reason: "A selected service is not configured for this workshop branch.", staffIds: [], assignedBy } };
  }
  return planBlackStaffAssignment({ booking, branch, staff: staff.docs.map(doc => ({ ...doc.data(), id: doc.id })), leave: leave.docs.map(doc => doc.data()), bookings: bookings.docs.map(doc => doc.data()), catalog: definitions, assignedBy });
}

/** Accepting a Sophie assignment rechecks the exact planned work, never silently moves it. */
export async function commitBlackStaffAcceptance(db: Firestore, ref: DocumentReference, expectedVersion: Timestamp, serviceIds: string[], updates: DocumentData): Promise<boolean> {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), booking = snap.data();
    if (!booking || !snap.updateTime?.isEqual(expectedVersion)) return false;
    const branch = (await tx.get(db.collection("branches").doc(booking.branchId))).data();
    if (!branch || branch.ownerUid !== booking.ownerUid || String(branch.status || "Active").toLowerCase() !== "active") return false;
    const [staff, leaves, work] = await Promise.all([
      tx.get(db.collection("users").where("ownerUid", "==", booking.ownerUid)),
      tx.get(db.collection("leave_requests").where("ownerUid", "==", booking.ownerUid)),
      tx.get(db.collection("bookings").where("ownerUid", "==", booking.ownerUid).where("date", "==", booking.date)),
    ]);
    const targets: Row[] = booking.services.filter((item: Row) => serviceIds.includes(String(item.id)));
    if (!targets.length || targets.length !== serviceIds.length) return false;
    const catalogs = await tx.getAll(...targets.map(item => db.collection("services").doc(String(item.id))));
    for (let index = 0; index < targets.length; index++) {
      const service = targets[index], definition = catalogs[index].data();
      if (!definition || definition.ownerUid !== booking.ownerUid || !definition.branches?.includes(booking.branchId) || !definition.staffIds?.includes(service.staffId)) return false;
      const start = service.plannedStartTime;
      if (!start) return false;
      const plan = planBlackStaffAssignment({ booking: { ...booking, time: start, services: [service] }, branch,
        catalog: [{ ...definition, id: service.id, staffIds: [service.staffId] }],
        staff: staff.docs.filter(doc => doc.id === service.staffId).map(doc => ({ ...doc.data(), id: doc.id })),
        leave: leaves.docs.map(doc => doc.data()), bookings: work.docs.filter(doc => doc.id !== ref.id).map(doc => doc.data()) });
      if (plan.summary.status !== "assigned" || plan.services[0].plannedStartTime !== start || plan.services[0].plannedEndTime !== service.plannedEndTime) return false;
    }
    tx.update(ref, updates);
    return true;
  });
}
