"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

export default function CancelledBookingsPage() {
  // Store value uses single-L "Canceled"; UI displays "Cancelled"
  return <BookingsListByStatus status="Canceled" title="Cancelled Bookings" />;
}


