import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { sendCustomerSupportMessage } from "@/lib/supportChatClient";

export type UnifiedChatSource = "support" | "cc";

export type UnifiedChatBubble = {
  key: string;
  source: UnifiedChatSource;
  /** Support conversation id or cc_direct_chats doc id — for grouping / debugging */
  threadId: string;
  senderLabel: string;
  isMine: boolean;
  /** Support-chat system rows (chat ended, etc.) */
  isSystem?: boolean;
  text: string;
  at: Timestamp | null;
};

const virtKey = (prefix: string, threadKey: string, baseKey: string) =>
  `__virt_${prefix}_${threadKey}_${baseKey}`;

/**
 * Per support / CC thread: after "Chat ended" (support) or at thread start, show who connected.
 * - Agent speaks first → "Receptionist {name} connected with you" before their message.
 * - User speaks first → "You are connected with {name}" before the agent's first reply.
 */
export function injectReceptionConnectionHints(bubbles: UnifiedChatBubble[]): UnifiedChatBubble[] {
  type St = { awaitingNewSegment: boolean; waitingForAgentAfterUser: boolean };
  const byThread = new Map<string, St>();

  const ensureSt = (tid: string): St => {
    let s = byThread.get(tid);
    if (!s) {
      s = { awaitingNewSegment: true, waitingForAgentAfterUser: false };
      byThread.set(tid, s);
    }
    return s;
  };

  const out: UnifiedChatBubble[] = [];

  for (const m of bubbles) {
    const tid = `${m.source}:${m.threadId}`;
    const st = ensureSt(tid);

    if (m.isSystem) {
      const closed = m.text.toLowerCase().includes("chat ended");
      if (closed) {
        st.awaitingNewSegment = true;
        st.waitingForAgentAfterUser = false;
        byThread.set(tid, st);
      }
      out.push(m);
      continue;
    }

    const agentName = (m.senderLabel || "").trim() || "Reception";

    if (st.awaitingNewSegment) {
      if (!m.isMine) {
        out.push({
          key: virtKey("rcpt", tid, m.key),
          source: m.source,
          threadId: m.threadId,
          senderLabel: "",
          isMine: false,
          isSystem: true,
          text: `Receptionist ${agentName} connected with you`,
          at: m.at,
        });
        st.waitingForAgentAfterUser = false;
      } else {
        st.waitingForAgentAfterUser = true;
      }
      st.awaitingNewSegment = false;
      byThread.set(tid, st);
    } else if (st.waitingForAgentAfterUser && !m.isMine) {
      out.push({
        key: virtKey("you", tid, m.key),
        source: m.source,
        threadId: m.threadId,
        senderLabel: "",
        isMine: false,
        isSystem: true,
        text: `You are connected with ${agentName}`,
        at: m.at,
      });
      st.waitingForAgentAfterUser = false;
      byThread.set(tid, st);
    }

    out.push(m);
    byThread.set(tid, st);
  }

  return out;
}

export type UnifiedWorkshopChatCallbacks = {
  onBubbles: (rows: UnifiedChatBubble[]) => void;
  /** Best cc_direct_chats doc id for sending when owner replies (latest activity). Null if none. */
  onPreferredCcChatId: (chatId: string | null) => void;
  onUnreadBadge: (n: number) => void;
  onHeaderHint: (text: string) => void;
  /** Convs / rooms currently showing unread — for marking read when the panel opens. */
  onUnreadTargets?: (targets: { supportConversationIds: string[]; ccRoomIds: string[] }) => void;
};

const CONV_LIMIT = 40;
const CC_LIMIT = 50;

/** CC room doc subset for unread + sorting. */
type CcRoomMeta = { chatId: string; unreadForTenant: boolean; lastMessageAtMs: number; agentLabel: string };

function tsMs(t: Timestamp | null | undefined): number {
  if (!t || !(t instanceof Timestamp)) return 0;
  try {
    return t.toMillis();
  } catch {
    return 0;
  }
}

function bubbleSort(a: UnifiedChatBubble, b: UnifiedChatBubble): number {
  const ta = tsMs(a.at);
  const tb = tsMs(b.at);
  if (ta !== tb) return ta - tb;
  return a.key.localeCompare(b.key);
}

async function ccMarkRead(chatId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const token = await user.getIdToken();
  await fetch(`/api/chats/cc/rooms/${encodeURIComponent(chatId)}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

/**
 * Subscribe to support `conversations` + `cc_direct_chats` for this workshop user,
 * merge all messages chronologically into one timeline.
 */
export function subscribeUnifiedWorkshopChat(uid: string, cb: UnifiedWorkshopChatCallbacks): () => void {
  const supportMsgs = new Map<string, UnifiedChatBubble[]>();
  const ccMsgs = new Map<string, UnifiedChatBubble[]>();
  const convUnread = new Map<string, number>();
  let ccMetaById = new Map<string, CcRoomMeta>();

  const convMsgUnsubs = new Map<string, Unsubscribe>();

  let ccChatUnsub: Unsubscribe | undefined;
  const ccMsgUnsubs = new Map<string, Unsubscribe>();
  /** Per CC room: inbound messages not yet seen by tenant (for FAB numeric badge). */
  const ccInboundUnreadCount = new Map<string, number>();

  const flushHeader = (): void => {
    const ccList = [...ccMetaById.values()].sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);
    if (ccList.length === 0) {
      cb.onPreferredCcChatId(null);
      cb.onHeaderHint("Message our reception team");
      return;
    }
    const top = ccList[0];
    cb.onPreferredCcChatId(top.chatId);
    const label = top.agentLabel.trim();
    cb.onHeaderHint(label ? `Reception (${label})` : "Chat with reception");
  };

  const flush = (): void => {
    const rows: UnifiedChatBubble[] = [];
    for (const list of supportMsgs.values()) rows.push(...list);
    for (const list of ccMsgs.values()) rows.push(...list);
    rows.sort(bubbleSort);
    cb.onBubbles(rows);

    let badge = 0;
    for (const n of convUnread.values()) {
      if (typeof n === "number" && n > 0) badge += n;
    }
    const ccIds = new Set([...ccMetaById.keys(), ...ccInboundUnreadCount.keys()]);
    for (const cid of ccIds) {
      const fromMsgs = ccInboundUnreadCount.get(cid);
      if (typeof fromMsgs === "number" && fromMsgs > 0) {
        badge += fromMsgs;
      } else if (ccMetaById.get(cid)?.unreadForTenant) {
        badge += 1;
      }
    }
    cb.onUnreadBadge(badge);

    const supportConversationIds = [...convUnread.entries()]
      .filter(([, n]) => typeof n === "number" && n > 0)
      .map(([id]) => id);
    const ccRoomIds = [...ccMetaById.values()]
      .filter((m) => m.unreadForTenant)
      .map((m) => m.chatId);
    cb.onUnreadTargets?.({ supportConversationIds, ccRoomIds });

    flushHeader();
  };

  const unsubConvList = onSnapshot(
    query(
      collection(db, "conversations"),
      where("userId", "==", uid),
      orderBy("createdAt", "desc"),
      limit(CONV_LIMIT),
    ),
    (snap) => {
      const keep = new Set(snap.docs.map((d) => d.id));

      for (const id of [...convMsgUnsubs.keys()]) {
        if (!keep.has(id)) {
          convMsgUnsubs.get(id)?.();
          convMsgUnsubs.delete(id);
          supportMsgs.delete(id);
          convUnread.delete(id);
        }
      }

      for (const docSnap of snap.docs) {
        const id = docSnap.id;
        const data = docSnap.data();
        const unread =
          typeof data.unreadForCustomer === "number" ? data.unreadForCustomer : 0;
        convUnread.set(id, unread);

        if (convMsgUnsubs.has(id)) continue;

        const qm = query(
          collection(db, "conversations", id, "messages"),
          orderBy("timestamp", "asc"),
          limit(500),
        );
        const u = onSnapshot(
          qm,
          (mSnap) => {
            const list: UnifiedChatBubble[] = [];
            mSnap.forEach((m) => {
              const md = m.data();
              const ts = md.timestamp instanceof Timestamp ? md.timestamp : null;
              const sender = String(md.sender ?? "agent");
              if (sender === "system") {
                list.push({
                  key: `s:${id}:${m.id}`,
                  source: "support",
                  threadId: id,
                  senderLabel: "",
                  isMine: false,
                  isSystem: true,
                  text: String(md.message ?? ""),
                  at: ts,
                });
                return;
              }
              const mine = sender === "customer";
              list.push({
                key: `s:${id}:${m.id}`,
                source: "support",
                threadId: id,
                senderLabel: mine ? "You" : String(md.senderName || "Agent").trim() || "Agent",
                isMine: mine,
                text: String(md.message ?? ""),
                at: ts,
              });
            });
            supportMsgs.set(id, list);
            flush();
          },
          () => {
            supportMsgs.set(id, []);
            flush();
          },
        );
        convMsgUnsubs.set(id, u);
      }

      flush();
    },
    () => {
      cb.onBubbles([]);
      cb.onUnreadBadge(0);
    },
  );

  const attachCcMessages = (chatId: string, agentLabel: string): void => {
    if (ccMsgUnsubs.has(chatId)) return;
    const qm = query(
      collection(db, "cc_direct_chats", chatId, "messages"),
      orderBy("createdAt", "asc"),
      limit(800),
    );
    const u = onSnapshot(
      qm,
      (mSnap) => {
        const list: UnifiedChatBubble[] = [];
        let inboundUnread = 0;
        mSnap.forEach((m) => {
          const md = m.data();
          const ts = md.createdAt instanceof Timestamp ? md.createdAt : null;
          const role = String(md.senderRole || "");
          if (role === "system" || md.messageKind === "system") {
            list.push({
              key: `c:${chatId}:${m.id}`,
              source: "cc",
              threadId: chatId,
              senderLabel: "",
              isMine: false,
              isSystem: true,
              text: String(md.text ?? ""),
              at: ts,
            });
            return;
          }
          const sid = String(md.senderId || "");
          const mine = sid === uid;
          if (!mine && md.seenByRecipient !== true) inboundUnread += 1;
          list.push({
            key: `c:${chatId}:${m.id}`,
            source: "cc",
            threadId: chatId,
            senderLabel: mine ? "You" : agentLabel.trim() || "Agent",
            isMine: mine,
            text: String(md.text ?? ""),
            at: ts,
          });
        });
        ccInboundUnreadCount.set(chatId, inboundUnread);
        ccMsgs.set(chatId, list);
        flush();
      },
      () => {
        ccMsgs.set(chatId, []);
        flush();
      },
    );
    ccMsgUnsubs.set(chatId, u);
  };

  ccChatUnsub = onSnapshot(
    query(
      collection(db, "cc_direct_chats"),
      where("tenantUserUid", "==", uid),
      orderBy("lastMessageAt", "desc"),
      limit(CC_LIMIT),
    ),
    (snap) => {
      const keep = new Set(snap.docs.map((d) => d.id));
      const nextMeta = new Map<string, CcRoomMeta>();

      for (const docSnap of snap.docs) {
        const id = docSnap.id;
        const x = docSnap.data();
        const lm = x.lastMessageAt instanceof Timestamp ? x.lastMessageAt : null;
        const agentLabel =
          typeof x.agentName === "string" && x.agentName.trim()
            ? String(x.agentName).trim()
            : "Agent";
        nextMeta.set(id, {
          chatId: id,
          unreadForTenant: x.unreadForTenant === true,
          lastMessageAtMs: tsMs(lm),
          agentLabel,
        });
        attachCcMessages(id, agentLabel);
      }

      for (const oldId of [...ccMsgUnsubs.keys()]) {
        if (!keep.has(oldId)) {
          ccMsgUnsubs.get(oldId)?.();
          ccMsgUnsubs.delete(oldId);
          ccMsgs.delete(oldId);
          ccInboundUnreadCount.delete(oldId);
        }
      }

      ccMetaById = nextMeta;
      flush();
    },
    () => {
      ccMetaById = new Map();
      for (const u of ccMsgUnsubs.values()) u();
      ccMsgUnsubs.clear();
      ccMsgs.clear();
      ccInboundUnreadCount.clear();
      flush();
    },
  );

  return () => {
    unsubConvList();
    ccChatUnsub?.();
    for (const u of convMsgUnsubs.values()) u();
    convMsgUnsubs.clear();
    for (const u of ccMsgUnsubs.values()) u();
    ccMsgUnsubs.clear();
    supportMsgs.clear();
    ccMsgs.clear();
    ccInboundUnreadCount.clear();
    convUnread.clear();
    ccMetaById = new Map();
  };
}

export async function sendUnifiedWorkshopChatMessage(text: string, preferredCcChatId: string | null): Promise<void> {
  const t = text.trim();
  if (!t) throw new Error("Empty message");

  if (preferredCcChatId) {
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to chat.");
    const token = await user.getIdToken();
    const res = await fetch(`/api/chats/cc/rooms/${encodeURIComponent(preferredCcChatId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: t }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof body?.error === "string" ? body.error : `Could not send (${res.status})`);
    }
    return;
  }

  await sendCustomerSupportMessage(t);
}

export async function markAllCcRoomsRead(roomIds: string[]): Promise<void> {
  await Promise.all(roomIds.map((id) => ccMarkRead(id)));
}
