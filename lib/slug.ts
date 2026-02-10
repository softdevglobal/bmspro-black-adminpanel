import { db } from "@/lib/firebase";
import { collection, query, where, getDocs, limit } from "firebase/firestore";

/**
 * Convert a business name into a URL-friendly slug.
 *
 * Examples:
 *   "ABC Salon"             → "abc-salon"
 *   "Jane's Nails & Spa!"   → "janes-nails-spa"
 */
export const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
};

/**
 * Check if a slug is already in use by another salon owner.
 */
export const isSlugUnique = async (slug: string): Promise<boolean> => {
  const q = query(
    collection(db, "users"),
    where("slug", "==", slug),
    where("role", "==", "salon_owner"),
    limit(1)
  );
  const snapshot = await getDocs(q);
  return snapshot.empty;
};

/**
 * Generate a unique slug by appending a counter if needed.
 *
 * "abc-salon" → "abc-salon"   (if unique)
 * "abc-salon" → "abc-salon-1" (if taken)
 * "abc-salon" → "abc-salon-2" (if -1 also taken)
 */
export const generateUniqueSlug = async (name: string): Promise<string> => {
  const baseSlug = generateSlug(name);

  // Don't generate empty slugs
  if (!baseSlug) {
    return `salon-${Date.now()}`;
  }

  let slug = baseSlug;
  let isUnique = await isSlugUnique(slug);
  let counter = 1;

  while (!isUnique) {
    slug = `${baseSlug}-${counter}`;
    isUnique = await isSlugUnique(slug);
    counter++;
  }

  return slug;
};
