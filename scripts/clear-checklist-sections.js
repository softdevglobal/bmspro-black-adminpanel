#!/usr/bin/env node

/**
 * One-time migration: strip `section` from every checklist item on existing
 * service documents, so the UI prompts owners/admins to actively pick an area
 * the next time they edit a service (instead of showing the previously auto-
 * defaulted "interior").
 *
 * Collections touched:
 *   - services             (per-workshop services created by owners)
 *   - default_services     (super-admin templates)
 *
 * Usage:
 *   node scripts/clear-checklist-sections.js            # live run
 *   node scripts/clear-checklist-sections.js --dry-run  # preview only
 *
 * Requires the same FIREBASE_* env vars as the other scripts in this folder.
 */

// Load .env.local if present
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
          const cleanValue = value.replace(/^["']|["']$/g, "");
          if (!process.env[key.trim()]) {
            process.env[key.trim()] = cleanValue;
          }
        }
      }
    });
    console.log("✓ Loaded environment variables from .env.local");
  }
} catch (_) {
  // ignore
}

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const DRY_RUN = process.argv.includes("--dry-run");

function initAdmin() {
  const apps = getApps();
  if (apps.length > 0) return apps[0];

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  let serviceAccount = null;
  if (saJson) {
    serviceAccount = JSON.parse(saJson);
    console.log("✓ Using FIREBASE_SERVICE_ACCOUNT");
  } else if (saB64) {
    serviceAccount = JSON.parse(Buffer.from(saB64, "base64").toString("utf8"));
    console.log("✓ Using FIREBASE_SERVICE_ACCOUNT_BASE64");
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
    throw new Error(
      "Missing Firebase Admin credentials (FIREBASE_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT_BASE64 / FIREBASE_PROJECT_ID+CLIENT_EMAIL+PRIVATE_KEY)."
    );
  }

  return initializeApp({ credential: cert(serviceAccount) });
}

function stripSection(item) {
  if (!item || typeof item !== "object") return { next: item, changed: false };
  if (!("section" in item)) return { next: item, changed: false };
  const { section: _drop, ...rest } = item;
  return { next: rest, changed: true };
}

async function migrateCollection(db, collectionName) {
  const snap = await db.collection(collectionName).get();
  console.log(`\n→ ${collectionName}: ${snap.size} doc(s)`);

  let docsUpdated = 0;
  let itemsCleared = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const checklist = Array.isArray(data.checklist) ? data.checklist : null;
    if (!checklist) continue;

    let docChanged = false;
    const nextChecklist = checklist.map((item) => {
      const { next, changed } = stripSection(item);
      if (changed) {
        docChanged = true;
        itemsCleared += 1;
      }
      return next;
    });

    if (!docChanged) continue;
    docsUpdated += 1;

    console.log(
      `  • ${doc.id}: cleared section on ${nextChecklist.length} item(s)` +
        (DRY_RUN ? " (dry-run)" : "")
    );

    if (!DRY_RUN) {
      await doc.ref.update({ checklist: nextChecklist });
    }
  }

  console.log(
    `  ${collectionName}: ${docsUpdated} doc(s) updated, ${itemsCleared} checklist item(s) cleared${
      DRY_RUN ? " (dry-run)" : ""
    }`
  );
  return { docsUpdated, itemsCleared };
}

async function main() {
  const app = initAdmin();
  const db = getFirestore(app);

  console.log(
    `\n=== Clear checklist.section migration ${DRY_RUN ? "[DRY RUN]" : "[LIVE]"} ===`
  );

  const totals = { docsUpdated: 0, itemsCleared: 0 };
  for (const name of ["services", "default_services"]) {
    const result = await migrateCollection(db, name);
    totals.docsUpdated += result.docsUpdated;
    totals.itemsCleared += result.itemsCleared;
  }

  console.log(
    `\n✓ Done. ${totals.docsUpdated} doc(s) updated, ${totals.itemsCleared} checklist item(s) cleared${
      DRY_RUN ? " (dry-run — no writes performed)" : ""
    }.\n`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Migration failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
