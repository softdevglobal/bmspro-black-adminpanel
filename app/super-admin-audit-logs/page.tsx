"use client";
import React, { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, onSnapshot, query, orderBy, limit, Timestamp } from "firebase/firestore";
import { formatInTimezone } from "@/lib/timezone";

type SuperAdminAuditLog = {
  id: string;
  action: string;
  actionType: "create" | "update" | "delete" | "status_change" | "login" | "logout" | "other";
  entityType: "tenant" | "subscription" | "system" | "super_admin";
  entityId?: string;
  entityName?: string;
  performedBy: string;
  performedByName?: string;
  details?: string;
  previousValue?: string;
  newValue?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
};

const ACTION_TYPE_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  create: { icon: "fa-plus-circle", color: "text-emerald-600", bgColor: "bg-emerald-100" },
  update: { icon: "fa-pen-to-square", color: "text-blue-600", bgColor: "bg-blue-100" },
  delete: { icon: "fa-trash", color: "text-red-600", bgColor: "bg-red-100" },
  status_change: { icon: "fa-arrows-rotate", color: "text-purple-600", bgColor: "bg-purple-100" },
  login: { icon: "fa-right-to-bracket", color: "text-teal-600", bgColor: "bg-teal-100" },
  logout: { icon: "fa-right-from-bracket", color: "text-orange-600", bgColor: "bg-orange-100" },
  other: { icon: "fa-circle-info", color: "text-slate-600", bgColor: "bg-slate-100" },
};

const ENTITY_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  tenant: { icon: "fa-store", label: "Tenant", color: "text-pink-600" },
  subscription: { icon: "fa-crown", label: "Subscription", color: "text-amber-600" },
  system: { icon: "fa-server", label: "System", color: "text-slate-600" },
  super_admin: { icon: "fa-user-shield", label: "Super Admin", color: "text-indigo-600" },
};

export default function SuperAdminAuditLogsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logs, setLogs] = useState<SuperAdminAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterEntity, setFilterEntity] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewLog, setPreviewLog] = useState<SuperAdminAuditLog | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [logsLimit, setLogsLimit] = useState(100);
  const [adminTimezone] = useState<string>("Australia/Sydney");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      try {
        const token = await user.getIdToken();
        if (typeof window !== "undefined") localStorage.setItem("idToken", token);
      } catch {
        router.replace("/login");
        return;
      }
      try {
        // Check if user is super admin
        const superAdminDoc = await getDoc(doc(db, "super_admins", user.uid));
        if (!superAdminDoc.exists()) {
          router.replace("/dashboard");
          return;
        }
        // User is verified as super admin
        setIsAuthenticated(true);
      } catch (error) {
        console.error("Error checking super admin:", error);
        router.replace("/login");
      }
    });
    return () => unsub();
  }, [router]);

  // Fetch super admin audit logs - only after authentication is confirmed
  useEffect(() => {
    if (!isAuthenticated) return;
    
    // First try with orderBy, fallback to simple query
    const q = query(
      collection(db, "superAdminAuditLogs"),
      orderBy("createdAt", "desc"),
      limit(logsLimit)
    );
    
    const unsub = onSnapshot(
      q,
      (snap) => {
        const logsList: SuperAdminAuditLog[] = [];
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          const timestampValue = d.createdAt || d.timestamp;
          logsList.push({
            id: docSnap.id,
            action: d.action || "Unknown action",
            actionType: d.actionType || "other",
            entityType: d.entityType || "system",
            entityId: d.entityId,
            entityName: d.entityName,
            performedBy: d.performedBy || "Unknown",
            performedByName: d.performedByName,
            details: d.details,
            previousValue: d.previousValue,
            newValue: d.newValue,
            timestamp: timestampValue instanceof Timestamp ? timestampValue.toDate() : new Date(timestampValue || Date.now()),
            metadata: d.metadata,
          });
        });
        setLogs(logsList);
        setLoading(false);
      },
      (error) => {
        console.error("Error in super admin audit logs snapshot:", error);
        
        if (error.code === "failed-precondition" || error.message?.includes("index")) {
          // Try without orderBy
          const simpleQ = query(
            collection(db, "superAdminAuditLogs"),
            limit(logsLimit)
          );
          
          onSnapshot(simpleQ, (snap) => {
            const logsList: SuperAdminAuditLog[] = [];
            snap.forEach((docSnap) => {
              const d = docSnap.data();
              const timestampValue = d.createdAt || d.timestamp;
              logsList.push({
                id: docSnap.id,
                action: d.action || "Unknown action",
                actionType: d.actionType || "other",
                entityType: d.entityType || "system",
                entityId: d.entityId,
                entityName: d.entityName,
                performedBy: d.performedBy || "Unknown",
                performedByName: d.performedByName,
                details: d.details,
                previousValue: d.previousValue,
                newValue: d.newValue,
                timestamp: timestampValue instanceof Timestamp ? timestampValue.toDate() : new Date(timestampValue || Date.now()),
                metadata: d.metadata,
              });
            });
            // Sort client-side
            logsList.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
            setLogs(logsList);
            setLoading(false);
          }, (simpleError) => {
            console.error("Error in simple audit logs snapshot:", simpleError);
            setLogs([]);
            setLoading(false);
          });
        } else {
          setLogs([]);
          setLoading(false);
        }
      }
    );
    return () => unsub();
  }, [isAuthenticated, logsLimit]);

  // Filter logs
  const filteredLogs = logs.filter((log) => {
    if (filterType !== "all" && log.actionType !== filterType) return false;
    if (filterEntity !== "all" && log.entityType !== filterEntity) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        log.action.toLowerCase().includes(q) ||
        (log.entityName || "").toLowerCase().includes(q) ||
        (log.performedByName || "").toLowerCase().includes(q) ||
        (log.details || "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    try {
      return formatInTimezone(date.toISOString(), adminTimezone, "d MMM yyyy");
    } catch {
      return date.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      });
    }
  };

  const formatFullTimestamp = (date: Date) => {
    try {
      return formatInTimezone(date.toISOString(), adminTimezone, "EEEE d MMMM yyyy 'at' h:mm:ss a");
    } catch {
      return date.toLocaleString("en-AU", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  };

  const getActionConfig = (type: string) => ACTION_TYPE_CONFIG[type] || ACTION_TYPE_CONFIG.other;
  const getEntityConfig = (type: string) => ENTITY_TYPE_CONFIG[type] || { icon: "fa-circle", label: type, color: "text-slate-600" };

  // Format role for display
  const formatRole = (details?: string): string => {
    if (!details) return "Super Admin";
    
    // Extract role from details (e.g., "Role: salon_owner")
    const roleMatch = details.match(/Role:\s*(\w+)/i);
    if (roleMatch) {
      const role = roleMatch[1];
      switch (role) {
        case "salon_owner": return "Salon Owner";
        case "salon_branch_admin": return "Branch Admin";
        case "salon_staff": return "Staff Member";
        case "super_admin": return "Super Admin";
        default: return role.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    return "Super Admin";
  };

  // Format details to show role nicely
  const formatDetails = (details?: string): string => {
    if (!details) return "";
    // Replace "Role: salon_owner" with "Role: Salon Owner"
    return details.replace(/Role:\s*(\w+)/gi, (match, role) => {
      switch (role) {
        case "salon_owner": return "Role: Salon Owner";
        case "salon_branch_admin": return "Role: Branch Admin";
        case "salon_staff": return "Role: Staff Member";
        case "super_admin": return "Role: Super Admin";
        default: return `Role: ${role.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}`;
      }
    });
  };

  // Stats
  const todayLogs = logs.filter((l) => {
    const today = new Date();
    return l.timestamp.toDateString() === today.toDateString();
  });
  const tenantActions = logs.filter((l) => l.entityType === "tenant").length;
  const subscriptionActions = logs.filter((l) => l.entityType === "subscription").length;

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 bg-slate-50">
          <div className="md:hidden mb-4">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 shadow-sm hover:bg-slate-50"
              onClick={() => setMobileOpen(true)}
            >
              <i className="fas fa-bars" />
              Menu
            </button>
          </div>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <div className="absolute left-0 top-0 bottom-0">
                <Sidebar mobile onClose={() => setMobileOpen(false)} />
              </div>
            </div>
          )}

          {/* Header */}
          <div className="mb-8">
            <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white p-6 shadow-lg">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
                  <i className="fas fa-shield-halved text-2xl" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">Super Admin Audit Logs</h1>
                  <p className="text-sm text-white/80 mt-1">Track all administrative activities across the platform</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
                    <i className="fas fa-list text-indigo-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">{logs.length}</div>
                    <div className="text-xs text-slate-500">Total Logs</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                    <i className="fas fa-clock text-blue-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">{todayLogs.length}</div>
                    <div className="text-xs text-slate-500">Today</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-pink-100 flex items-center justify-center">
                    <i className="fas fa-store text-pink-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">{tenantActions}</div>
                    <div className="text-xs text-slate-500">Tenant Actions</div>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center">
                    <i className="fas fa-crown text-amber-600" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-slate-900">{subscriptionActions}</div>
                    <div className="text-xs text-slate-500">Plan Changes</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 shadow-sm">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                  <div className="relative">
                    <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search logs..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <div className="relative min-w-[140px]">
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      className="w-full appearance-none pl-4 pr-10 py-2.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer hover:border-slate-400 transition-colors"
                    >
                      <option value="all">All Actions</option>
                      <option value="create">Created</option>
                      <option value="update">Updated</option>
                      <option value="delete">Deleted</option>
                      <option value="status_change">Status Changed</option>
                      <option value="login">Login</option>
                      <option value="logout">Logout</option>
                    </select>
                    <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none" />
                  </div>
                  <div className="relative min-w-[160px]">
                    <select
                      value={filterEntity}
                      onChange={(e) => setFilterEntity(e.target.value)}
                      className="w-full appearance-none pl-4 pr-10 py-2.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer hover:border-slate-400 transition-colors"
                    >
                      <option value="all">All Categories</option>
                      <option value="tenant">Tenants</option>
                      <option value="subscription">Subscriptions</option>
                      <option value="super_admin">Super Admin</option>
                      <option value="system">System</option>
                    </select>
                    <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none" />
                  </div>
                </div>
              </div>
            </div>

            {/* Logs List */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
              {loading ? (
                <div className="p-12 text-center">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                  <p className="text-slate-500">Loading audit logs...</p>
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-shield-halved text-slate-400 text-2xl" />
                  </div>
                  <h3 className="font-semibold text-slate-700 mb-2">No audit logs found</h3>
                  <p className="text-sm text-slate-500">
                    {searchQuery || filterType !== "all" || filterEntity !== "all"
                      ? "Try adjusting your filters"
                      : "Administrative activities will appear here"}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {filteredLogs.map((log) => {
                    const actionConfig = getActionConfig(log.actionType);
                    const entityConfig = getEntityConfig(log.entityType);
                    
                    return (
                      <div
                        key={log.id}
                        className="p-4 hover:bg-slate-50 transition-colors cursor-pointer"
                        onClick={() => {
                          setPreviewLog(log);
                          setPreviewOpen(true);
                        }}
                      >
                        <div className="flex items-start gap-4">
                          {/* Action Icon */}
                          <div className={`w-10 h-10 rounded-lg ${actionConfig.bgColor} flex items-center justify-center flex-shrink-0`}>
                            <i className={`fas ${actionConfig.icon} ${actionConfig.color}`} />
                          </div>
                          
                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="font-semibold text-sm text-slate-900 line-clamp-1">
                                {log.action}
                              </div>
                              <div className="text-xs text-slate-400 whitespace-nowrap">
                                {formatTimestamp(log.timestamp)}
                              </div>
                            </div>
                            
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              {/* Entity Badge */}
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 ${entityConfig.color}`}>
                                <i className={`fas ${entityConfig.icon} text-[10px]`} />
                                {entityConfig.label}
                                {log.entityName && <span className="font-medium text-slate-700">: {log.entityName}</span>}
                              </span>
                              
                              {/* Performer Badge */}
                              <span className="inline-flex items-center gap-1 text-slate-500">
                                <i className="fas fa-user-shield text-[10px]" />
                                {log.performedByName || log.performedBy}
                              </span>
                            </div>
                            
                            {/* Details Preview */}
                            {log.details && (
                              <div className="mt-2 text-xs text-slate-500 line-clamp-1">
                                {formatDetails(log.details)}
                              </div>
                            )}
                          </div>
                          
                          {/* Chevron */}
                          <i className="fas fa-chevron-right text-slate-300 text-xs mt-3" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* Load More */}
              {!loading && filteredLogs.length >= logsLimit && (
                <div className="p-4 border-t border-slate-100 text-center">
                  <button
                    onClick={() => setLogsLimit((prev) => prev + 100)}
                    className="px-4 py-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition"
                  >
                    Load More Logs
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Preview Sidebar */}
      <div
        className={`fixed inset-0 z-50 ${previewOpen ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!previewOpen}
      >
        <div
          onClick={() => setPreviewOpen(false)}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${previewOpen ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute top-0 h-full right-0 w-[92vw] sm:w-[32rem] bg-white shadow-2xl border-l border-slate-200 transform transition-transform duration-300 ${previewOpen ? "translate-x-0" : "translate-x-full"}`}
        >
          {previewLog && (
            <div className="flex h-full flex-col">
              {/* Fixed Header */}
              <div className="shrink-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl ${getActionConfig(previewLog.actionType).bgColor} flex items-center justify-center`}>
                      <i className={`fas ${getActionConfig(previewLog.actionType).icon} ${getActionConfig(previewLog.actionType).color}`} />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Audit Log Details</h3>
                      <p className="text-white/80 text-sm">{getEntityConfig(previewLog.entityType).label}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setPreviewOpen(false)}
                    className="w-9 h-9 bg-white/20 backdrop-blur-sm hover:bg-white/30 rounded-full flex items-center justify-center text-white transition-all"
                  >
                    <i className="fas fa-times text-lg" />
                  </button>
                </div>
              </div>
              
              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Action Summary */}
                <div className="bg-gradient-to-r from-slate-50 to-slate-100 rounded-xl p-4 border-2 border-slate-200">
                  <h4 className="font-bold text-lg text-slate-900 mb-2">{previewLog.action}</h4>
                  <div className="flex flex-wrap gap-2">
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${getActionConfig(previewLog.actionType).bgColor} ${getActionConfig(previewLog.actionType).color}`}>
                      <i className={`fas ${getActionConfig(previewLog.actionType).icon}`} />
                      {previewLog.actionType.replace("_", " ").toUpperCase()}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700`}>
                      <i className={`fas ${getEntityConfig(previewLog.entityType).icon}`} />
                      {getEntityConfig(previewLog.entityType).label}
                    </span>
                  </div>
                </div>

                {/* Timestamp */}
                <div className="bg-white rounded-xl p-4 border-2 border-slate-200">
                  <h5 className="font-semibold text-sm text-slate-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-clock text-indigo-600" />
                    Timestamp
                  </h5>
                  <div className="text-sm text-slate-900 font-medium">
                    {formatFullTimestamp(previewLog.timestamp)}
                  </div>
                  <div className="mt-2 text-xs text-slate-400 flex items-center gap-1">
                    <i className="fas fa-globe" />
                    {adminTimezone.replace(/_/g, " ")}
                  </div>
                </div>

                {/* Performed By */}
                <div className="bg-white rounded-xl p-4 border-2 border-slate-200">
                  <h5 className="font-semibold text-sm text-slate-800 mb-3 flex items-center gap-2">
                    <i className="fas fa-user-shield text-indigo-600" />
                    Performed By
                  </h5>
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full text-white flex items-center justify-center font-bold text-lg ${
                      formatRole(previewLog.details) === "Super Admin" 
                        ? "bg-gradient-to-br from-indigo-500 to-purple-600"
                        : formatRole(previewLog.details) === "Salon Owner"
                        ? "bg-gradient-to-br from-pink-500 to-rose-600"
                        : "bg-gradient-to-br from-teal-500 to-cyan-600"
                    }`}>
                      {(previewLog.performedByName || previewLog.performedBy || "A").charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">
                        {previewLog.performedByName || previewLog.performedBy}
                      </div>
                      <div className="text-xs text-slate-500">{formatRole(previewLog.details)}</div>
                    </div>
                  </div>
                </div>

                {/* Entity Details */}
                {previewLog.entityName && (
                  <div className="bg-white rounded-xl p-4 border-2 border-slate-200">
                    <h5 className="font-semibold text-sm text-slate-800 mb-3 flex items-center gap-2">
                      <i className={`fas ${getEntityConfig(previewLog.entityType).icon} text-indigo-600`} />
                      {getEntityConfig(previewLog.entityType).label} Details
                    </h5>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Name</span>
                        <span className="font-medium text-slate-900">{previewLog.entityName}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Value Changes */}
                {(previewLog.previousValue || previewLog.newValue) && (
                  <div className="bg-white rounded-xl p-4 border-2 border-slate-200">
                    <h5 className="font-semibold text-sm text-slate-800 mb-3 flex items-center gap-2">
                      <i className="fas fa-code-compare text-indigo-600" />
                      Changes
                    </h5>
                    <div className="space-y-3">
                      {previewLog.previousValue && (
                        <div>
                          <div className="text-xs font-medium text-red-600 mb-1">Previous Value</div>
                          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-slate-700 font-mono whitespace-pre-wrap">
                            {previewLog.previousValue}
                          </div>
                        </div>
                      )}
                      {previewLog.newValue && (
                        <div>
                          <div className="text-xs font-medium text-emerald-600 mb-1">New Value</div>
                          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-slate-700 font-mono whitespace-pre-wrap">
                            {previewLog.newValue}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Details */}
                {previewLog.details && (
                  <div className="bg-amber-50 rounded-xl p-4 border-2 border-amber-200">
                    <h5 className="font-semibold text-sm text-slate-900 mb-2 flex items-center gap-2">
                      <i className="fas fa-info-circle text-amber-600" />
                      Additional Details
                    </h5>
                    <div className="text-sm text-slate-700 whitespace-pre-wrap">{formatDetails(previewLog.details)}</div>
                  </div>
                )}

                {/* Metadata - Salon/Branch Info */}
                {previewLog.metadata && (previewLog.metadata.salonName || previewLog.metadata.branchName || previewLog.metadata.originalEntityType) && (
                  <div className="bg-pink-50 rounded-xl p-4 border-2 border-pink-200">
                    <h5 className="font-semibold text-sm text-slate-900 mb-3 flex items-center gap-2">
                      <i className="fas fa-store text-pink-600" />
                      Salon Activity Details
                    </h5>
                    <div className="space-y-2 text-sm">
                      {previewLog.metadata.salonName && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Salon Name</span>
                          <span className="font-medium text-pink-700">{previewLog.metadata.salonName}</span>
                        </div>
                      )}
                      {previewLog.metadata.originalEntityType && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Activity Type</span>
                          <span className="font-medium text-slate-900 capitalize">{previewLog.metadata.originalEntityType}</span>
                        </div>
                      )}
                      {previewLog.metadata.branchName && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Branch</span>
                          <span className="font-medium text-slate-900">{previewLog.metadata.branchName}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </div>

              {/* Footer */}
              <div className="shrink-0 border-t border-slate-200 p-4 bg-white">
                <button 
                  onClick={() => setPreviewOpen(false)} 
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold bg-slate-200 hover:bg-slate-300 text-slate-700 transition"
                >
                  <i className="fas fa-times mr-2" />
                  Close
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
