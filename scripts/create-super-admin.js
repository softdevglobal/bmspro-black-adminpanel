#!/usr/bin/env node

/**
 * Script to manually create a super_admin user in Firebase.
 * 
 * Usage:
 *   node scripts/create-super-admin.js <email> <password> [displayName]
 * 
 * Example:
 *   node scripts/create-super-admin.js admin@example.com SecurePass123 "Super Admin"
 * 
 * Make sure you have your Firebase Admin credentials set in environment variables:
 *   - FIREBASE_SERVICE_ACCOUNT (JSON string)
 *   - OR FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 encoded JSON)
 *   - OR FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

// Try to load .env.local if it exists
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, "..", ".env.local");
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, "utf8");
    envFile.split("\n").forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        const [key, ...valueParts] = trimmedLine.split("=");
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").trim();
          // Remove quotes if present
          const cleanValue = value.replace(/^["']|["']$/g, "");
          if (!process.env[key.trim()]) {
            process.env[key.trim()] = cleanValue;
          }
        }
      }
    });
    console.log("✓ Loaded environment variables from .env.local");
  }
} catch (error) {
  // Ignore errors loading .env.local
}

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Get command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage: node scripts/create-super-admin.js <email> <password> [displayName]");
  console.error("Example: node scripts/create-super-admin.js admin@example.com SecurePass123 \"Super Admin\"");
  process.exit(1);
}

const email = args[0].trim().toLowerCase();
const password = args[1];
const displayName = args[2] || "Super Admin";

// Validate email
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  console.error("Error: Invalid email format");
  process.exit(1);
}

// Validate password
if (password.length < 6) {
  console.error("Error: Password must be at least 6 characters long");
  process.exit(1);
}

async function createSuperAdmin() {
  try {
    // Initialize Firebase Admin
    let app;
    try {
      app = initializeApp();
    } catch (error) {
      // App might already be initialized, try to get it
      const { getApps } = require("firebase-admin/app");
      const apps = getApps();
      if (apps.length > 0) {
        app = apps[0];
      } else {
        // Try to initialize with credentials from environment
        let serviceAccount = null;
        
        const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
        const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
        
        if (saJson) {
          try {
            serviceAccount = JSON.parse(saJson);
            console.log("✓ Using FIREBASE_SERVICE_ACCOUNT");
          } catch (parseError) {
            console.error("✗ Failed to parse FIREBASE_SERVICE_ACCOUNT:", parseError.message);
            throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT JSON format");
          }
        } else if (saB64) {
          try {
            const decoded = Buffer.from(saB64, "base64").toString("utf8");
            serviceAccount = JSON.parse(decoded);
            console.log("✓ Using FIREBASE_SERVICE_ACCOUNT_BASE64");
          } catch (parseError) {
            console.error("✗ Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:", parseError.message);
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
          console.log("✓ Using individual Firebase credentials");
        } else {
          console.error("\n=== Firebase Admin: Missing credentials ===");
          console.error("Please set one of the following in your environment:");
          console.error("1. FIREBASE_SERVICE_ACCOUNT (full service account JSON as a string)");
          console.error("2. FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 encoded service account JSON)");
          console.error("3. Individual keys:");
          console.error("   - FIREBASE_PROJECT_ID");
          console.error("   - FIREBASE_CLIENT_EMAIL");
          console.error("   - FIREBASE_PRIVATE_KEY");
          console.error("===========================================\n");
          throw new Error("Missing Firebase Admin credentials");
        }
        
        app = initializeApp({ credential: cert(serviceAccount) });
      }
    }
    
    const auth = getAuth(app);
    const db = getFirestore(app);
    
    console.log(`\nCreating super_admin user...`);
    console.log(`Email: ${email}`);
    console.log(`Display Name: ${displayName}\n`);
    
    let uid;
    
    try {
      // Check if user already exists
      const existingUser = await auth.getUserByEmail(email);
      uid = existingUser.uid;
      console.log(`✓ User already exists in Firebase Auth (UID: ${uid})`);
      
      // Check Firestore document
      const userDoc = await db.doc(`users/${uid}`).get();
      
      if (userDoc.exists) {
        const userData = userDoc.data();
        const existingRole = (userData?.role || "").toString().toLowerCase();
        
        if (existingRole === "super_admin") {
          console.log("\n⚠️  Super admin already exists!");
          console.log(`   UID: ${uid}`);
          console.log(`   Email: ${email}`);
          console.log(`   Role: ${existingRole}`);
          console.log("\nUpdating password and display name...");
          
          await auth.updateUser(uid, {
            password: password,
            displayName: displayName,
            disabled: false,
          });
          
          await db.doc(`users/${uid}`).set({
            ...userData,
            displayName: displayName,
            updatedAt: new Date(),
          }, { merge: true });
          
          console.log("✓ Password and display name updated");
          process.exit(0);
        } else {
          console.log(`⚠️  User exists with role: ${existingRole}`);
          console.log("   Promoting to super_admin...");
          
          await db.doc(`users/${uid}`).set({
            ...userData,
            role: "super_admin",
            displayName: displayName,
            updatedAt: new Date(),
          }, { merge: true });
          
          await auth.updateUser(uid, {
            password: password,
            displayName: displayName,
            disabled: false,
          });
          
          console.log("✓ User promoted to super_admin");
          console.log(`   UID: ${uid}`);
          console.log(`   Email: ${email}`);
          process.exit(0);
        }
      } else {
        // User exists in Auth but not in Firestore
        console.log("   Creating Firestore document...");
        
        await db.doc(`users/${uid}`).set({
          uid,
          email: email,
          displayName: displayName,
          role: "super_admin",
          createdAt: new Date(),
          updatedAt: new Date(),
          provider: "password",
        });
        
        await auth.updateUser(uid, {
          password: password,
          displayName: displayName,
          disabled: false,
        });
        
        console.log("✓ Super admin created successfully!");
        console.log(`   UID: ${uid}`);
        console.log(`   Email: ${email}`);
        console.log(`   Role: super_admin`);
        process.exit(0);
      }
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        // Create new user
        console.log("   Creating new user in Firebase Auth...");
        
        const user = await auth.createUser({
          email: email,
          displayName: displayName,
          password: password,
          emailVerified: false,
          disabled: false,
        });
        
        uid = user.uid;
        console.log(`✓ User created in Firebase Auth (UID: ${uid})`);
        
        // Create Firestore document
        console.log("   Creating Firestore document...");
        await db.doc(`users/${uid}`).set({
          uid,
          email: email,
          displayName: displayName,
          role: "super_admin",
          createdAt: new Date(),
          updatedAt: new Date(),
          provider: "password",
        });
        
        console.log("✓ Super admin created successfully!");
        console.log(`\n   UID: ${uid}`);
        console.log(`   Email: ${email}`);
        console.log(`   Display Name: ${displayName}`);
        console.log(`   Role: super_admin`);
        console.log("\n✅ You can now login with this account!\n");
        process.exit(0);
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("\n✗ Error creating super admin:", error.message);
    if (error.code) {
      console.error(`   Error code: ${error.code}`);
    }
    console.error("\nStack trace:", error.stack);
    process.exit(1);
  }
}

// Run the script
createSuperAdmin();
