"use client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { CHECK_IN_RADIUS_OPTIONS, DEFAULT_CHECK_IN_RADIUS } from "@/lib/geolocation";
import { loadGoogleMaps, isGoogleMapsLoaded } from "@/lib/googleMaps";

type LocationData = {
  latitude: number;
  longitude: number;
  placeId?: string;
  formattedAddress?: string;
};

type BranchLocationPickerProps = {
  initialLocation?: LocationData;
  initialRadius?: number;
  onLocationChange: (location: LocationData | null) => void;
  onRadiusChange: (radius: number) => void;
  disabled?: boolean;
};

export default function BranchLocationPicker({
  initialLocation,
  initialRadius = DEFAULT_CHECK_IN_RADIUS,
  onLocationChange,
  onRadiusChange,
  disabled = false,
}: BranchLocationPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const autocompleteRef = useRef<HTMLInputElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [marker, setMarker] = useState<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [circle, setCircle] = useState<google.maps.Circle | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [address, setAddress] = useState(initialLocation?.formattedAddress || "");
  const [radius, setRadius] = useState(initialRadius);
  const [location, setLocation] = useState<LocationData | null>(initialLocation || null);
  const [isGettingCurrentLocation, setIsGettingCurrentLocation] = useState(false);

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

    const defaultCenter = initialLocation
      ? { lat: initialLocation.latitude, lng: initialLocation.longitude }
      : { lat: -33.8688, lng: 151.2093 }; // Sydney as default

    const newMap = new google.maps.Map(mapRef.current, {
      center: defaultCenter,
      zoom: initialLocation ? 17 : 13,
      mapId: "BMS_PRO_BLACK_MAP",
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    setMap(newMap);

    // Add click listener to map
    newMap.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (disabled || !e.latLng) return;
      updateLocation(e.latLng.lat(), e.latLng.lng());
    });
  }, [isLoaded, initialLocation, disabled]);

  // Initialize autocomplete
  useEffect(() => {
    if (!isLoaded || !autocompleteRef.current || !map) return;

    const autocomplete = new google.maps.places.Autocomplete(autocompleteRef.current, {
      types: ["establishment", "geocode"],
      fields: ["place_id", "geometry", "formatted_address", "name"],
    });

    autocomplete.bindTo("bounds", map);

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();

      if (!place.geometry?.location) {
        console.error("No location for this place");
        return;
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();

      updateLocation(lat, lng, place.place_id, place.formatted_address || place.name);

      if (place.geometry.viewport) {
        map.fitBounds(place.geometry.viewport);
      } else {
        map.setCenter(place.geometry.location);
        map.setZoom(17);
      }
    });
  }, [isLoaded, map]);

  // Update marker and circle when location changes
  const updateMarkerAndCircle = useCallback(
    (lat: number, lng: number, radiusMeters: number) => {
      if (!map) return;

      const position = { lat, lng };

      // Update or create marker
      if (marker) {
        marker.position = position;
      } else {
        const newMarker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position,
          title: "Branch Location",
        });
        setMarker(newMarker);
      }

      // Update or create radius circle
      if (circle) {
        circle.setCenter(position);
        circle.setRadius(radiusMeters);
      } else {
        const newCircle = new google.maps.Circle({
          map,
          center: position,
          radius: radiusMeters,
          strokeColor: "#EC4899",
          strokeOpacity: 0.8,
          strokeWeight: 2,
          fillColor: "#EC4899",
          fillOpacity: 0.15,
          clickable: false,
        });
        setCircle(newCircle);
      }
    },
    [map, marker, circle]
  );

  // Update location
  const updateLocation = useCallback(
    async (lat: number, lng: number, placeId?: string, formattedAddress?: string) => {
      const newLocation: LocationData = {
        latitude: lat,
        longitude: lng,
        placeId,
        formattedAddress,
      };

      // If no address provided, try to geocode
      if (!formattedAddress && isLoaded) {
        try {
          const geocoder = new google.maps.Geocoder();
          const response = await geocoder.geocode({ location: { lat, lng } });
          if (response.results[0]) {
            newLocation.formattedAddress = response.results[0].formatted_address;
            newLocation.placeId = response.results[0].place_id;
            setAddress(response.results[0].formatted_address);
          }
        } catch (e) {
          console.error("Geocoding failed:", e);
        }
      } else if (formattedAddress) {
        setAddress(formattedAddress);
      }

      setLocation(newLocation);
      onLocationChange(newLocation);
      updateMarkerAndCircle(lat, lng, radius);
    },
    [isLoaded, radius, onLocationChange, updateMarkerAndCircle]
  );

  // Get current location
  const getCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }

    setIsGettingCurrentLocation(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        updateLocation(latitude, longitude);
        
        if (map) {
          map.setCenter({ lat: latitude, lng: longitude });
          map.setZoom(17);
        }
        
        setIsGettingCurrentLocation(false);
      },
      (error) => {
        console.error("Error getting location:", error);
        alert("Unable to get your current location. Please check your browser permissions.");
        setIsGettingCurrentLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  }, [map, updateLocation]);

  // Handle radius change
  const handleRadiusChange = useCallback(
    (newRadius: number) => {
      setRadius(newRadius);
      onRadiusChange(newRadius);

      if (location && circle) {
        circle.setRadius(newRadius);
      }
    },
    [location, circle, onRadiusChange]
  );

  // Initialize marker and circle if initial location exists
  useEffect(() => {
    if (initialLocation && map && isLoaded) {
      updateMarkerAndCircle(
        initialLocation.latitude,
        initialLocation.longitude,
        initialRadius
      );
    }
  }, [initialLocation, initialRadius, map, isLoaded, updateMarkerAndCircle]);

  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div className="space-y-2">
        <label className="block text-xs font-bold text-neutral-500 uppercase">
          <i className="fas fa-map-marker-alt mr-1 text-neutral-500" />
          Branch Location
        </label>
        <div className="relative">
          <i className="fas fa-search absolute left-3 top-3 text-neutral-400" />
          <input
            ref={autocompleteRef}
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Search for an address..."
            disabled={disabled}
            className="w-full pl-10 pr-28 py-2.5 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:bg-white focus:border-neutral-500 focus:ring-4 focus:ring-neutral-500/10 transition-all outline-none disabled:bg-neutral-100 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={getCurrentLocation}
            disabled={disabled || isGettingCurrentLocation}
            className="absolute right-2 top-1.5 px-3 py-1.5 bg-neutral-100 text-neutral-600 rounded-md text-xs font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGettingCurrentLocation ? (
              <span className="flex items-center gap-1">
                <i className="fas fa-spinner fa-spin" />
                Getting...
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <i className="fas fa-crosshairs" />
                Current
              </span>
            )}
          </button>
        </div>
        <p className="text-xs text-neutral-500">
          <i className="fas fa-info-circle mr-1" />
          Search for an address, use current location, or click on the map
        </p>
      </div>

      {/* Map Container */}
      <div className="relative">
        <div
          ref={mapRef}
          className="w-full h-64 sm:h-80 rounded-xl border border-neutral-200 overflow-hidden"
          style={{ minHeight: "250px" }}
        />
        {!isLoaded && (
          <div className="absolute inset-0 bg-neutral-100 flex items-center justify-center rounded-xl">
            <div className="flex items-center gap-2 text-neutral-500">
              <i className="fas fa-spinner fa-spin" />
              Loading map...
            </div>
          </div>
        )}
      </div>

      {/* Location Display */}
      {location && (
        <div className="bg-neutral-50 rounded-lg p-4 border border-neutral-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center text-neutral-600">
              <i className="fas fa-map-pin" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-700 truncate">
                {location.formattedAddress || "Selected Location"}
              </div>
              <div className="text-xs text-neutral-500 mt-1 font-mono">
                {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
              </div>
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={() => {
                  setLocation(null);
                  setAddress("");
                  onLocationChange(null);
                  if (marker) {
                    marker.map = null;
                    setMarker(null);
                  }
                  if (circle) {
                    circle.setMap(null);
                    setCircle(null);
                  }
                }}
                className="text-neutral-400 hover:text-rose-500 transition-colors"
              >
                <i className="fas fa-times" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Check-in Radius Selector */}
      <div className="space-y-2">
        <label className="block text-xs font-bold text-neutral-500 uppercase">
          <i className="fas fa-circle-notch mr-1 text-neutral-500" />
          Check-in Radius
        </label>
        <div className="relative">
          <select
            value={radius}
            onChange={(e) => handleRadiusChange(Number(e.target.value))}
            disabled={disabled}
            className="w-full px-4 py-2.5 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:bg-white focus:border-neutral-500 focus:ring-4 focus:ring-neutral-500/10 transition-all outline-none appearance-none disabled:bg-neutral-100 disabled:cursor-not-allowed"
          >
            {CHECK_IN_RADIUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="absolute right-3 top-3 pointer-events-none text-neutral-400">
            <i className="fas fa-chevron-down" />
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          <i className="fas fa-info-circle mr-1" />
          Staff must be within this distance from the branch to check in
        </p>
      </div>
    </div>
  );
}
