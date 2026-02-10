"use client";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface ToastNotificationProps {
  id: string;
  title: string;
  message: string;
  serviceName?: string;
  price?: number;
  bookingId?: string;
  type?: string;
  branchName?: string;
  date?: string;
  time?: string;
  onClose: () => void;
}

export default function ToastNotification({
  id,
  title,
  message,
  serviceName,
  price,
  bookingId,
  type,
  branchName,
  date,
  time,
  onClose,
}: ToastNotificationProps) {
  const router = useRouter();
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    // Trigger entrance animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Auto close after 8 seconds
    const timer = setTimeout(() => {
      handleClose();
    }, 8000);

    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsLeaving(true);
    setTimeout(() => {
      onClose();
    }, 300);
  };

  const handleClick = () => {
    if (bookingId) {
      // Navigate based on notification type
      if (type === "booking_needs_assignment" || type === "booking_engine_new_booking" || type === "staff_booking_created") {
        router.push("/bookings/pending");
      } else if (type === "staff_rejected") {
        router.push("/bookings/pending");
      } else {
        router.push("/bookings/pending");
      }
    }
    handleClose();
  };

  // Get icon based on notification type
  const getIcon = () => {
    switch (type) {
      case "booking_needs_assignment":
      case "booking_engine_new_booking":
        return "fa-calendar-plus";
      case "staff_booking_created":
        return "fa-user-plus";
      case "staff_rejected":
        return "fa-user-xmark";
      case "staff_accepted":
        return "fa-user-check";
      default:
        return "fa-bell";
    }
  };

  // Get gradient based on notification type
  const getGradient = () => {
    switch (type) {
      case "staff_rejected":
        return "from-red-500 to-rose-600";
      case "staff_accepted":
        return "from-green-500 to-emerald-600";
      case "booking_needs_assignment":
        return "from-amber-500 to-orange-600";
      default:
        return "from-pink-500 to-rose-500";
    }
  };

  return (
    <div
      className={`
        bg-slate-800 rounded-xl shadow-2xl border border-slate-700 p-4 min-w-[340px] max-w-md 
        cursor-pointer hover:shadow-3xl hover:bg-slate-750 transition-all duration-300 hover:scale-[1.02]
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        ${isLeaving ? 'translate-x-full opacity-0' : ''}
      `}
      style={{ 
        transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
      }}
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${getGradient()} flex items-center justify-center flex-shrink-0 shadow-lg animate-pulse`}>
          <i className={`fas ${getIcon()} text-white text-lg`} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-white text-sm mb-1">{title}</h4>
          <p className="text-xs text-slate-300 mb-2 line-clamp-3">{message}</p>
          
          {/* Additional Info */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {serviceName && (
              <span className="px-2 py-1 bg-slate-700 text-slate-200 rounded-md font-medium">
                <i className="fas fa-scissors mr-1" />
                {serviceName}
              </span>
            )}
            {branchName && (
              <span className="px-2 py-1 bg-slate-700 text-slate-200 rounded-md font-medium">
                <i className="fas fa-store mr-1" />
                {branchName}
              </span>
            )}
            {date && time && (
              <span className="px-2 py-1 bg-slate-700 text-slate-200 rounded-md font-medium">
                <i className="fas fa-clock mr-1" />
                {date} {time}
              </span>
            )}
            {price && price > 0 && (
              <span className="px-2 py-1 bg-green-600 text-white rounded-md font-semibold">
                ${price.toFixed(2)}
              </span>
            )}
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleClose();
          }}
          className="w-6 h-6 rounded-lg hover:bg-slate-700 flex items-center justify-center flex-shrink-0 transition-colors"
          title="Close"
        >
          <i className="fas fa-times text-slate-400 hover:text-slate-200 text-xs" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1 bg-slate-700 rounded-full overflow-hidden">
        <div 
          className={`h-full bg-gradient-to-r ${getGradient()} rounded-full`}
          style={{
            animation: 'shrink 8s linear forwards',
          }}
        />
      </div>

      <style jsx>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}
