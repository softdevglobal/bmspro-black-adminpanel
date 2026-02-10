"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

/**
 * Awaiting Staff Approval Page
 * 
 * Shows bookings that are waiting for staff to accept or reject.
 * This includes:
 * - Direct bookings sent to staff (when customer selected a specific staff)
 * - Bookings assigned by admin to staff
 * 
 * Staff can Accept or Reject these bookings from the mobile app.
 * 
 * Status flow:
 * - If staff accepts: Booking moves to Confirmed
 * - If staff rejects: Booking moves to StaffRejected (admin can reassign or cancel)
 */
export default function AwaitingStaffApprovalPage() {
  return (
    <BookingsListByStatus 
      status={["AwaitingStaffApproval", "PartiallyApproved"]} 
      title="Awaiting Staff Approval" 
    />
  );
}

