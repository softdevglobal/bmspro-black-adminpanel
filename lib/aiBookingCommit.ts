import { createHash } from "node:crypto";
import type { Firestore, DocumentReference, DocumentData } from "firebase-admin/firestore";
import { countsTowardDailyLimit } from "./bookingTypes";
import { resolveBranchDaySchedule, getDayOfWeekFromYmd } from "./callCenterBranchForBooking";

export class AiBookingError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function canonicalBookingHash(value: unknown): string {
  function normalized(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(normalized);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalized(val)]));
    }
    return item;
  }
  return createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex");
}

export function validateAiDropOff(branch: Record<string, unknown>, date: unknown, time: unknown, now = new Date()): void {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date ||
      typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new AiBookingError(400, "INVALID_SLOT", "Invalid drop-off date or time.");
  }
  if (String(branch.status ?? "Active").toLowerCase() !== "active") {
    throw new AiBookingError(409, "BRANCH_INACTIVE", "The branch is not active.");
  }
  const timezone = String(branch.timezone || "Australia/Sydney");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {timeZone: timezone, year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  } catch { throw new AiBookingError(409, "INVALID_TIMEZONE", "The branch timezone needs review."); }
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  const localDate = `${get("year")}-${get("month")}-${get("day")}`;
  if (date < localDate || (date === localDate && time <= `${get("hour")}:${get("minute")}`)) {
    throw new AiBookingError(409, "SLOT_GONE", "This drop-off time is in the past.");
  }
  const schedule = resolveBranchDaySchedule(branch.hours, getDayOfWeekFromYmd(date));
  const minutes = (t: string) => Number(t.slice(0,2))*60+Number(t.slice(3,5));
  if (schedule.closed || !schedule.open || !schedule.close ||
      minutes(time) < minutes(schedule.open) || minutes(time) >= minutes(schedule.close) ||
      (minutes(time)-minutes(schedule.open)) % 30 !== 0) {
    throw new AiBookingError(409, "SLOT_GONE", "This time is outside the branch's drop-off hours.");
  }
}

export type AiBookingReservation = { ref: DocumentReference; bookingRef: DocumentReference; hash: string };

export async function beginAiBooking(db: Firestore, scope: {ownerUid:string;branchId:string;uid:string}, key: string, body: unknown) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new AiBookingError(400,"INVALID_IDEMPOTENCY_KEY","A valid Idempotency-Key is required for AI bookings.");
  const hash = canonicalBookingHash(body);
  const ref = db.collection("aiBookingRequests").doc(canonicalBookingHash({...scope,key}));
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists) {
      const data = current.data()!;
      if (data.hash !== hash) throw new AiBookingError(409,"IDEMPOTENCY_CONFLICT","This booking request key was already used with different details.");
      if (data.response) return { replay: data.response as Record<string, unknown>, httpStatus: Number(data.httpStatus) || 200 };
      return { replay: {success:false,status:"PROCESSING",requestId:ref.id,aiBookingContractVersion:1}, httpStatus:202 };
    }
    const bookingRef = db.collection("bookings").doc();
    tx.create(ref,{...scope,hash,bookingId:bookingRef.id,createdAt:new Date(),status:"processing"});
    return { reservation: {ref,bookingRef,hash} as AiBookingReservation };
  });
}

/** Transactional daily-cap check. Drop-off times are not exclusive appointments. */
export async function commitCallCenterBooking(db: Firestore, data: DocumentData, reservation?: AiBookingReservation) {
  const bookingRef = reservation?.bookingRef || db.collection("bookings").doc();
  const branchRef = db.collection("branches").doc(data.branchId);
  const guardRef = db.collection("bookingDayGuards").doc(canonicalBookingHash({owner:data.ownerUid,branch:data.branchId,date:data.date}));
  const response = {success:true,bookingId:bookingRef.id,bookingCode:data.bookingCode,status:data.status,totalPrice:data.price,totalDuration:data.duration,vehicleType:data.vehicleType,services:data.services,...(reservation?{aiBookingContractVersion:1}:{})};
  await db.runTransaction(async tx => {
    const [branch, guard] = await Promise.all([tx.get(branchRef),tx.get(guardRef)]);
    void guard;
    const branchData = branch.data();
    if (!branchData || branchData.ownerUid !== data.ownerUid) throw new AiBookingError(403,"SCOPE_CHANGED","The workshop branch is no longer accessible.");
    const bookings = await tx.get(db.collection("bookings").where("ownerUid","==",data.ownerUid).where("branchId","==",data.branchId).where("date","==",data.date));
    const count = bookings.docs.filter(doc => countsTowardDailyLimit(doc.data().status)).length;
    const limit = branchData.bookingLimitPerDay;
    if (typeof limit === "number" && limit > 0 && count >= limit) throw new AiBookingError(409,"DAILY_LIMIT_REACHED","The branch's daily booking limit has been reached.");
    if (reservation) {
      const request = await tx.get(reservation.ref);
      if (!request.exists || request.data()?.hash !== reservation.hash || request.data()?.status !== "processing") throw new AiBookingError(409,"IDEMPOTENCY_CONFLICT","This request cannot be committed again.");
      validateAiDropOff(branchData, data.date, data.time);
      const agent = (await tx.get(db.collection("call_center_agents").doc(data.createdBy))).data();
      if (!agent || agent.suspended || agent.role !== "agent" || agent.accountType !== "ai-front-office" || agent.brand !== "black" || agent.ownerUid !== data.ownerUid || agent.branchId !== data.branchId || !Array.isArray(agent.assignedWorkshops) || agent.assignedWorkshops.length !== 1 || agent.assignedWorkshops[0] !== data.ownerUid) throw new AiBookingError(403,"SCOPE_CHANGED","The AI identity is no longer assigned to this branch.");
      const services = await tx.getAll(...data.services.map((service: {id:string}) => db.collection("services").doc(service.id)));
      for (const service of services) {
        const catalog = service.data() as Record<string, unknown> | undefined;
        if (!catalog || catalog.ownerUid !== data.ownerUid || !Array.isArray(catalog.branches) || !catalog.branches.includes(data.branchId)) throw new AiBookingError(409,"SERVICE_CHANGED","A selected service is no longer offered at this branch.");
      }
    }
    tx.set(guardRef,{updatedAt:new Date()});
    tx.create(bookingRef,data);
    if (reservation) tx.update(reservation.ref,{status:"completed",response,httpStatus:200,completedAt:new Date()});
  });
  return bookingRef;
}
