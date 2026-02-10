#!/usr/bin/env node

/**
 * Production script to create super_admin in live Firebase project
 * 
 * This script creates a super_admin user with the specified credentials
 * and saves it in the super_admins collection (separate table).
 * 
 * Usage:
 *   node scripts/create-super-admin-production.js
 * 
 * Make sure you have your PRODUCTION Firebase Admin credentials set:
 *   - FIREBASE_SERVICE_ACCOUNT (JSON string), OR
 *   - FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 encoded JSON), OR
 *   - FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Super admin credentials
const SUPER_ADMIN_EMAIL = "bmspro@black.com";
const SUPER_ADMIN_PASSWORD = "admin999";
const SUPER_ADMIN_DISPLAY_NAME = "Super Admin";

async function createSuperAdminInProduction() {
  try {
    console.log("\n=== Creating Super Admin in Production ===\n");
    console.log(`Email: ${SUPER_ADMIN_EMAIL}`);
    console.log(`Display Name: ${SUPER_ADMIN_DISPLAY_NAME}\n`);

    // Initialize Firebase Admin
    let app;
    try {
      app = initializeApp();
      console.log("✓ Using existing Firebase Admin app");
    } catch (error) {
      // App not initialized, create it
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
      console.log("✓ Firebase Admin initialized");
    }
    
    const auth = getAuth(app);
    const db = getFirestore(app);
    
    let uid;
    
    try {
      // Check if user already exists in Firebase Auth
      console.log("\n1. Checking Firebase Authentication...");
      const existingUser = await auth.getUserByEmail(SUPER_ADMIN_EMAIL);
      uid = existingUser.uid;
      console.log(`   ✓ User exists in Firebase Auth (UID: ${uid})`);
      
      // Check if super_admin already exists in super_admins collection
      console.log("\n2. Checking super_admins collection...");
      const superAdminDoc = await db.doc(`super_admins/${uid}`).get();
      
      if (superAdminDoc.exists) {
        console.log("   ⚠️  Super admin already exists in super_admins collection!");
        console.log(`   UID: ${uid}`);
        console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
        console.log("\n   Updating password and display name...");
        
        // Update password
        await auth.updateUser(uid, {
          password: SUPER_ADMIN_PASSWORD,
          displayName: SUPER_ADMIN_DISPLAY_NAME,
          disabled: false,
        });
        
        // Update super_admins document
        await db.doc(`super_admins/${uid}`).set({
          uid,
          email: SUPER_ADMIN_EMAIL,
          displayName: SUPER_ADMIN_DISPLAY_NAME,
          role: "super_admin",
          updatedAt: new Date(),
        }, { merge: true });
        
        console.log("   ✓ Password and display name updated");
        console.log("\n✅ Super admin is ready to use!");
        console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
        console.log(`   Password: ${SUPER_ADMIN_PASSWORD}`);
        process.exit(0);
      } else {
        console.log("   ✓ No existing super_admin found, creating new one...");
      }
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        // Create new user in Firebase Auth
        console.log("\n1. Creating new user in Firebase Auth...");
        const user = await auth.createUser({
          email: SUPER_ADMIN_EMAIL,
          displayName: SUPER_ADMIN_DISPLAY_NAME,
          password: SUPER_ADMIN_PASSWORD,
          emailVerified: false,
          disabled: false,
        });
        
        uid = user.uid;
        console.log(`   ✓ User created in Firebase Auth (UID: ${uid})`);
      } else {
        throw error;
      }
    }
    
    // Create super_admin document in super_admins collection (separate table)
    console.log("\n3. Creating super_admin in super_admins collection...");
    await db.doc(`super_admins/${uid}`).set({
      uid,
      email: SUPER_ADMIN_EMAIL,
      displayName: SUPER_ADMIN_DISPLAY_NAME,
      role: "super_admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      provider: "password",
    });
    console.log("   ✓ Super admin document created in super_admins collection");
    
    // Update password if user already existed
    if (uid) {
      try {
        await auth.updateUser(uid, {
          password: SUPER_ADMIN_PASSWORD,
          displayName: SUPER_ADMIN_DISPLAY_NAME,
          disabled: false,
        });
        console.log("   ✓ Password set/updated");
      } catch (updateError) {
        // Ignore if user was just created (password already set)
        if (updateError.code !== "auth/user-not-found") {
          throw updateError;
        }
      }
    }
    
    // Verify the document was created
    console.log("\n4. Verifying super_admin creation...");
    const verifyDoc = await db.doc(`super_admins/${uid}`).get();
    if (verifyDoc.exists) {
      const data = verifyDoc.data();
      console.log("   ✓ Verification successful!");
      console.log(`   Collection: super_admins`);
      console.log(`   Document ID: ${uid}`);
      console.log(`   Email: ${data.email}`);
      console.log(`   Role: ${data.role}`);
    } else {
      throw new Error("Failed to verify super_admin creation");
    }
    
    console.log("\n✅ Super admin created successfully!");
    console.log("\n📋 Summary:");
    console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
    console.log(`   Password: ${SUPER_ADMIN_PASSWORD}`);
    console.log(`   UID: ${uid}`);
    console.log(`   Collection: super_admins (separate table)`);
    console.log(`   Display Name: ${SUPER_ADMIN_DISPLAY_NAME}`);
    console.log("\n🎉 You can now login with these credentials!\n");
    process.exit(0);
  } catch (error) {
    console.error("\n✗ Error creating super admin:", error.message);
    if (error.code) {
      console.error(`   Error code: ${error.code}`);
    }
    if (error.stack) {
      console.error("\nStack trace:", error.stack);
    }
    process.exit(1);
  }
}

// Run the script
createSuperAdminInProduction();
