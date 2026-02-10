"use client";

import { usePathname } from "next/navigation";
import AuthGuard from "./AuthGuard";

// Pages that don't need AuthGuard
const PUBLIC_PAGES = ["/login", "/signup", "/reset-password"];

export default function AuthWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  // Check if current page is public (no auth needed)
  const isPublicPage = PUBLIC_PAGES.some(page => 
    pathname === page || pathname?.startsWith(page + "/")
  );
  
  // If public page, render without AuthGuard
  if (isPublicPage) {
    return <>{children}</>;
  }
  
  // Otherwise, wrap with AuthGuard
  return <AuthGuard>{children}</AuthGuard>;
}
