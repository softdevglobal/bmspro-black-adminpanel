import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
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
 * Per **cc_direct_chats** thread: after "Chat ended" or at thread start, show who connected.
 * Support (`conversations`) already has server system lines on claim ("You are connected with …")
 * — we never inject virtual hints there, to avoid duplicates in the merged timeline.
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
      const tlow = m.text.toLowerCase();
      if (tlow.includes("chat ended")) {
        st.awaitingNewSegment = true;
        st.waitingForAgentAfterUser = false;
        byThread.set(tid, st);
      } else if (tlow.includes("connected with") || tlow.includes("you are now connected")) {
        st.awaitingNewSegment = false;
        st.waitingForAgentAfterUser = false;
        byThread.set(tid, st);
      }
      out.push(m);
      continue;
    }

    /* Support: no virtual hints (claim + system lines come from API). */
    if (m.source === "support") {
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

  return dedupeAdjacentIdenticalSystemBubbles(out);
}

/** Removes back-to-back identical system lines (e.g. duplicate claim echoes in Firestore). */
function dedupeAdjacentIdenticalSystemBubbles(rows: UnifiedChatBubble[]): UnifiedChatBubble[] {
  const out: UnifiedChatBubble[] = [];
  for (const m of rows) {
    const prev = out[out.length - 1];
    if (
      m.isSystem &&
      prev?.isSystem &&
      m.text.trim().toLowerCase() === prev.text.trim().toLowerCase()
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Prefer an active support thread for the header — newest-by-createdAt may be a closed doc. */
function pickConvHeadForHeader(
  docs: QueryDocumentSnapshot<DocumentData>[],
): { status: string; agentName: string } | null {
  if (docs.length === 0) return null;
  let bestConnected: { agentName: string; lastMs: number } | null = null;
  let bestWaiting: { agentName: string; lastMs: number } | null = null;
  for (const doc of docs) {
    const d = doc.data();
    const status = String(d.status || "").toLowerCase();
    const agentName = String(d.agentName || "").trim();
    const lm = d.lastMessageAt;
    const lastMs = lm instanceof Timestamp ? lm.toMillis() : 0;
    if (status === "connected") {
      if (!bestConnected || lastMs > bestConnected.lastMs) {
        bestConnected = { agentName, lastMs };
      }
    } else if (status === "waiting") {
      if (!bestWaiting || lastMs > bestWaiting.lastMs) {
        bestWaiting = { agentName, lastMs };
      }
    }
  }
  if (bestConnected) return { status: "connected", agentName: bestConnected.agentName };
  if (bestWaiting) return { status: "waiting", agentName: bestWaiting.agentName };
  const d0 = docs[0].data();
  return {
    status: String(d0.status || "").toLowerCase(),
    agentName: String(d0.agentName || "").trim(),
  };
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
// Per-thread message limits used ONLY while the chat panel is open. Previously
// these were 500 (support) and 800 (cc), and they were attached on every page
// load — that meant a workshop owner with a few active threads could trigger
// tens of thousands of Firestore reads on every navigation, before they even
// touched the chat. Now we only attach message listeners while the panel is
// open, and we cap the in-window history aggressively. The full history is
// still reachable by scrolling/searching once the panel is open and we
// re-fetch with `loadMore` if needed.
const SUPPORT_MSG_LIMIT = 50;
const CC_MSG_LIMIT = 50;

/** CC room doc subset for unread + sorting. */
type CcRoomMeta = {
  chatId: string;
  unreadForTenant: boolean;
  lastMessageAtMs: number;
  agentLabel: string;
  /** When true, tenant messages must not go to this thread — use support queue instead. */
  sessionClosed: boolean;
};

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

export type UnifiedWorkshopChatHandle = {
  /** Unsubscribe from everything (list listeners + any open message listeners). */
  unsubscribe: () => void;
  /**
   * Toggle whether per-thread message listeners are attached. Pass `true` when
   * the chat panel becomes visible and `false` when it closes. While disabled,
   * the FAB unread badge falls back to the per-thread `unreadForCustomer` /
   * `unreadForTenant` counters stored on the parent docs (so the user still
   * sees a "you have unread messages" indicator without us reading the entire
   * message history of every thread).
   */
  setMessagesEnabled: (enabled: boolean) => void;
};

/**
 * Subscribe to support `conversations` + `cc_direct_chats` for this workshop user,
 * merge all messages chronologically into one timeline.
 *
 * Returns a handle whose `setMessagesEnabled(true)` should be called when the
 * chat panel opens and `setMessagesEnabled(false)` when it closes. By default
 * messages are NOT attached — only the parent-doc list listeners run, which is
 * cheap and gives us enough info for the unread badge.
 */
export function subscribeUnifiedWorkshopChat(uid: string, cb: UnifiedWorkshopChatCallbacks): UnifiedWorkshopChatHandle {
  const supportMsgs = new Map<string, UnifiedChatBubble[]>();
  const ccMsgs = new Map<string, UnifiedChatBubble[]>();
  const convUnread = new Map<string, number>();
  let ccMetaById = new Map<string, CcRoomMeta>();

  const convMsgUnsubs = new Map<string, Unsubscribe>();

  let ccChatUnsub: Unsubscribe | undefined;
  const ccMsgUnsubs = new Map<string, Unsubscribe>();
  /** Per CC room: inbound messages not yet seen by tenant (for FAB numeric badge). */
  const ccInboundUnreadCount = new Map<string, number>();
  /** Newest conversation row (query is createdAt desc) — for header when no open CC thread. */
  let latestConvHead: { status: string; agentName: string } | null = null;
  /** Latest snapshots for each list — kept so we can lazily attach message listeners later. */
  const lastConvDocs = new Map<string, DocumentData>();
  const lastCcDocs = new Map<string, { agentLabel: string }>();
  /** Toggle: while false, no per-thread message listeners are attached. */
  let messagesEnabled = false;

  const flushHeader = (): void => {
    const openRooms = [...ccMetaById.values()].filter((m) => !m.sessionClosed);
    const ccList = openRooms.sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);
    if (ccList.length > 0) {
      const top = ccList[0];
      cb.onPreferredCcChatId(top.chatId);
      const label = top.agentLabel.trim();
      cb.onHeaderHint(label ? `Reception (${label}) · Connected` : "Reception · Connected");
      return;
    }
    cb.onPreferredCcChatId(null);
    const st = latestConvHead?.status ?? "";
    const agent = (latestConvHead?.agentName ?? "").trim();
    if (st === "connected" && agent) {
      cb.onHeaderHint(`Support (${agent}) · Connected`);
      return;
    }
    if (st === "waiting") {
      cb.onHeaderHint("Waiting for an agent…");
      return;
    }
    cb.onHeaderHint("Message our reception team");
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

  const attachConvMessages = (id: string): void => {
    if (convMsgUnsubs.has(id)) return;
    const qm = query(
      collection(db, "conversations", id, "messages"),
      orderBy("timestamp", "asc"),
      limit(SUPPORT_MSG_LIMIT),
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
  };

  const detachConvMessages = (id?: string): void => {
    if (id) {
      convMsgUnsubs.get(id)?.();
      convMsgUnsubs.delete(id);
      supportMsgs.delete(id);
      return;
    }
    for (const u of convMsgUnsubs.values()) u();
    convMsgUnsubs.clear();
    supportMsgs.clear();
  };

  const attachCcMessages = (chatId: string, agentLabel: string): void => {
    if (ccMsgUnsubs.has(chatId)) return;
    const qm = query(
      collection(db, "cc_direct_chats", chatId, "messages"),
      orderBy("createdAt", "asc"),
      limit(CC_MSG_LIMIT),
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

  const detachCcMessages = (chatId?: string): void => {
    if (chatId) {
      ccMsgUnsubs.get(chatId)?.();
      ccMsgUnsubs.delete(chatId);
      ccMsgs.delete(chatId);
      ccInboundUnreadCount.delete(chatId);
      return;
    }
    for (const u of ccMsgUnsubs.values()) u();
    ccMsgUnsubs.clear();
    ccMsgs.clear();
    ccInboundUnreadCount.clear();
  };

  const unsubConvList = onSnapshot(
    query(
      collection(db, "conversations"),
      where("userId", "==", uid),
      orderBy("createdAt", "desc"),
      limit(CONV_LIMIT),
    ),
    (snap) => {
      latestConvHead = pickConvHeadForHeader(snap.docs);

      const keep = new Set(snap.docs.map((d) => d.id));

      for (const id of [...convMsgUnsubs.keys()]) {
        if (!keep.has(id)) detachConvMessages(id);
      }
      for (const id of [...lastConvDocs.keys()]) {
        if (!keep.has(id)) lastConvDocs.delete(id);
      }

      for (const docSnap of snap.docs) {
        const id = docSnap.id;
        const data = docSnap.data();
        lastConvDocs.set(id, data);
        const unread =
          typeof data.unreadForCustomer === "number" ? data.unreadForCustomer : 0;
        convUnread.set(id, unread);
        if (messagesEnabled) attachConvMessages(id);
      }

      flush();
    },
    () => {
      cb.onBubbles([]);
      cb.onUnreadBadge(0);
    },
  );

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
        const sessionClosed = String(x.sessionStatus || "") === "closed";
        nextMeta.set(id, {
          chatId: id,
          unreadForTenant: x.unreadForTenant === true,
          lastMessageAtMs: tsMs(lm),
          agentLabel,
          sessionClosed,
        });
        lastCcDocs.set(id, { agentLabel });
        if (messagesEnabled) attachCcMessages(id, agentLabel);
      }

      for (const oldId of [...ccMsgUnsubs.keys()]) {
        if (!keep.has(oldId)) detachCcMessages(oldId);
      }
      for (const oldId of [...lastCcDocs.keys()]) {
        if (!keep.has(oldId)) lastCcDocs.delete(oldId);
      }

      ccMetaById = nextMeta;
      flush();
    },
    () => {
      ccMetaById = new Map();
      detachCcMessages();
      flush();
    },
  );

  const setMessagesEnabled = (enabled: boolean): void => {
    if (messagesEnabled === enabled) return;
    messagesEnabled = enabled;
    if (enabled) {
      for (const id of lastConvDocs.keys()) attachConvMessages(id);
      for (const [id, meta] of lastCcDocs.entries()) attachCcMessages(id, meta.agentLabel);
    } else {
      detachConvMessages();
      detachCcMessages();
      flush();
    }
  };

  const unsubscribe = (): void => {
    unsubConvList();
    ccChatUnsub?.();
    detachConvMessages();
    detachCcMessages();
    convUnread.clear();
    ccMetaById = new Map();
    lastConvDocs.clear();
    lastCcDocs.clear();
  };

  return { unsubscribe, setMessagesEnabled };
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
