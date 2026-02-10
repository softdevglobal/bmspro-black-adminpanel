"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

/**
 * Staff Rejected Bookings Page
 * 
 * Shows bookings that have been rejected by staff members.
 * Admin can:
 * - Reassign the booking to another staff member
 * - Cancel the booking
 * 
 * When staff rejects a booking:
 * 1. Booking status changes to StaffRejected
 * 2. Admin receives notification
 * 3. Admin can view rejection reason and decide next action
 */
export default function StaffRejectedBookingsPage() {
  return (
    <BookingsListByStatus 
      status={["StaffRejected"]} 
      title="Staff Rejected Bookings" 
    />
  );
}

