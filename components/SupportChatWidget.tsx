"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { Timestamp } from "firebase/firestore";
import { auth } from "@/lib/firebase";
import { fetchCurrentUser } from "@/lib/authClient";
import {
  markCustomerConversationRead,
  sendCustomerSupportMessage,
  subscribeLatestConversation,
  subscribeMessages,
  type LatestConversationRow,
  type SupportChatMsgRow,
} from "@/lib/supportChatClient";

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

function headerSubtitle(latest: LatestConversationRow | null): string {
  if (!latest) return "Receptionist is online";
  const status = latest.status;
  if (status === "waiting") return "Connecting you to a receptionist…";
  if (status === "connected") {
    return latest.agentName.trim()
      ? `Chatting with ${latest.agentName}`
      : "Connected to a receptionist";
  }
  if (status === "closed") return "Chat ended — send a message to start again";
  return "Receptionist is online";
}

export default function SupportChatWidget() {
  const [eligible, setEligible] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<LatestConversationRow | null>(null);
  const [messages, setMessages] = useState<SupportChatMsgRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markedOpenRef = useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);

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

  useEffect(() => {
    if (!uid || !eligible) return;
    const unsub = subscribeLatestConversation(uid, setLatest, (e) =>
      console.error("[SupportChatWidget] conversation listener:", e),
    );
    return () => unsub();
  }, [uid, eligible]);

  /** Live session (not closed by receptionist). Sending still works after close via new conversation. */
  const activeConversation =
    latest && latest.status !== "closed" ? latest : null;

  useEffect(() => {
    if (!latest?.id) {
      setMessages([]);
      return;
    }
    const unsub = subscribeMessages(
      latest.id,
      setMessages,
      (e) => console.error("[SupportChatWidget] messages listener:", e),
    );
    return () => unsub();
  }, [latest?.id]);

  useEffect(() => {
    if (!open || !latest?.id || latest.status === "closed") return;
    if (markedOpenRef.current === latest.id) return;
    markedOpenRef.current = latest.id;
    void markCustomerConversationRead(latest.id);
  }, [open, latest?.id, latest?.status]);

  useEffect(() => {
    if (!open) markedOpenRef.current = null;
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
  }, [messages, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    setInput("");
    try {
      await sendCustomerSupportMessage(text);
    } catch (e) {
      setInput(text);
      setSendError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  if (!eligible) return null;
  if (!mounted || typeof document === "undefined") return null;

  const unread =
    activeConversation && activeConversation.unreadForCustomer > 0
      ? activeConversation.unreadForCustomer
      : 0;

  const subtitle = headerSubtitle(latest);
  const statusDotClass =
    latest?.status === "connected"
      ? "online-dot online-dot--live"
      : latest?.status === "waiting"
        ? "online-dot online-dot--pending"
        : "online-dot";

  return createPortal(
    <div className="support-chat-root">
      {/* Chat panel */}
      <div
        role="dialog"
        aria-modal={open}
        aria-hidden={!open}
        aria-label="Chat with receptionist"
        className={`chat-box ${open ? "show" : ""}`}
      >
        <div className="chat-header">
          <div className="header-left">
            <div className={statusDotClass} aria-hidden />
            <div>
              <h3>Chat with receptionist</h3>
              <p>{subtitle}</p>
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
          {!latest && (
            <div className="support-message welcome-msg">
              👋 Hi! Message our receptionist if you need anything.
            </div>
          )}
          {latest && messages.length === 0 && latest.status !== "closed" && (
            <div className="support-message welcome-msg">
              Say hello — a receptionist will reply shortly.
            </div>
          )}
          {latest &&
            messages.map((m) => {
              if (m.sender === "system") {
                return (
                  <div key={m.id} className="system-line">
                    {m.message}
                  </div>
                );
              }
              const mine = m.sender === "customer";
              return (
                <div
                  key={m.id}
                  className={`bubble-row ${mine ? "bubble-row--mine" : ""}`}
                >
                  <div
                    className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"}`}
                  >
                    {!mine && m.senderName.trim() ? (
                      <div className="bubble-name">{m.senderName}</div>
                    ) : null}
                    <div className="bubble-text">{m.message}</div>
                    <div className="bubble-time">{formatMsgTime(m.timestamp)}</div>
                  </div>
                </div>
              );
            })}
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

      {/* FAB */}
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
        {!open && unread > 0 ? (
          <span className="unread-badge">{unread > 9 ? "9+" : unread}</span>
        ) : null}
      </button>

      <style jsx>{`
        .support-chat-root {
          /* z-index only applies with non-static position; full-viewport layer so chat stays above sticky headers (e.g. dashboard calendar z-30). */
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
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }

        .header-left {
          display: flex;
          align-items: center;
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
          background: white;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .online-dot--pending {
          background: #fbbf24;
        }

        .online-dot--live {
          background: #4ade80;
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
        }

        .close-btn:hover {
          background: rgba(255, 255, 255, 0.15);
        }

        .chat-body {
          flex: 1;
          padding: 18px;
          overflow-y: auto;
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
