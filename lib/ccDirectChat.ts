import {
  FieldValue,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Timestamp,
} from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { sendPushToUserByUid } from "@/lib/notifications";
import { serializeCallCenterAgent, type SerializedCallCenterAgent } from "@/lib/callCenterAgentsCrud";

/** 1:1 workshop user ↔ call center agent threads only. */
export const CC_DIRECT_CHATS = "cc_direct_chats";

const MAX_MESSAGE_LEN = 8000;
const LIST_MESSAGES_MAX = 100;
const MARK_READ_SCAN = 250;

export function buildCcChatId(tenantUserUid: string, agentUid: string): string {
  const [a, b] = [tenantUserUid, agentUid].sort((x, y) => x.localeCompare(y));
  return `cc_${a}_${b}`;
}

export async function resolveDisplayNameForUid(uid: string): Promise<string> {
  const db = adminDb();
  const u = await db.doc(`users/${uid}`).get();
  if (u.exists) {
    const d = u.data()!;
    const n = String(d.displayName || d.name || d.email || "").trim();
    if (n) return n;
  }
  const s = await db.doc(`salon_staff/${uid}`).get();
  if (s.exists) {
    const d = s.data()!;
    const n = String(d.displayName || d.name || d.email || "").trim();
    if (n) return n;
  }
  return "User";
}

/**
 * Eligible = row exists in `call_center_agents`, not suspended.
 * All docs in this collection are treated as messageable; optional `ccChatDisabled` to opt out.
 * No `assignedWorkshops` / workshop assignment check.
 */
export async function assertCallCenterAgentForDirectChat(
  agentUid: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const db = adminDb();
  const agentDoc = await db.doc(`call_center_agents/${agentUid}`).get();
  if (!agentDoc.exists) {
    return { ok: false, status: 404, error: "Agent not found" };
  }
  const data = agentDoc.data()!;
  if (data.suspended === true) {
    return { ok: false, status: 403, error: "Agent account suspended" };
  }
  if (data.ccChatDisabled === true) {
    return { ok: false, status: 403, error: "Agent is not available for chat" };
  }
  return { ok: true };
}

/** All non-suspended `call_center_agents` (Yeastar/legacy `agentType` rows included). */
export async function listAgentsForWorkshopChat(_workshopOwnerUid: string): Promise<SerializedCallCenterAgent[]> {
  const db = adminDb();
  const snap = await db.collection("call_center_agents").get();
  return snap.docs
    .map((doc) => serializeCallCenterAgent(doc.id, doc.data()!))
    .filter((a) => {
      if (a.suspended) return false;
      return true;
    });
}

function iso(ts: Timestamp | null | undefined): string | null {
  if (!ts || typeof ts.toDate !== "function") return null;
  try {
    return ts.toDate().toISOString();
  } catch {
    return null;
  }
}

export function serializeCcRoom(chatId: string, d: DocumentData) {
  const participantIds = Array.isArray(d.participantIds)
    ? d.participantIds.map((x: unknown) => String(x))
    : [];
  return {
    chatId: d.chatId || chatId,
    workshopOwnerUid: String(d.workshopOwnerUid || ""),
    tenantUserUid: String(d.tenantUserUid || ""),
    tenantRole: String(d.tenantRole || ""),
    agentUid: String(d.agentUid || ""),
    participantIds,
    agentName: String(d.agentName || "Agent"),
    tenantName: String(d.tenantName || "Workshop"),
    lastMessageText: d.lastMessageText != null ? String(d.lastMessageText) : null,
    lastMessageAt: iso(d.lastMessageAt as Timestamp),
    lastSenderId: d.lastSenderId != null ? String(d.lastSenderId) : null,
    /** Workshop-side list / badges: new inbound from agent until tenant opens thread (mark read). */
    unreadForTenant: d.unreadForTenant === true,
    /** Call-center list / badges: new inbound from tenant until agent calls mark read. */
    unreadForAgent: d.unreadForAgent === true,
    createdAt: iso(d.createdAt as Timestamp),
    updatedAt: iso(d.updatedAt as Timestamp),
  };
}

export function serializeCcMessage(docId: string, d: DocumentData) {
  return {
    messageId: String(d.messageId || docId),
    senderId: String(d.senderId || ""),
    senderRole: String(d.senderRole || ""),
    text: String(d.text || ""),
    createdAt: iso(d.createdAt as Timestamp),
    seenByRecipient: d.seenByRecipient === true,
    readAt: iso(d.readAt as Timestamp | undefined),
  };
}

export async function ensureCcDirectChat(input: {
  workshopOwnerUid: string;
  tenantUserUid: string;
  tenantRole: string;
  agentUid: string;
}): Promise<{ chatId: string; created: boolean }> {
  const gate = await assertCallCenterAgentForDirectChat(input.agentUid);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.error), { status: gate.status });
  }

  const chatId = buildCcChatId(input.tenantUserUid, input.agentUid);
  const db = adminDb();
  const ref = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const snap = await ref.get();

  const [tenantName, agentSnap] = await Promise.all([
    resolveDisplayNameForUid(input.tenantUserUid),
    db.doc(`call_center_agents/${input.agentUid}`).get(),
  ]);
  const agentData = agentSnap.data() || {};
  const agentName = String(agentData.displayName || agentData.name || "Agent").trim() || "Agent";
  const participantIds = [input.tenantUserUid, input.agentUid].sort((a, b) => a.localeCompare(b));

  const now = FieldValue.serverTimestamp();
  if (!snap.exists) {
    await ref.set({
      chatId,
      workshopOwnerUid: input.workshopOwnerUid,
      tenantUserUid: input.tenantUserUid,
      tenantRole: input.tenantRole,
      agentUid: input.agentUid,
      participantIds,
      agentName,
      tenantName,
      lastMessageText: "",
      lastMessageAt: now,
      lastSenderId: null,
      unreadForTenant: false,
      unreadForAgent: false,
      createdAt: now,
      updatedAt: now,
    });
    return { chatId, created: true };
  }

  await ref.set(
    {
      tenantName,
      agentName,
      participantIds,
      workshopOwnerUid: input.workshopOwnerUid,
      tenantUserUid: input.tenantUserUid,
      tenantRole: input.tenantRole,
      agentUid: input.agentUid,
      updatedAt: now,
    },
    { merge: true }
  );
  return { chatId, created: false };
}

export async function getCcRoomOrNull(chatId: string): Promise<DocumentData | null> {
  const db = adminDb();
  const snap = await db.collection(CC_DIRECT_CHATS).doc(chatId).get();
  if (!snap.exists) return null;
  return snap.data()!;
}

export function assertRoomParticipant(room: DocumentData, uid: string): void {
  const p = room.participantIds;
  if (!Array.isArray(p) || !p.map(String).includes(uid)) {
    const err = new Error("Forbidden");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

export async function assertWorkshopUserOwnsRoom(
  room: DocumentData,
  uid: string,
  workshopOwnerUid: string
): Promise<void> {
  assertRoomParticipant(room, uid);
  if (String(room.workshopOwnerUid || "") !== workshopOwnerUid) {
    const err = new Error("Forbidden");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  if (String(room.tenantUserUid || "") !== uid) {
    const err = new Error("Forbidden");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

export async function appendCcDirectMessage(input: {
  chatId: string;
  senderUid: string;
  senderRole: string;
  text: string;
}): Promise<{ messageId: string }> {
  const db = adminDb();
  const chatRef = db.collection(CC_DIRECT_CHATS).doc(input.chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) {
    const err = new Error("Chat not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const room = chatSnap.data()!;
  assertRoomParticipant(room, input.senderUid);

  const text = input.text.trim().slice(0, MAX_MESSAGE_LEN);
  if (!text) {
    const err = new Error("Message text is required");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const msgRef = chatRef.collection("messages").doc();
  const now = FieldValue.serverTimestamp();
  const tenantUid = String(room.tenantUserUid || "");
  const agentUid = String(room.agentUid || "");
  const fromTenant = input.senderUid === tenantUid;
  await db.runTransaction(async (tx) => {
    tx.set(msgRef, {
      messageId: msgRef.id,
      senderId: input.senderUid,
      senderRole: input.senderRole,
      text,
      createdAt: now,
      seenByRecipient: false,
      readAt: null,
    });
    tx.update(chatRef, {
      lastMessageText: text.slice(0, 500),
      lastMessageAt: now,
      lastSenderId: input.senderUid,
      updatedAt: now,
      // Recipient has "new" until they call mark read (clears the matching flag).
      unreadForTenant: fromTenant ? false : true,
      unreadForAgent: fromTenant ? true : false,
    });
  });

  const p = room.participantIds as string[];
  const recipientUid = p[0] === input.senderUid ? p[1] : p[0];
  const senderName =
    input.senderUid === room.tenantUserUid
      ? String(room.tenantName || "Workshop")
      : String(room.agentName || "Agent");

  await sendPushToUserByUid(recipientUid, senderName, text, {
    type: "cc_chat_message",
    chatId: input.chatId,
    senderUid: input.senderUid,
    senderName,
  });

  return { messageId: msgRef.id };
}

export async function listCcMessages(
  chatId: string,
  requesterUid: string,
  limit: number,
  beforeMessageId?: string | null
): Promise<{ messages: ReturnType<typeof serializeCcMessage>[] } | null> {
  const db = adminDb();
  const chatRef = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) return null;
  assertRoomParticipant(chatSnap.data()!, requesterUid);

  const lim = Math.min(Math.max(1, limit), LIST_MESSAGES_MAX);
  let q = chatRef.collection("messages").orderBy("createdAt", "desc").limit(lim);
  if (beforeMessageId) {
    const cur = await chatRef.collection("messages").doc(beforeMessageId).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const snap = await q.get();
  return { messages: snap.docs.map((d) => serializeCcMessage(d.id, d.data())) };
}

export async function markCcDirectChatRead(chatId: string, readerUid: string): Promise<{ updated: number }> {
  const db = adminDb();
  const chatRef = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) {
    const err = new Error("Chat not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const roomData = chatSnap.data()!;
  assertRoomParticipant(roomData, readerUid);

  const recent = await chatRef.collection("messages").orderBy("createdAt", "desc").limit(MARK_READ_SCAN).get();

  const readTs = FieldValue.serverTimestamp();
  let batch = db.batch();
  let ops = 0;
  let updated = 0;

  for (const doc of recent.docs) {
    const d = doc.data();
    if (String(d.senderId || "") === readerUid) continue;
    if (d.seenByRecipient === true) continue;
    batch.update(doc.ref, { seenByRecipient: true, readAt: readTs });
    ops++;
    updated++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  const tenantUid = String(roomData.tenantUserUid || "");
  const agentUid = String(roomData.agentUid || "");
  const roomUnreadPatch: { unreadForTenant?: boolean; unreadForAgent?: boolean } = {};
  if (readerUid === tenantUid) roomUnreadPatch.unreadForTenant = false;
  if (readerUid === agentUid) roomUnreadPatch.unreadForAgent = false;
  if (Object.keys(roomUnreadPatch).length > 0) {
    await chatRef.update(roomUnreadPatch);
  }

  return { updated };
}

function lastMessageAtMs(d: DocumentData): number {
  const t = d.lastMessageAt as Timestamp | undefined;
  if (t && typeof t.toMillis === "function") return t.toMillis();
  return 0;
}

/** Firestore requires a composite index for equality + orderBy; production may not have it deployed yet. */
function isMissingCompositeIndexError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("FAILED_PRECONDITION") && msg.includes("index");
}

function sortCcRoomsByLastMessageDesc(docs: QueryDocumentSnapshot[], lim: number) {
  return docs
    .map((doc) => ({ id: doc.id, data: doc.data() as DocumentData }))
    .sort((a, b) => lastMessageAtMs(b.data) - lastMessageAtMs(a.data))
    .slice(0, lim)
    .map((x) => serializeCcRoom(x.id, x.data));
}

export async function listCcChatsForTenantUser(tenantUserUid: string, limit: number) {
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("tenantUserUid", "==", tenantUserUid)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    return snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("tenantUserUid", "==", tenantUserUid)
      .get();
    return sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }
}

export async function listCcChatsForAgent(agentUid: string, limit: number) {
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("agentUid", "==", agentUid)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    return snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const snap = await db.collection(CC_DIRECT_CHATS).where("agentUid", "==", agentUid).get();
    return sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }
}
