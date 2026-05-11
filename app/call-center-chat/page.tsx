"use client";

import React, { Suspense, useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useRouter, useSearchParams } from "next/navigation";
import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  where,
  type Timestamp,
} from "firebase/firestore";

type ChatRow = {
  chatId: string;
  agentName: string;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  unreadForTenant: boolean;
  queueStatus: string;
};

type Msg = {
  id: string;
  senderId: string;
  text: string;
  createdAt: Date | null;
};

function CallCenterChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialChatId = searchParams.get("chatId")?.trim() || null;

  const [mobileOpen, setMobileOpen] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      setUid(user.uid);
      const token = await user.getIdToken();
      if (typeof window !== "undefined") localStorage.setItem("idToken", token);
      const u = await getDoc(doc(db, "users", user.uid));
      const r = (u.data()?.role || "").toString();
      if (r !== "workshop_owner" && r !== "branch_admin") {
        router.replace("/dashboard");
        return;
      }
      setLoadingAuth(false);
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!uid) return;
    const q = query(
      collection(db, "cc_direct_chats"),
      where("tenantUserUid", "==", uid),
      orderBy("lastMessageAt", "desc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: ChatRow[] = [];
        snap.forEach((d) => {
          const x = d.data();
          const lm = x.lastMessageAt as Timestamp | undefined;
          rows.push({
            chatId: d.id,
            agentName: String(x.agentName || "Call center"),
            lastMessageText: x.lastMessageText != null ? String(x.lastMessageText) : null,
            lastMessageAt: lm?.toDate ? lm.toDate() : null,
            unreadForTenant: x.unreadForTenant === true,
            queueStatus: x.queueStatus === "pending" ? "pending" : "active",
          });
        });
        setChats(rows);
      },
      (e) => {
        console.error("[call-center-chat] list", e);
        setChats([]);
      }
    );
    return () => unsub();
  }, [uid]);

  useEffect(() => {
    if (initialChatId) setSelectedChatId(initialChatId);
  }, [initialChatId]);

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, "cc_direct_chats", selectedChatId, "messages"),
      orderBy("createdAt", "asc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Msg[] = [];
        snap.forEach((d) => {
          const m = d.data();
          const c = m.createdAt as Timestamp | undefined;
          list.push({
            id: d.id,
            senderId: String(m.senderId || ""),
            text: String(m.text || ""),
            createdAt: c?.toDate ? c.toDate() : null,
          });
        });
        setMessages(list);
      },
      (e) => {
        console.error("[call-center-chat] messages", e);
        setMessages([]);
      }
    );
    return () => unsub();
  }, [selectedChatId]);

  const markRead = useCallback(async (chatId: string) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      await fetch(`/api/chats/cc/rooms/${encodeURIComponent(chatId)}/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* non-blocking */
    }
  }, []);

  useEffect(() => {
    if (selectedChatId) void markRead(selectedChatId);
  }, [selectedChatId, markRead]);

  const openChat = (chatId: string) => {
    setSelectedChatId(chatId);
    router.replace(`/call-center-chat?chatId=${encodeURIComponent(chatId)}`, { scroll: false });
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || !selectedChatId || sending) return;
    const user = auth.currentUser;
    if (!user) return;
    setSending(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/chats/cc/rooms/${encodeURIComponent(selectedChatId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Send failed");
      setDraft("");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  if (loadingAuth) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <i className="fas fa-spinner fa-spin text-2xl text-neutral-400" />
      </div>
    );
  }

  const activeChat = chats.find((c) => c.chatId === selectedChatId);

  return (
    <div id="app" className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 flex flex-col overflow-hidden p-4 sm:p-6">
          <div className="md:hidden mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-neutral-700 shadow-sm hover:bg-neutral-50"
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

          <div className="mb-4 rounded-2xl bg-neutral-900 text-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-sky-500/20 flex items-center justify-center border border-sky-400/30">
                <i className="fas fa-headset text-sky-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Call center chat</h1>
                <p className="text-sm text-neutral-400 mt-0.5">1:1 messages with your reception team</p>
              </div>
            </div>
          </div>

          <div className="flex flex-1 min-h-0 gap-0 md:gap-4 rounded-2xl border border-neutral-200 overflow-hidden bg-neutral-50">
            <aside
              className={`w-full md:max-w-sm border-r border-neutral-200 bg-white flex flex-col min-h-0 ${
                selectedChatId ? "hidden md:flex" : "flex"
              } md:flex`}
            >
              <div className="p-4 border-b border-neutral-100 shrink-0">
                <h2 className="font-semibold text-neutral-900">Conversations</h2>
              </div>
              <div className="flex-1 overflow-y-auto">
                {chats.length === 0 ? (
                  <p className="p-4 text-sm text-neutral-500">No conversations yet.</p>
                ) : (
                  chats.map((c) => (
                    <button
                      key={c.chatId}
                      type="button"
                      onClick={() => openChat(c.chatId)}
                      className={`w-full text-left px-4 py-3 border-b border-neutral-100 hover:bg-neutral-50 transition ${
                        selectedChatId === c.chatId ? "bg-sky-50 border-l-4 border-l-sky-500" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-neutral-900 text-sm truncate">{c.agentName}</span>
                        {c.unreadForTenant && (
                          <span className="shrink-0 text-[10px] font-bold uppercase text-sky-600 bg-sky-100 px-2 py-0.5 rounded-full">
                            New
                          </span>
                        )}
                      </div>
                      {c.queueStatus === "pending" && (
                        <span className="text-[10px] text-amber-700 mt-1 inline-block">Waiting for an agent</span>
                      )}
                      <p className="text-xs text-neutral-500 truncate mt-1">{c.lastMessageText || "—"}</p>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <section
              className={`flex-1 flex flex-col min-w-0 bg-white min-h-0 ${
                !selectedChatId ? "hidden md:flex" : "flex"
              } md:flex`}
            >
              {!selectedChatId ? (
                <div className="flex-1 hidden md:flex items-center justify-center text-neutral-500 text-sm p-8">
                  Select a conversation
                </div>
              ) : (
                <>
                  <div className="p-3 md:p-4 border-b border-neutral-100 flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-neutral-200 text-neutral-700"
                      onClick={() => {
                        setSelectedChatId(null);
                        router.replace("/call-center-chat", { scroll: false });
                      }}
                      aria-label="Back to conversations"
                    >
                      <i className="fas fa-chevron-left" />
                    </button>
                    {activeChat?.unreadForTenant && (
                      <span className="text-[10px] font-bold uppercase text-sky-600 bg-sky-100 px-2 py-0.5 rounded-full">
                        New messages
                      </span>
                    )}
                    <h2 className="font-semibold text-neutral-900 truncate">{activeChat?.agentName || "Call center"}</h2>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.map((m) => {
                      const mine = m.senderId === uid;
                      return (
                        <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                              mine ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-900"
                            }`}
                          >
                            {m.text}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="p-3 md:p-4 border-t border-neutral-100 flex gap-2 shrink-0">
                    <input
                      className="flex-1 rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-900"
                      placeholder="Type a message…"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      disabled={sending || !draft.trim()}
                      className="px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm font-semibold disabled:opacity-50"
                    >
                      Send
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function CallCenterChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-white">
          <i className="fas fa-spinner fa-spin text-2xl text-neutral-400" />
        </div>
      }
    >
      <CallCenterChatContent />
    </Suspense>
  );
}
