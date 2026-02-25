import { NextRequest, NextResponse } from "next/server";
import { adminStorage } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

// Allow larger uploads for estimate images (up to 10MB per file)
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const folder = (formData.get("folder") as string) || "uploads";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate file type
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
    const contentType = file.type || "image/jpeg";
    if (!validTypes.includes(contentType) && !file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      return NextResponse.json({ error: "Invalid file type. Only images (jpg, png, gif, webp) are allowed." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const timestamp = Date.now();
    const safeName = (file.name || "image").replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${folder}/${timestamp}_${safeName}`;

    const storage = adminStorage();
    const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET;
    const bucket = bucketName ? storage.bucket(bucketName) : storage.bucket();
    const fileRef = bucket.file(filePath);

    await fileRef.save(buffer, {
      metadata: {
        contentType: contentType,
        cacheControl: "public, max-age=31536000",
      },
    });

    await fileRef.makePublic();

    // Use Firebase Storage URL format for compatibility (works with both appspot.com and firebasestorage.app buckets)
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;

    return NextResponse.json({ url: publicUrl });
  } catch (error: any) {
    console.error("Image upload error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to upload image" },
      { status: 500 }
    );
  }
}
