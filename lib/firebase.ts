import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Firebase configuration (prefer env; fallback to bmspro-black production values)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyBh9yN2w_f6aF1nG8_dWM29ixRJVn9sqoM",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "bmspro-black.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "bmspro-black",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "bmspro-black.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "807442450614",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:807442450614:web:6df4fcda16b65b6860fe17",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-FKFHRS06RR",
};

// Initialize (guarded for Next.js hot reload)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

// Stabilize Firestore in Next.js dev (Turbopack/HMR) and varied network environments
// Use default database (or custom database ID if specified in env)
const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
});

// Firebase Storage for file uploads
const storage = getStorage(app);

export { app, auth, db, storage };