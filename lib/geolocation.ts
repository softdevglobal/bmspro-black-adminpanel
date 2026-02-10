/**
 * Geolocation utilities for staff check-in geofencing
 * Zero-cost solution using on-device GPS and Haversine formula
 */

// Earth radius in kilometers
const EARTH_RADIUS_KM = 6371;

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * @param lat1 Latitude of point 1
 * @param lon1 Longitude of point 1
 * @param lat2 Latitude of point 2
 * @param lon2 Longitude of point 2
 * @returns Distance in meters
 */
export function getDistanceFromLatLonInMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return EARTH_RADIUS_KM * c * 1000; // Convert to meters
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Check if a staff member is within the allowed check-in radius
 * @param staffLat Staff's current latitude
 * @param staffLon Staff's current longitude
 * @param branchLat Branch's latitude
 * @param branchLon Branch's longitude
 * @param allowedRadiusMeters Allowed check-in radius in meters
 * @returns Object with isWithinRadius boolean and actual distance
 */
export function validateCheckInLocation(
  staffLat: number,
  staffLon: number,
  branchLat: number,
  branchLon: number,
  allowedRadiusMeters: number
): { isWithinRadius: boolean; distanceMeters: number } {
  const distance = getDistanceFromLatLonInMeters(
    staffLat,
    staffLon,
    branchLat,
    branchLon
  );
  
  return {
    isWithinRadius: distance <= allowedRadiusMeters,
    distanceMeters: Math.round(distance),
  };
}

/**
 * Format distance for display
 * @param meters Distance in meters
 * @returns Formatted string (e.g., "150m" or "1.5km")
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

// Default check-in radius options
export const CHECK_IN_RADIUS_OPTIONS = [
  { value: 50, label: "50 meters (Very strict)" },
  { value: 100, label: "100 meters (Default)" },
  { value: 150, label: "150 meters" },
  { value: 200, label: "200 meters (Relaxed)" },
  { value: 300, label: "300 meters" },
  { value: 500, label: "500 meters (Very relaxed)" },
];

// Default radius in meters
export const DEFAULT_CHECK_IN_RADIUS = 100;

/**
 * Validate latitude value
 */
export function isValidLatitude(lat: number): boolean {
  return lat >= -90 && lat <= 90;
}

/**
 * Validate longitude value
 */
export function isValidLongitude(lon: number): boolean {
  return lon >= -180 && lon <= 180;
}

/**
 * Validate coordinates
 */
export function isValidCoordinates(lat: number, lon: number): boolean {
  return isValidLatitude(lat) && isValidLongitude(lon);
}
