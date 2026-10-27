import assert from "node:assert/strict";
import test from "node:test";
import { planBlackStaffAssignment } from "../lib/aiStaffAssignment";

function fixture() {
  return {
    booking: { ownerUid: "owner", branchId: "branch", date: "2099-01-05", time: "09:00", services: [{ id: "oil", duration: 60 }] },
    branch: { hours: Object.fromEntries(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(day => [day, { open: "09:00", close: "17:00" }])) },
    staff: [{ id: "mechanic", role: "staff", status: "Active", branchId: "branch", name: "Mechanic" }],
    catalog: [{ id: "oil", staffIds: ["mechanic"] }], leave: [] as Record<string, any>[], bookings: [] as Record<string, any>[],
  };
}
test("eligible staff are assigned pending approval without changing drop-off time", () => {
  const input = fixture(); const result = planBlackStaffAssignment(input);
  assert.equal(result.summary.status, "assigned");
  assert.equal(result.services[0].approvalStatus, "pending");
  assert.equal(result.services[0].plannedEndTime, "10:00");
  assert.equal(input.booking.time, "09:00");
});
test("customer-portal assignment records its source while preserving staff approval", () => {
  const result = planBlackStaffAssignment({ ...fixture(), assignedBy: "customer_portal" });
  assert.equal(result.summary.status, "assigned");
  assert.equal(result.summary.assignedBy, "customer_portal");
  assert.equal(result.services[0].assignedBy, "customer_portal");
  assert.equal(result.services[0].approvalStatus, "pending");
});
test("unconfigured service, suspended staff and wrong branch cannot be auto-assigned", () => {
  for (const change of [(input: ReturnType<typeof fixture>) => { input.catalog[0].staffIds = []; }, (input: ReturnType<typeof fixture>) => { input.staff[0].status = "Suspended"; }, (input: ReturnType<typeof fixture>) => { input.staff[0].branchId = "other"; }]) {
    const input = fixture(); change(input); assert.equal(planBlackStaffAssignment(input).summary.status, "needs_review");
  }
});
test("both approved and pending leave block assignment", () => {
  for (const status of ["approved", "pending"]) {
    const input = fixture(); input.leave.push({ staffId: "mechanic", status, startDate: "2099-01-05", endDate: "2099-01-05" });
    assert.equal(planBlackStaffAssignment(input).summary.status, "needs_review");
  }
});
test("existing work moves the planned work later and end of day prevents overflow", () => {
  const input = fixture(); input.bookings.push({ status: "Confirmed", time: "09:00", services: [{ staffId: "mechanic", duration: 120 }] });
  assert.equal(planBlackStaffAssignment(input).services[0].plannedStartTime, "11:00");
  input.booking.time = "16:30";
  assert.equal(planBlackStaffAssignment(input).summary.status, "needs_review");
});
test("multi-service bookings get sequential work periods; a missing skill leaves all unassigned", () => {
  const input = fixture(); input.booking.services.push({ id: "tyres", duration: 30 }); input.catalog.push({ id: "tyres", staffIds: ["mechanic"] });
  const result = planBlackStaffAssignment(input);
  assert.deepEqual(result.services.map(service => service.plannedStartTime), ["09:00", "10:00"]);
  input.catalog[1].staffIds = [];
  const rejected = planBlackStaffAssignment(input);
  assert.equal(rejected.summary.status, "needs_review");
  assert.equal(rejected.services[0].staffId, undefined);
});
