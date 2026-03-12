"use client";
import React from "react";
import BookingsListByStatus from "@/components/bookings/BookingsListByStatus";

export default function ConfirmedBookingsPage() {
  return <BookingsListByStatus status="Confirmed" title="Confirmed Bookings" />;
}


