"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

export default function PendingBookingsPage() {
  // Show all bookings that need admin action: Pending, AwaitingStaffApproval, PartiallyApproved, and StaffRejected
  // PartiallyApproved = some services accepted, others still pending - admin needs visibility
  return <BookingsListByStatus status={["Pending", "AwaitingStaffApproval", "PartiallyApproved", "StaffRejected"]} title="Booking Requests" />;
}


