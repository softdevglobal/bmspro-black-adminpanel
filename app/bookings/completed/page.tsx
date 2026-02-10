"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

export default function CompletedBookingsPage() {
  return <BookingsListByStatus status="Completed" title="Completed Bookings" />;
}


