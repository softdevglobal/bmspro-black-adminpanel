import { getApps, initializeApp, cert, App, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

let adminApp: App | null = null;

export function getAdminApp() {
  if (adminApp) return adminApp;
  if (!getApps().length) {
    // Accept multiple ways of providing credentials (in order of preference)
    // 1) FIREBASE_SERVICE_ACCOUNT (JSON string)
    // 2) FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 JSON)
    // 3) Individual keys: PROJECT_ID + CLIENT_EMAIL + PRIVATE_KEY
    // 4) Application Default Credentials
    let serviceAccount: any | null = null;

    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    
    // Debug logging to help diagnose issues
    console.log("Firebase Admin Debug - Environment variables check:");
    console.log("- FIREBASE_SERVICE_ACCOUNT:", saJson ? "SET (length: " + saJson.length + ")" : "NOT SET");
    console.log("- FIREBASE_SERVICE_ACCOUNT_BASE64:", saB64 ? "SET" : "NOT SET");
    console.log("- FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID ? "SET" : "NOT SET");
    console.log("- FIREBASE_CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL ? "SET" : "NOT SET");
    console.log("- FIREBASE_PRIVATE_KEY:", process.env.FIREBASE_PRIVATE_KEY ? "SET (length: " + process.env.FIREBASE_PRIVATE_KEY.length + ")" : "NOT SET");

    if (saJson) {
      try {
        serviceAccount = JSON.parse(saJson);
        console.log("✓ Using FIREBASE_SERVICE_ACCOUNT (JSON)");
      } catch (error) {
        console.error("✗ Failed to parse FIREBASE_SERVICE_ACCOUNT:", error);
        throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT JSON format");
      }
    } else if (saB64) {
      try {
        const decoded = Buffer.from(saB64, "base64").toString("utf8");
        serviceAccount = JSON.parse(decoded);
        console.log("✓ Using FIREBASE_SERVICE_ACCOUNT_BASE64");
      } catch (error) {
        console.error("✗ Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:", error);
        throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_BASE64 format");
      }
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      serviceAccount = {
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      };
      console.log("✓ Using individual Firebase credentials (PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY)");
    }

    if (serviceAccount) {
      try {
        adminApp = initializeApp({ credential: cert(serviceAccount) });
        console.log("✓ Firebase Admin initialized successfully");
      } catch (error) {
        console.error("✗ Failed to initialize Firebase Admin:", error);
        throw error;
      }
    } else {
      // If no explicit credentials, we might be in a GCP environment (Cloud Run/Functions)
      // where Application Default Credentials (ADC) work automatically.
      // However, locally this causes a hang/error trying to reach the metadata server.
      
      // Check if we are likely in development/local
      const isLocal = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
      
      if (isLocal) {
        console.error("\n=== Firebase Admin: Missing credentials ===");
        console.error("Please set one of the following in your .env.local file:");
        console.error("1. FIREBASE_SERVICE_ACCOUNT (full service account JSON as a string)");
        console.error("2. FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 encoded service account JSON)");
        console.error("3. Individual keys:");
        console.error("   - FIREBASE_PROJECT_ID");
        console.error("   - FIREBASE_CLIENT_EMAIL");
        console.error("   - FIREBASE_PRIVATE_KEY");
        console.error("===========================================\n");
        throw new Error("Missing Firebase Admin credentials. Please check your .env.local file.");
      }
      
      adminApp = initializeApp({ credential: applicationDefault() });
    }
  } else {
    adminApp = getApps()[0]!;
  }
  return adminApp!;
}

export const adminAuth = () => getAuth(getAdminApp());
// Use default database (or custom database ID if specified in env)
export const adminDb = () => getFirestore(getAdminApp());
export const adminMessaging = () => getMessaging(getAdminApp());


