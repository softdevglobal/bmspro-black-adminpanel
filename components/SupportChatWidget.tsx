"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { Timestamp } from "firebase/firestore";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import { markCustomerConversationRead } from "@/lib/supportChatClient";
import { OPEN_SUPPORT_CHAT_EVENT, dispatchSupportChatPanelState } from "@/lib/supportChatEvents";
import {
  subscribeUnifiedWorkshopChat,
  sendUnifiedWorkshopChatMessage,
  markAllCcRoomsRead,
  injectReceptionConnectionHints,
  type UnifiedChatBubble,
} from "@/lib/unifiedWorkshopChatClient";

const WORKSHOP_CHAT_ROLES = new Set(["workshop_owner", "branch_admin"]);

const ACCENT = "#2563eb";
const ACCENT_HOVER = "#1d4ed8";

function formatMsgTime(ts: Timestamp | null): string {
  if (!ts || !(ts instanceof Timestamp)) return "";
  try {
    return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Green when CC direct thread is open *or* support subtitle shows connected. */
function headerStatusDotModifier(subtitle: string, preferredCcChatId: string | null): "live" | "waiting" | "idle" {
  if (preferredCcChatId) return "live";
  const t = subtitle.trim();
  if (t.includes("· Connected")) return "live";
  if (t.includes("Waiting for an agent")) return "waiting";
  return "idle";
}

/** Main header line when we know who claimed the thread (subtitle comes from unified chat). */
function receptionHeaderTitle(subtitle: string): string {
  const t = subtitle.trim();
  const m = /^(?:Support|Reception) \((.+?)\) · Connected$/.exec(t);
  if (m) return `Connected with ${m[1]}`;
  if (t.includes("Waiting for an agent")) return "Waiting for an agent";
  return "Chat with receptionist";
}

export default function SupportChatWidget() {
  const [eligible, setEligible] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [bubbles, setBubbles] = useState<UnifiedChatBubble[]>([]);
  const [preferredCcChatId, setPreferredCcChatId] = useState<string | null>(null);
  const [headerSubtitle, setHeaderSubtitle] = useState("Chat with reception team");
  const [fabUnread, setFabUnread] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const openRef = useRef(false);

  const unreadTargetsRef = useRef({ supportConversationIds: [] as string[], ccRoomIds: [] as string[] });
  const markedReadThisOpenRef = useRef(false);

  const displayBubbles = useMemo(() => injectReceptionConnectionHints(bubbles), [bubbles]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUid(null);
        setEligible(false);
        return;
      }
      setUid(user.uid);
      const me = await fetchCurrentUser();
      const role = me?.role ?? "";
      setEligible(WORKSHOP_CHAT_ROLES.has(role) && !me?.isSuperAdmin);
    });
    return () => unsub();
  }, []);

  const chatHandleRef = useRef<ReturnType<typeof subscribeUnifiedWorkshopChat> | null>(null);

  useEffect(() => {
    if (!uid || !eligible) return;
    const handle = subscribeUnifiedWorkshopChat(uid, {
      onBubbles: setBubbles,
      onPreferredCcChatId: setPreferredCcChatId,
      onUnreadBadge: (n) => setFabUnread(openRef.current ? 0 : n),
      onHeaderHint: setHeaderSubtitle,
      onUnreadTargets: (targets) => {
        unreadTargetsRef.current = targets;
      },
    });
    chatHandleRef.current = handle;
    // If the panel was already open before this subscription was created
    // (e.g. fast remount), enable messages right away.
    if (openRef.current) handle.setMessagesEnabled(true);
    return () => {
      handle.unsubscribe();
      chatHandleRef.current = null;
    };
  }, [uid, eligible]);

  // Only attach per-thread message listeners while the chat panel is open.
  // Closed → list listeners only (badge from unreadForCustomer/unreadForTenant
  // on parent docs). This avoids tens of thousands of reads per page load.
  useEffect(() => {
    chatHandleRef.current?.setMessagesEnabled(open);
  }, [open]);

  /** Mark read across support + CC when sheet opens once per open gesture. */
  useEffect(() => {
    if (!open) {
      markedReadThisOpenRef.current = false;
      return;
    }
    if (markedReadThisOpenRef.current) return;
    markedReadThisOpenRef.current = true;

    const t = unreadTargetsRef.current;
    void markAllCcRoomsRead(t.ccRoomIds);
    for (const id of t.supportConversationIds) {
      void markCustomerConversationRead(id);
    }
  }, [open]);

  useEffect(() => {
    const h = () => setOpen(true);
    if (typeof window !== "undefined") {
      window.addEventListener(OPEN_SUPPORT_CHAT_EVENT, h);
      return () => window.removeEventListener(OPEN_SUPPORT_CHAT_EVENT, h);
    }
    return undefined;
  }, []);

  useEffect(() => {
    openRef.current = open;
    dispatchSupportChatPanelState(open);
    return () => {
      openRef.current = false;
      dispatchSupportChatPanelState(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [displayBubbles, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    setInput("");
    try {
      await sendUnifiedWorkshopChatMessage(text, preferredCcChatId);
    } catch (e) {
      setInput(text);
      setSendError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  }, [input, sending, preferredCcChatId]);

  if (!eligible) return null;
  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="support-chat-root">
      <div
        role="dialog"
        aria-modal={open}
        aria-hidden={!open}
        aria-label="Chat with receptionist"
        className={`chat-box ${open ? "show" : ""}`}
      >
        <div className="chat-header">
          <div className="header-left">
            <div
              className={`online-dot online-dot--${headerStatusDotModifier(headerSubtitle, preferredCcChatId)}`}
              aria-hidden
            />
            <div>
              <h3>{receptionHeaderTitle(headerSubtitle)}</h3>
              <p>{headerSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            className="close-btn"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
          >
            <X size={20} strokeWidth={2} />
          </button>
        </div>

        <div ref={scrollRef} className="chat-body">
          {displayBubbles.length === 0 ? (
            <div className="support-message welcome-msg">
              👋 Hi! Messages with our reception team (queue + direct chats) appear here in one thread.
            </div>
          ) : (
            displayBubbles.map((m) => {
              if (m.isSystem) {
                return (
                  <div key={m.key} className="system-line">
                    {m.text}
                  </div>
                );
              }
              const mine = m.isMine;
              return (
                <div key={m.key} className={`bubble-row ${mine ? "bubble-row--mine" : ""}`}>
                  <div className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}`}>
                    {!mine && (m.senderLabel || "").trim() ? (
                      <div className="bubble-name">{m.senderLabel}</div>
                    ) : null}
                    <div className="bubble-text">{m.text}</div>
                    <div className="bubble-time">{formatMsgTime(m.at)}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="chat-input-area">
          {sendError ? <div className="send-error">{sendError}</div> : null}
          <div className="chat-input-row">
            <input
              type="text"
              placeholder="Type your message..."
              value={input}
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={sending || !input.trim()}
              onClick={() => void send()}
              aria-label="Send message"
            >
              {sending ? (
                <span className="send-spinner">
                  <Loader2 size={18} strokeWidth={2} />
                </span>
              ) : (
                <Send size={18} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        data-support-chat-launcher
        className="support-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close receptionist chat" : "Open receptionist chat"}
        aria-expanded={open}
      >
        <div className="icon">
          <MessageCircle size={20} strokeWidth={2} />
        </div>
        <div className="support-btn-label">Chat with receptionist</div>
        {!open && fabUnread > 0 ? (
          <span className="unread-badge">{fabUnread > 9 ? "9+" : fabUnread}</span>
        ) : null}
      </button>

      <style jsx>{`
        .support-chat-root {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 2147483646;
        }

        .support-btn {
          pointer-events: auto;
          position: fixed;
          bottom: 20px;
          right: 20px;
          box-sizing: border-box;
          width: auto;
          min-width: 48px;
          max-width: 48px;
          height: 48px;
          background: ${ACCENT};
          border-radius: 50px;
          border: none;
          display: flex;
          align-items: center;
          overflow: hidden;
          cursor: pointer;
          transition: max-width 0.35s ease, background 0.25s ease,
            box-shadow 0.25s ease;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
          padding: 0 13px;
          z-index: 2;
          color: white;
        }

        .support-btn:hover {
          max-width: min(calc(100vw - 40px), 280px);
          background: ${ACCENT_HOVER};
        }

        .support-btn .icon {
          min-width: 20px;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .support-btn-label {
          color: white;
          white-space: nowrap;
          margin-left: 0;
          max-width: 0;
          opacity: 0;
          overflow: hidden;
          transition: max-width 0.35s ease, opacity 0.2s ease,
            margin-left 0.35s ease;
          font-size: 14px;
          font-weight: 600;
          flex-shrink: 0;
        }

        .support-btn:hover .support-btn-label {
          max-width: 205px;
          opacity: 1;
          margin-left: 11px;
          transition-delay: 0.08s;
        }

        .unread-badge {
          pointer-events: none;
          position: absolute;
          right: 6px;
          top: 5px;
          min-width: 15px;
          height: 15px;
          padding: 0 3px;
          border-radius: 999px;
          background: #ef4444;
          color: white;
          font-size: 9px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid white;
        }

        .chat-box {
          pointer-events: none;
          position: fixed;
          bottom: 80px;
          right: 20px;
          width: 360px;
          height: 520px;
          background: #1a1a1a;
          border-radius: 22px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          transform: translateY(20px);
          opacity: 0;
          transition: all 0.3s ease;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
          z-index: 1;
          font-family: var(--font-geist-sans), ui-sans-serif, system-ui,
            sans-serif;
        }

        .chat-box.show {
          transform: translateY(0);
          opacity: 1;
          pointer-events: auto;
        }

        .chat-header {
          background: ${ACCENT};
          color: white;
          padding: 18px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          flex-shrink: 0;
        }

        .header-left {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          min-width: 0;
        }

        .header-left h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
        }

        .header-left p {
          margin: 0;
          font-size: 12px;
          opacity: 0.92;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }

        .online-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
          margin-top: 4px;
        }

        .online-dot--live {
          background: #4ade80;
        }

        .online-dot--waiting {
          background: #fbbf24;
        }

        .online-dot--idle {
          background: #94a3b8;
        }

        .close-btn {
          background: transparent;
          border: none;
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border-radius: 8px;
          transition: background 0.15s ease;
          flex-shrink: 0;
        }

        .close-btn:hover {
          background: rgba(255, 255, 255, 0.15);
        }

        .chat-body {
          flex: 1;
          padding: 18px;
          overflow-y: auto;
          overflow-x: hidden;
          background: #111;
          min-height: 0;
        }

        .support-message {
          background: #262626;
          color: white;
          padding: 12px 14px;
          border-radius: 14px;
          width: fit-content;
          max-width: 85%;
          font-size: 14px;
          line-height: 1.4;
        }

        .welcome-msg {
          margin-bottom: 12px;
        }

        .system-line {
          text-align: center;
          font-size: 12px;
          color: #a3a3a3;
          margin: 10px 0;
          padding: 0 8px;
          line-height: 1.35;
        }

        .bubble-row {
          display: flex;
          width: 100%;
          margin-bottom: 10px;
          justify-content: flex-start;
        }

        .bubble-row--mine {
          justify-content: flex-end;
        }

        .bubble {
          max-width: 85%;
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 14px;
          line-height: 1.4;
        }

        .bubble--theirs {
          background: #262626;
          color: white;
        }

        .bubble--mine {
          background: ${ACCENT};
          color: white;
        }

        .bubble-name {
          font-size: 11px;
          font-weight: 700;
          opacity: 0.85;
          margin-bottom: 4px;
          text-transform: uppercase;
          letter-spacing: 0.02em;
        }

        .bubble-text {
          white-space: pre-wrap;
          word-break: break-word;
        }

        .bubble-time {
          margin-top: 6px;
          font-size: 11px;
          opacity: 0.65;
        }

        .chat-input-area {
          flex-shrink: 0;
          padding: 14px;
          background: #1a1a1a;
          border-top: 1px solid #2d2d2d;
        }

        .send-error {
          color: #fca5a5;
          font-size: 12px;
          margin-bottom: 8px;
          font-weight: 600;
        }

        .chat-input-row {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .chat-input-area input {
          flex: 1;
          height: 46px;
          border: none;
          outline: none;
          border-radius: 12px;
          padding: 0 14px;
          background: #2b2b2b !important;
          color: #ffffff !important;
          font-size: 14px !important;
        }

        .chat-input-area input::placeholder {
          color: #737373 !important;
        }

        .chat-input-area button {
          flex-shrink: 0;
          width: 46px;
          height: 46px;
          border: none;
          border-radius: 12px;
          background: ${ACCENT};
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s ease;
        }

        .chat-input-area button:hover:not(:disabled) {
          background: ${ACCENT_HOVER};
        }

        .chat-input-area button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .send-spinner {
          display: flex;
          align-items: center;
          justify-content: center;
          animation: supportSpin 0.8s linear infinite;
        }

        @keyframes supportSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 480px) {
          .chat-box {
            width: calc(100% - 20px);
            right: 10px;
            bottom: 72px;
            height: 75vh;
          }

          .support-btn {
            right: 10px;
            bottom: 10px;
          }

          .header-left p {
            max-width: 160px;
          }
        }
      `}</style>
    </div>,
    document.body,
  );
}
