// Server-only wrapper for email service
// This file should only be imported in server-side code (API routes, Server Components, Server Actions)

export async function sendBranchAdminAssignmentEmail(
  staffEmail: string,
  staffName: string,
  branchName: string,
  salonName?: string
) {
  // Only import on server side
  if (typeof window !== "undefined") {
    throw new Error("sendBranchAdminAssignmentEmail can only be called on the server");
  }
  
  // Dynamic import - webpack will replace this with the client stub in client bundles
  // The module replacement plugin in next.config.ts handles this
  const emailService = await import("./emailService");
  return emailService.sendBranchAdminAssignmentEmail(staffEmail, staffName, branchName, salonName);
}
