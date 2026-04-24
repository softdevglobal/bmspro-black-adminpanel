import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { normalizePhoneDigits } from "@/lib/customerAccount";

export const runtime = "nodejs";

// ---------- Password hashing with PBKDF2 (built-in, no extra deps) ----------

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(32).toString("hex");
  const hash = crypto.pbkdf2Sync(password, s, 100_000, 64, "sha512").toString("hex");
  return { hash, salt: s };
}

function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(storedHash, "hex"));
}

// ---------- API Handler ----------

type AuthBody = {
  action: "login" | "register";
  email: string;
  password: string;
  ownerUid: string; // scopes customer to this workshop
  name?: string;
  phone?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AuthBody;
    const { action, email, password, ownerUid, name, phone } = body;

    if (!action || !email || !password || !ownerUid) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const db = adminDb();
    const customersRef = db.collection("customers");

    // ---------- LOGIN ----------
    if (action === "login") {
      // Find customer by email + ownerUid (scoped to this workshop)
      const snap = await customersRef
        .where("email", "==", normalizedEmail)
        .where("ownerUid", "==", ownerUid)
        .limit(1)
        .get();

      if (snap.empty) {
        return NextResponse.json(
          { error: "No account found with this email for this workshop" },
          { status: 401 }
        );
      }

      const doc = snap.docs[0];
      const data = doc.data();

      const storedHash = data?.passwordHash;
      const salt = data?.salt;
      if (!storedHash || !salt) {
        return NextResponse.json(
          { error: "Invalid credentials. Please use 'Forgot password' to reset your password." },
          { status: 401 }
        );
      }

      // Verify password
      const isValid = verifyPassword(password, storedHash, salt);
      if (!isValid) {
        return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
      }

      return NextResponse.json({
        customerId: doc.id,
        name: data.name || "",
        email: data.email || "",
        phone: data.phone || "",
      });
    }

    // ---------- REGISTER ----------
    if (action === "register") {
      if (!name || !phone) {
        return NextResponse.json(
          { error: "Name and phone are required for registration" },
          { status: 400 }
        );
      }

      // Check if email already registered for this workshop
      const existing = await customersRef
        .where("email", "==", normalizedEmail)
        .where("ownerUid", "==", ownerUid)
        .limit(1)
        .get();

      if (!existing.empty) {
        return NextResponse.json(
          { error: "An account with this email already exists for this workshop. Please login." },
          { status: 409 }
        );
      }

      // Hash password
      const { hash, salt } = hashPassword(password);

      // Create customer document scoped to this workshop
      const phoneNorm = normalizePhoneDigits(phone);
      const ref = await customersRef.add({
        email: normalizedEmail,
        name: name.trim(),
        phone: phone.trim(),
        ...(phoneNorm.length >= 6 ? { phoneNormalized: phoneNorm } : {}),
        passwordHash: hash,
        salt,
        ownerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return NextResponse.json({
        customerId: ref.id,
        name: name.trim(),
        email: normalizedEmail,
        phone: phone.trim(),
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error: any) {
    console.error("Customer auth error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH: Update customer profile (name, phone only — email is immutable)
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { customerId, name, phone } = body;

    if (!customerId || !name?.trim() || !phone?.trim()) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = adminDb();
    const docRef = db.collection("customers").doc(customerId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const phoneNorm = normalizePhoneDigits(phone);
    await docRef.update({
      name: name.trim(),
      phone: phone.trim(),
      ...(phoneNorm.length >= 6 ? { phoneNormalized: phoneNorm } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ success: true, name: name.trim(), phone: phone.trim() });
  } catch (error: any) {
    console.error("Customer profile update error:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
