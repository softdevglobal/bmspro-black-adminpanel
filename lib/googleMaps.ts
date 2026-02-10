/**
 * Google Maps loader utility
 * Prevents multiple script loads across components
 */

/// <reference types="@types/google.maps" />

// Google Maps API key from environment variable (prefer env; fallback to hard-coded dev value)
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "AIzaSyA2LP8ornek2rve4QBm5d9FLQKOrF78I6M";

// Track loading state
let isLoading = false;
let isLoaded = false;
let loadPromise: Promise<void> | null = null;

declare global {
  interface Window {
    google: typeof google;
    initGoogleMapsCallback?: () => void;
  }
}

/**
 * Load Google Maps script once and return a promise
 */
export function loadGoogleMaps(): Promise<void> {
  // Already loaded
  if (isLoaded || window.google?.maps) {
    isLoaded = true;
    return Promise.resolve();
  }

  // Currently loading - return existing promise
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  // Start loading
  isLoading = true;
  
  loadPromise = new Promise((resolve, reject) => {
    // Check again in case it loaded while we were setting up
    if (window.google?.maps) {
      isLoaded = true;
      isLoading = false;
      resolve();
      return;
    }

    // Check if script tag already exists
    const existingScript = document.querySelector(
      `script[src*="maps.googleapis.com/maps/api/js"]`
    );
    
    if (existingScript) {
      // Script exists, wait for it to load
      const checkLoaded = setInterval(() => {
        if (window.google?.maps) {
          clearInterval(checkLoaded);
          isLoaded = true;
          isLoading = false;
          resolve();
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkLoaded);
        if (!window.google?.maps) {
          reject(new Error("Google Maps failed to load"));
        }
      }, 10000);
      
      return;
    }

    // Set up callback BEFORE creating script to ensure it's available when script loads
    window.initGoogleMapsCallback = () => {
      isLoaded = true;
      isLoading = false;
      if (window.initGoogleMapsCallback) {
        window.initGoogleMapsCallback = undefined;
      }
      resolve();
    };

    // Create and load script
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places,marker&callback=initGoogleMapsCallback`;
    script.async = true;
    script.defer = true;

    script.onerror = (error) => {
      isLoading = false;
      loadPromise = null;
      if (window.initGoogleMapsCallback) {
        window.initGoogleMapsCallback = undefined;
      }
      console.error("Google Maps script failed to load:", error);
      console.error("API Key:", GOOGLE_MAPS_API_KEY ? `${GOOGLE_MAPS_API_KEY.substring(0, 10)}...` : "NOT SET");
      reject(new Error(`Failed to load Google Maps script. Please check your API key and network connection.`));
    };

    // Add timeout to detect if script never loads
    const timeout = setTimeout(() => {
      if (isLoading) {
        isLoading = false;
        loadPromise = null;
        if (window.initGoogleMapsCallback) {
          window.initGoogleMapsCallback = undefined;
        }
        script.remove();
        reject(new Error("Google Maps script load timeout. Please check your API key and network connection."));
      }
    }, 15000); // 15 second timeout

    script.onload = () => {
      clearTimeout(timeout);
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * Check if Google Maps is loaded
 */
export function isGoogleMapsLoaded(): boolean {
  return isLoaded || !!window.google?.maps;
}

/**
 * Get Google Maps API key
 */
export function getGoogleMapsApiKey(): string {
  return GOOGLE_MAPS_API_KEY;
}
