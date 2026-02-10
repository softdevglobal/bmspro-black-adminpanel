"use client";
import React, { useEffect, useState, useRef } from "react";

export default function Clock() {
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [clockPosition, setClockPosition] = useState({ x: 288, y: 500 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [clockMounted, setClockMounted] = useState(false);
  const clockRef = useRef<HTMLDivElement>(null);

  // Live clock - update every second (only on client)
  useEffect(() => {
    setCurrentTime(new Date());
    setClockMounted(true);
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Initialize clock position on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const savedPosition = localStorage.getItem("clockPosition");
      if (savedPosition) {
        setClockPosition(JSON.parse(savedPosition));
      } else {
        setClockPosition({ x: 288, y: window.innerHeight - 150 });
      }
    }
  }, []);

  // Handle clock dragging
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;
      // Keep within viewport bounds
      const maxX = window.innerWidth - 280;
      const maxY = window.innerHeight - 120;
      setClockPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };

    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        // Save position to localStorage
        localStorage.setItem("clockPosition", JSON.stringify(clockPosition));
      }
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragOffset, clockPosition]);

  if (!clockMounted || !currentTime) return null;

  return (
    <div
      ref={clockRef}
      className={`hidden lg:flex fixed z-40 select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
      style={{ left: clockPosition.x, top: clockPosition.y }}
      onMouseDown={(e) => {
        if (clockRef.current) {
          const rect = clockRef.current.getBoundingClientRect();
          setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          setIsDragging(true);
        }
      }}
    >
      <div
        className={`bg-slate-800 rounded-2xl shadow-xl border border-slate-700 overflow-hidden transition-shadow ${
          isDragging ? "shadow-2xl ring-2 ring-pink-500/50" : ""
        }`}
      >
        {/* Drag handle indicator */}
        <div className="flex justify-center py-1.5 bg-slate-700/50 border-b border-slate-700">
          <div className="flex gap-1">
            <div className="w-1 h-1 rounded-full bg-slate-500" />
            <div className="w-1 h-1 rounded-full bg-slate-500" />
            <div className="w-1 h-1 rounded-full bg-slate-500" />
          </div>
        </div>

        <div className="px-5 py-3">
          {/* Time display */}
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
              <i className="fas fa-clock text-white text-lg" />
            </div>
            <div className="flex items-baseline text-white tracking-tight font-mono">
              <span className="text-3xl font-bold">
                {(() => {
                  const hours = currentTime.getHours();
                  const minutes = currentTime.getMinutes();
                  const hour12 = hours % 12 || 12;
                  return `${hour12}:${String(minutes).padStart(2, "0")}`;
                })()}
              </span>
              <span className="text-lg font-semibold text-slate-400 ml-1">
                :{String(currentTime.getSeconds()).padStart(2, "0")}
              </span>
              <span className="text-sm font-semibold text-pink-400 ml-2">
                {currentTime.getHours() >= 12 ? "PM" : "AM"}
              </span>
            </div>
          </div>

          {/* Date display */}
          <div className="flex items-center gap-2 pl-1">
            <div className="flex items-center gap-2 text-slate-300">
              <i className="fas fa-calendar-day text-xs text-pink-400" />
              <span className="text-sm font-medium">
                {currentTime.toLocaleDateString("en-AU", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </span>
            </div>
          </div>

          {/* Decorative gradient line */}
          <div className="mt-3 h-1 bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 rounded-full" />
        </div>
      </div>
    </div>
  );
}

