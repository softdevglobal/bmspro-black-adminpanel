"use client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { StaffCheckInRecord } from "@/lib/staffCheckIn";
import { formatDistance } from "@/lib/geolocation";
import { loadGoogleMaps, isGoogleMapsLoaded } from "@/lib/googleMaps";

type CheckInsMapViewProps = {
  checkIns: StaffCheckInRecord[];
  branches: Array<{
    id: string;
    name: string;
    location?: {
      latitude: number;
      longitude: number;
    };
    allowedCheckInRadius?: number;
  }>;
  selectedBranchId?: string | null;
  onSelectCheckIn?: (checkIn: StaffCheckInRecord) => void;
};

export default function CheckInsMapView({
  checkIns,
  branches,
  selectedBranchId,
  onSelectCheckIn,
}: CheckInsMapViewProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const circlesRef = useRef<google.maps.Circle[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  // Load Google Maps script using shared loader
  useEffect(() => {
    if (isGoogleMapsLoaded()) {
      setIsLoaded(true);
      return;
    }

    loadGoogleMaps()
      .then(() => {
        setIsLoaded(true);
      })
      .catch((error) => {
        console.error("Failed to load Google Maps:", error);
      });
  }, []);

  // Initialize map
  useEffect(() => {
    if (!isLoaded || !mapRef.current || map) return;

    // Find a center point
    let defaultCenter = { lat: -33.8688, lng: 151.2093 }; // Sydney default
    
    // Use first branch with location as center
    const branchWithLocation = branches.find((b) => b.location?.latitude && b.location?.longitude);
    if (branchWithLocation?.location) {
      defaultCenter = {
        lat: branchWithLocation.location.latitude,
        lng: branchWithLocation.location.longitude,
      };
    }

    const newMap = new google.maps.Map(mapRef.current, {
      center: defaultCenter,
      zoom: 15,
      mapId: "BMS_PRO_BLACK_CHECKINS_MAP",
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    setMap(newMap);

    // Create info window
    infoWindowRef.current = new google.maps.InfoWindow();
  }, [isLoaded, branches]);

  // Clear all markers and circles
  const clearMapElements = useCallback(() => {
    markersRef.current.forEach((marker) => {
      marker.map = null;
    });
    markersRef.current = [];

    circlesRef.current.forEach((circle) => {
      circle.setMap(null);
    });
    circlesRef.current = [];
  }, []);

  // Update markers when checkIns or branches change
  useEffect(() => {
    if (!map || !isLoaded) return;

    clearMapElements();

    // Filter branches by selected branch if any
    const filteredBranches = selectedBranchId
      ? branches.filter((b) => b.id === selectedBranchId)
      : branches;

    // Add branch markers and circles
    filteredBranches.forEach((branch) => {
      if (!branch.location?.latitude || !branch.location?.longitude) return;

      const position = {
        lat: branch.location.latitude,
        lng: branch.location.longitude,
      };

      // Add radius circle
      const circle = new google.maps.Circle({
        map,
        center: position,
        radius: branch.allowedCheckInRadius || 100,
        strokeColor: "#8B5CF6",
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: "#8B5CF6",
        fillOpacity: 0.1,
        clickable: false,
      });
      circlesRef.current.push(circle);

      // Create custom marker for branch
      const branchMarkerContent = document.createElement("div");
      branchMarkerContent.innerHTML = `
        <div style="
          background: linear-gradient(135deg, #8B5CF6, #A855F7);
          padding: 8px 12px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
          color: white;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        ">
          <i class="fas fa-building"></i>
          ${branch.name}
        </div>
      `;

      const branchMarker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        title: branch.name,
        content: branchMarkerContent,
      });

      branchMarker.addListener("click", () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(`
            <div style="padding: 8px; max-width: 200px;">
              <h3 style="margin: 0 0 8px 0; font-weight: 600; color: #1e293b;">${branch.name}</h3>
              <p style="margin: 0; font-size: 12px; color: #64748b;">
                Check-in radius: ${branch.allowedCheckInRadius || 100}m
              </p>
            </div>
          `);
          infoWindowRef.current.open(map, branchMarker);
        }
      });

      markersRef.current.push(branchMarker);
    });

    // Filter check-ins by selected branch
    const filteredCheckIns = selectedBranchId
      ? checkIns.filter((c) => c.branchId === selectedBranchId)
      : checkIns;

    // Add check-in markers
    filteredCheckIns.forEach((checkIn) => {
      const position = {
        lat: checkIn.staffLatitude,
        lng: checkIn.staffLongitude,
      };

      const isCheckedOut = checkIn.status !== "checked_in";
      const markerColor = checkIn.isWithinRadius
        ? isCheckedOut
          ? "#6B7280" // Gray for checked out
          : "#10B981" // Green for active
        : "#EF4444"; // Red for outside radius

      // Create custom marker for check-in
      const checkInMarkerContent = document.createElement("div");
      checkInMarkerContent.innerHTML = `
        <div style="
          background: ${markerColor};
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          border: 2px solid white;
          color: white;
          font-size: 12px;
          font-weight: 600;
        ">
          ${checkIn.staffName.charAt(0).toUpperCase()}
        </div>
      `;

      const checkInMarker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        title: checkIn.staffName,
        content: checkInMarkerContent,
      });

      checkInMarker.addListener("click", () => {
        const checkInTime = checkIn.checkInTime instanceof Date
          ? checkIn.checkInTime
          : checkIn.checkInTime?.toDate?.() || new Date();

        const checkOutTime = checkIn.checkOutTime instanceof Date
          ? checkIn.checkOutTime
          : checkIn.checkOutTime?.toDate?.();

        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(`
            <div style="padding: 12px; max-width: 250px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <div style="
                  width: 36px;
                  height: 36px;
                  border-radius: 8px;
                  background: linear-gradient(135deg, #EC4899, #F472B6);
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  color: white;
                  font-weight: 600;
                ">
                  ${checkIn.staffName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 style="margin: 0; font-weight: 600; color: #1e293b; font-size: 14px;">${checkIn.staffName}</h3>
                  <p style="margin: 0; font-size: 11px; color: #64748b;">${checkIn.staffRole || "Staff"}</p>
                </div>
              </div>
              <div style="font-size: 12px; color: #475569;">
                <p style="margin: 4px 0;"><strong>Branch:</strong> ${checkIn.branchName}</p>
                <p style="margin: 4px 0;"><strong>Check-in:</strong> ${checkInTime.toLocaleTimeString()}</p>
                ${checkOutTime ? `<p style="margin: 4px 0;"><strong>Check-out:</strong> ${checkOutTime.toLocaleTimeString()}</p>` : ""}
                <p style="margin: 4px 0;"><strong>Distance:</strong> ${formatDistance(checkIn.distanceFromBranch)}</p>
                <p style="margin: 4px 0;">
                  <span style="
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 11px;
                    font-weight: 500;
                    background: ${checkIn.status === "checked_in" ? "#DCFCE7" : "#F1F5F9"};
                    color: ${checkIn.status === "checked_in" ? "#16A34A" : "#64748B"};
                  ">
                    ${checkIn.status === "checked_in" ? "🟢 Active" : "⚪ Checked Out"}
                  </span>
                </p>
              </div>
            </div>
          `);
          infoWindowRef.current.open(map, checkInMarker);
        }

        if (onSelectCheckIn) {
          onSelectCheckIn(checkIn);
        }
      });

      markersRef.current.push(checkInMarker);
    });

    // Fit bounds to show all markers
    if (markersRef.current.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      markersRef.current.forEach((marker) => {
        if (marker.position) {
          bounds.extend(marker.position as google.maps.LatLng);
        }
      });
      map.fitBounds(bounds, 50);
      
      // Don't zoom in too much
      const listener = google.maps.event.addListener(map, "idle", () => {
        const currentZoom = map.getZoom();
        if (currentZoom && currentZoom > 17) {
          map.setZoom(17);
        }
        google.maps.event.removeListener(listener);
      });
    }
  }, [map, isLoaded, checkIns, branches, selectedBranchId, clearMapElements, onSelectCheckIn]);

  return (
    <div className="relative">
      <div
        ref={mapRef}
        className="w-full h-full min-h-[400px] lg:min-h-[500px] rounded-xl border border-neutral-200 overflow-hidden"
      />
      {!isLoaded && (
        <div className="absolute inset-0 bg-neutral-100 flex items-center justify-center rounded-xl">
          <div className="flex items-center gap-2 text-neutral-500">
            <i className="fas fa-spinner fa-spin" />
            Loading map...
          </div>
        </div>
      )}
      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur-sm rounded-lg p-3 shadow-lg text-xs">
        <div className="font-semibold text-neutral-700 mb-2">Legend</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-emerald-500" />
            <span className="text-neutral-600">Active Check-in</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-gray-400" />
            <span className="text-neutral-600">Checked Out</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-red-500" />
            <span className="text-neutral-600">Outside Radius</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-purple-500" />
            <span className="text-neutral-600">Branch Location</span>
          </div>
        </div>
      </div>
    </div>
  );
}
