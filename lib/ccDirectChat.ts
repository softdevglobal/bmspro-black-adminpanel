import { randomBytes } from "crypto";
import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
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

/** New request in the shared queue (no agent chosen by the workshop user). */
export function buildCcQueueRequestId(): string {
  return `cc_req_${randomBytes(12).toString("hex")}`;
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
    /** Call center: thread marked reviewed (e.g. handled); any agent with access can set via PATCH. */
    chatsReviewed: d.chatsReviewed === true,
    chatsReviewedAt: iso(d.chatsReviewedAt as Timestamp | undefined),
    chatsReviewedByUid: d.chatsReviewedByUid != null ? String(d.chatsReviewedByUid) : null,
    createdAt: iso(d.createdAt as Timestamp),
    updatedAt: iso(d.updatedAt as Timestamp),
    /** `pending` = waiting for an agent to claim; `active` = assigned (includes legacy docs without field). */
    queueStatus: d.queueStatus === "pending" ? "pending" : "active",
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

/** From `users/{workshopOwnerUid}` — public-facing workshop / business context for call center. */
export type CcWorkshopDetails = {
  ownerUid: string;
  name: string;
  displayName: string;
  slug: string;
  logoUrl: string;
  email: string;
  phone: string;
  address: string;
  abn: string;
  timezone: string;
  state: string;
  bookingEngineUrl: string;
  accountStatus: string;
};

/** From `users/{tenantUserUid}` — who at the workshop is in the thread. */
export type CcWorkshopUserDetails = {
  uid: string;
  name: string;
  displayName: string;
  email: string;
  role: string;
  phone: string;
  branchId: string;
  branchName: string;
};

function workshopDetailsFromUserDoc(ownerUid: string, d: DocumentData): CcWorkshopDetails {
  return {
    ownerUid,
    name: String(d.name || d.displayName || "Workshop").trim() || "Workshop",
    displayName: String(d.displayName || "").trim(),
    slug: String(d.slug || "").trim(),
    logoUrl: String(d.logoUrl || "").trim(),
    email: String(d.email || "").trim(),
    phone: String(d.contactPhone || d.phone || d.clientPhone || "").trim(),
    address: String(d.locationText || d.address || "").trim(),
    abn: String(d.abn || "").trim(),
    timezone: String(d.timezone || "Australia/Sydney").trim(),
    state: String(d.state || "").trim(),
    bookingEngineUrl: String(d.bookingEngineUrl || "").trim(),
    accountStatus: String(d.accountStatus || d.status || "active").trim(),
  };
}

function workshopUserFromUserDoc(uid: string, d: DocumentData): CcWorkshopUserDetails {
  return {
    uid,
    name: String(d.name || "").trim(),
    displayName: String(d.displayName || "").trim(),
    email: String(d.email || "").trim(),
    role: String(d.role || d.systemRole || "").trim(),
    phone: String(d.phone || d.contactPhone || d.clientPhone || "").trim(),
    branchId: String(d.branchId || "").trim(),
    branchName: String(d.branchName || "").trim(),
  };
}

export type CcChatWithDetails = ReturnType<typeof serializeCcRoom> & {
  workshop: CcWorkshopDetails | null;
  /** The workshop-side account in this thread (call center + GET-by-id). Omitted in workshop-app list. */
  workshopUser?: CcWorkshopUserDetails | null;
};

async function getAllDocSnapshots(db: ReturnType<typeof adminDb>, refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const out: DocumentSnapshot[] = [];
  const chunk = 20;
  for (let i = 0; i < refs.length; i += chunk) {
    const slice = refs.slice(i, i + chunk);
    // eslint-disable-next-line no-await-in-loop
    const part = await db.getAll(...slice);
    out.push(...part);
  }
  return out;
}

/**
 * Batch-loads `users` + optional `branches` to attach workshop business info and (for agents) the tenant row.
 */
export async function attachDetailsToCcChats(
  rooms: ReturnType<typeof serializeCcRoom>[],
  options: { includeWorkshopUser: boolean }
): Promise<CcChatWithDetails[]> {
  if (rooms.length === 0) return [];

  const db = adminDb();
  const ownerUids = [...new Set(rooms.map((r) => r.workshopOwnerUid).filter((x) => x.length > 0))];
  const tenantUids = options.includeWorkshopUser
    ? [...new Set(rooms.map((r) => r.tenantUserUid).filter((x) => x.length > 0))]
    : [];

  const ownerRefs = ownerUids.map((uid) => db.doc(`users/${uid}`));
  const tenantRefs = tenantUids.map((uid) => db.doc(`users/${uid}`));

  const [ownerSnaps, tenantSnaps] = await Promise.all([
    getAllDocSnapshots(db, ownerRefs),
    getAllDocSnapshots(db, tenantRefs),
  ]);

  const byOwner = new Map<string, DocumentData | null>();
  for (const s of ownerSnaps) {
    byOwner.set(s.id, s.exists ? s.data()! : null);
  }
  const byTenant = new Map<string, DocumentData | null>();
  for (const s of tenantSnaps) {
    byTenant.set(s.id, s.exists ? s.data()! : null);
  }

  const branchIds = options.includeWorkshopUser
    ? [
        ...new Set(
          Array.from(byTenant.values())
            .map((d) => (d ? String(d.branchId || "").trim() : ""))
            .filter((x) => x.length > 0)
        ),
      ]
    : [];
  const branchRefs = branchIds.map((id) => db.doc(`branches/${id}`));
  const branchSnaps = await getAllDocSnapshots(db, branchRefs);
  const branchNames = new Map<string, string>();
  for (const s of branchSnaps) {
    if (s.exists) {
      const n = String(s.data()!.name || "").trim();
      if (n) branchNames.set(s.id, n);
    }
  }

  return rooms.map((r) => {
    const od = r.workshopOwnerUid ? byOwner.get(r.workshopOwnerUid) : null;
    const workshop: CcWorkshopDetails | null =
      r.workshopOwnerUid && od ? workshopDetailsFromUserDoc(r.workshopOwnerUid, od) : null;

    let workshopUser: CcWorkshopUserDetails | null = null;
    if (options.includeWorkshopUser && r.tenantUserUid) {
      const td = byTenant.get(r.tenantUserUid);
      if (td) {
        workshopUser = workshopUserFromUserDoc(r.tenantUserUid, td);
        const bid = workshopUser.branchId;
        if (bid && branchNames.has(bid) && !workshopUser.branchName) {
          workshopUser = { ...workshopUser, branchName: branchNames.get(bid) || "" };
        }
      }
    }

    return {
      ...r,
      workshop,
      ...(options.includeWorkshopUser ? { workshopUser } : {}),
    } as CcChatWithDetails;
  });
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
      chatsReviewed: false,
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

/**
 * Creates a call-center thread in the **shared queue** — no pre-selected agent.
 * The first agent who claims it (admin / API) becomes the 1:1 peer.
 */
export async function ensureCcQueueRequest(input: {
  workshopOwnerUid: string;
  tenantUserUid: string;
  tenantRole: string;
}): Promise<{ chatId: string; created: boolean }> {
  const db = adminDb();
  const chatId = buildCcQueueRequestId();
  const ref = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const tenantName = await resolveDisplayNameForUid(input.tenantUserUid);
  const now = FieldValue.serverTimestamp();
  await ref.set({
    chatId,
    workshopOwnerUid: input.workshopOwnerUid,
    tenantUserUid: input.tenantUserUid,
    tenantRole: input.tenantRole,
    agentUid: "",
    agentName: "Call center",
    queueStatus: "pending",
    participantIds: [input.tenantUserUid],
    tenantName,
    lastMessageText: "",
    lastMessageAt: now,
    lastSenderId: null,
    unreadForTenant: false,
    unreadForAgent: false,
    chatsReviewed: false,
    createdAt: now,
    updatedAt: now,
  });
  return { chatId, created: true };
}

/**
 * Assigns a pending queue chat to the calling agent. Idempotent for same agent.
 */
export async function claimCcQueueChat(
  chatId: string,
  agentUid: string,
  canAccessWorkshop: (workshopOwnerUid: string) => boolean
): Promise<void> {
  const db = adminDb();
  const ref = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const gate = await assertCallCenterAgentForDirectChat(agentUid);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.error), { status: gate.status });
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error("Chat not found");
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    const d = snap.data()!;
    const currentAgent = String(d.agentUid || "").trim();
    const isPending = String(d.queueStatus || "") === "pending";
    if (!isPending) {
      if (currentAgent === agentUid) return;
      if (currentAgent) {
        const err = new Error("This chat is already assigned to another agent");
        (err as Error & { status?: number }).status = 409;
        throw err;
      }
      const err = new Error("This chat is not in the unclaimed queue");
      (err as Error & { status?: number }).status = 400;
      throw err;
    }
    const w = String(d.workshopOwnerUid || "").trim();
    if (!w || !canAccessWorkshop(w)) {
      const err = new Error("You do not have access to this workshop's queue");
      (err as Error & { status?: number }).status = 403;
      throw err;
    }
    const agentDoc = await tx.get(db.doc(`call_center_agents/${agentUid}`));
    const ad = agentDoc.data() || {};
    const agentName = String(ad.displayName || ad.name || "Agent").trim() || "Agent";
    const tenantUserUid = String(d.tenantUserUid || "");
    if (!tenantUserUid) {
      const err = new Error("Invalid chat data");
      (err as Error & { status?: number }).status = 500;
      throw err;
    }
    const participantIds = [tenantUserUid, agentUid].sort((a, b) => a.localeCompare(b));
    const now = FieldValue.serverTimestamp();
    tx.update(ref, {
      agentUid,
      agentName,
      queueStatus: "active",
      participantIds,
      unreadForAgent: true,
      updatedAt: now,
    });
  });
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
      // New message from workshop → needs call-center review again.
      ...(fromTenant ? { chatsReviewed: false } : {}),
    });
  });

  const p = (room.participantIds as string[]) || [];
  let recipientUid: string | null = null;
  if (p.length >= 2) {
    recipientUid = p[0] === input.senderUid ? p[1] : p[0];
  } else if (p.length === 1) {
    const only = p[0];
    if (only !== input.senderUid) recipientUid = only;
    // Pending queue (only tenant in thread): no agent to push yet.
  }

  const senderName =
    input.senderUid === room.tenantUserUid
      ? String(room.tenantName || "Workshop")
      : String(room.agentName || "Agent");

  if (recipientUid) {
    await sendPushToUserByUid(recipientUid, senderName, text, {
      type: "cc_chat_message",
      chatId: input.chatId,
      senderUid: input.senderUid,
      senderName,
    });
  }

  return { messageId: msgRef.id };
}

export async function listCcMessages(
  chatId: string,
  requesterUid: string,
  limit: number,
  beforeMessageId?: string | null,
  options?: { roomReadGatePreenacted?: boolean }
): Promise<{ messages: ReturnType<typeof serializeCcMessage>[] } | null> {
  const db = adminDb();
  const chatRef = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) return null;
  const room = chatSnap.data()!;
  if (!options?.roomReadGatePreenacted) {
    assertRoomParticipant(room, requesterUid);
  }

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

/**
 * Mark whether call center has reviewed / handled the thread.
 * - Normal agents: must be a room participant.
 * - `call_center_admin`: can update any `cc_direct_chats` row (shared queue oversight).
 */
export async function setCcChatsReviewed(
  chatId: string,
  agentUid: string,
  reviewed: boolean,
  options?: { isCallCenterAdmin?: boolean; allowWorkshopOversight?: boolean }
): Promise<{ chatsReviewed: boolean }> {
  const db = adminDb();
  const ref = db.collection(CC_DIRECT_CHATS).doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("Chat not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const room = snap.data()!;
  if (!options?.isCallCenterAdmin && !options?.allowWorkshopOversight) {
    assertRoomParticipant(room, agentUid);
  }
  const now = FieldValue.serverTimestamp();
  if (reviewed) {
    await ref.update({
      chatsReviewed: true,
      chatsReviewedAt: now,
      chatsReviewedByUid: agentUid,
      updatedAt: now,
    });
  } else {
    await ref.update({
      chatsReviewed: false,
      chatsReviewedAt: FieldValue.delete(),
      chatsReviewedByUid: FieldValue.delete(),
      updatedAt: now,
    });
  }
  return { chatsReviewed: reviewed };
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

function mergeAndSortChatsByLastMessage(rooms: CcChatWithDetails[], lim: number): CcChatWithDetails[] {
  return rooms
    .sort((a, b) => {
      const as = a.lastMessageAt || "";
      const bs = b.lastMessageAt || "";
      return bs.localeCompare(as);
    })
    .slice(0, lim);
}

export async function listCcChatsForTenantUser(tenantUserUid: string, limit: number): Promise<CcChatWithDetails[]> {
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  let rows: ReturnType<typeof serializeCcRoom>[];
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("tenantUserUid", "==", tenantUserUid)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    rows = snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("tenantUserUid", "==", tenantUserUid)
      .get();
    rows = sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }
  return attachDetailsToCcChats(rows, { includeWorkshopUser: false });
}

export async function listCcChatsForAgent(
  agentUid: string,
  limit: number,
  scope: { isCCAdmin: boolean; assignedWorkshopIds: string[] }
): Promise<CcChatWithDetails[]> {
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  const assigned = new Set(scope.assignedWorkshopIds.map((x) => x.trim()).filter((x) => x.length > 0));
  /** Pending queue: CC admins and workshop-scoped agents; if `assignedWorkshops` is empty, treat as full-queue (typical for dedicated agents). */
  const canSeeWorkshop = (ownerUid: string) => {
    const w = ownerUid.trim();
    if (!w) return false;
    if (scope.isCCAdmin) return true;
    if (assigned.size === 0) return true;
    return assigned.has(w);
  };

  let mine: ReturnType<typeof serializeCcRoom>[] = [];
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("agentUid", "==", agentUid)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    mine = snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const snap = await db.collection(CC_DIRECT_CHATS).where("agentUid", "==", agentUid).get();
    mine = sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }

  let pendingRows: ReturnType<typeof serializeCcRoom>[] = [];
  try {
    const ps = await db
      .collection(CC_DIRECT_CHATS)
      .where("queueStatus", "==", "pending")
      .orderBy("lastMessageAt", "desc")
      .limit(100)
      .get();
    pendingRows = ps.docs
      .map((d) => ({ id: d.id, data: d.data()! }))
      .filter((x) => canSeeWorkshop(String(x.data.workshopOwnerUid || "")))
      .map((x) => serializeCcRoom(x.id, x.data));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const ps = await db.collection(CC_DIRECT_CHATS).where("queueStatus", "==", "pending").limit(200).get();
    pendingRows = sortCcRoomsByLastMessageDesc(
      ps.docs.filter((doc) => canSeeWorkshop(String(doc.data()?.workshopOwnerUid || ""))),
      100
    );
  }

  const byId = new Map<string, ReturnType<typeof serializeCcRoom>>();
  for (const r of pendingRows) byId.set(r.chatId, r);
  for (const r of mine) byId.set(r.chatId, r);
  const merged = [...byId.values()];
  merged.sort((a, b) => {
    const as = a.lastMessageAt || "";
    const bs = b.lastMessageAt || "";
    return bs.localeCompare(as);
  });
  const sliced = merged.slice(0, lim);
  return attachDetailsToCcChats(sliced, { includeWorkshopUser: true });
}

/** BMS staff (workshop/branch) or super_admin scoped to a workshop: all 1:1 CC threads for that business. */
export async function listCcChatsForWorkshop(workshopOwnerUid: string, limit: number): Promise<CcChatWithDetails[]> {
  const w = workshopOwnerUid.trim();
  if (!w) return [];
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  let rows: ReturnType<typeof serializeCcRoom>[];
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .where("workshopOwnerUid", "==", w)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    rows = snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const snap = await db.collection(CC_DIRECT_CHATS).where("workshopOwnerUid", "==", w).get();
    rows = sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }
  return attachDetailsToCcChats(rows, { includeWorkshopUser: true });
}

/** Most recent CC threads across all workshops (BMS super admin oversight). */
export async function listCcChatsGlobally(limit: number): Promise<CcChatWithDetails[]> {
  const db = adminDb();
  const lim = Math.min(Math.max(1, limit), 100);
  let rows: ReturnType<typeof serializeCcRoom>[];
  try {
    const snap = await db
      .collection(CC_DIRECT_CHATS)
      .orderBy("lastMessageAt", "desc")
      .limit(lim)
      .get();
    rows = snap.docs.map((d) => serializeCcRoom(d.id, d.data()!));
  } catch (e) {
    if (!isMissingCompositeIndexError(e)) throw e;
    const scanCap = Math.min(1000, Math.max(lim * 30, 200));
    const snap = await db.collection(CC_DIRECT_CHATS).limit(scanCap).get();
    rows = sortCcRoomsByLastMessageDesc(snap.docs, lim);
  }
  return attachDetailsToCcChats(rows, { includeWorkshopUser: true });
}

/**
 * For branch_admin / multiple assigned workshops. Fetches in parallel, merges, sorts by `lastMessageAt`, caps at `lim`.
 */
export async function listCcChatsForWorkshopIds(
  ownerUids: string[],
  limit: number
): Promise<CcChatWithDetails[]> {
  const uids = [...new Set(ownerUids.map((x) => x.trim()).filter((x) => x.length > 0))];
  if (uids.length === 0) return [];
  if (uids.length === 1) {
    return listCcChatsForWorkshop(uids[0]!, limit);
  }
  const per = Math.min(100, Math.max(limit, 20));
  const lists = await Promise.all(uids.map((id) => listCcChatsForWorkshop(id, per)));
  const merged = lists.flat();
  return mergeAndSortChatsByLastMessage(merged, limit);
}
