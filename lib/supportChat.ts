/**
 * Centralized support chat (1xBet style) — server-side helpers.
 *
 * Domain model
 * ------------
 *  - Each customer (mobile-app user: workshop_owner | branch_admin | staff) has at most
 *    ONE active `conversations/{id}` doc. When the agent closes it, the next message the
 *    customer sends spawns a brand-new doc.
 *  - Status flow: `waiting` → `connected` → `closed`.
 *  - All writes funnel through this module so we can audit + push FCM.
 *
 * Schema lives in `SUPPORT_CHAT_AGENT_API.md` at the repo root.
 */
import { adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { apnsAlertConfig, normalizeFcmData } from "@/lib/fcmIosHelpers";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Message } from "firebase-admin/messaging";

export type SupportChatRole = "owner" | "branch_admin" | "staff";
export type SupportChatStatus = "waiting" | "connected" | "closed";
export type SupportChatSender = "customer" | "agent" | "system";

export interface SupportConversation {
  conversationId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string | null;
  role: SupportChatRole;
  ownerUid: string | null;
  status: SupportChatStatus;
  agentId: string | null;
  agentName: string | null;
  agentEmail: string | null;
  lastMessage: string;
  lastMessageAt: Timestamp | null;
  lastSender: SupportChatSender | null;
  unreadForAgent: number;
  unreadForCustomer: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  claimedAt: Timestamp | null;
  closedAt: Timestamp | null;
  closedBy: "agent" | "system" | null;
}

const CONVERSATIONS = "conversations";
const MESSAGES_SUBCOLLECTION = "messages";
const AGENT_COLLECTION = "call_center_agents";
const USERS_COLLECTION = "users";

const MAX_MESSAGE_LENGTH = 4000;

/** Truncate + clean text we accept from clients. Throws a typed `HttpError` if empty. */
export function sanitizeMessage(raw: unknown): string {
  if (typeof raw !== "string") throw httpError(400, "message must be a string");
  const trimmed = raw.trim();
  if (!trimmed) throw httpError(400, "message cannot be empty");
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw httpError(400, `message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }
  return trimmed;
}

export interface HttpError extends Error {
  status: number;
}
export function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}

/** Normalize an arbitrary user/staff role string into the customer-side enum. */
function normalizeRole(input: unknown): SupportChatRole {
  const r = String(input || "").toLowerCase().trim();
  if (r === "workshop_owner" || r === "owner") return "owner";
  if (r === "branch_admin" || r === "branch-admin") return "branch_admin";
  return "staff";
}

interface CustomerProfile {
  uid: string;
  name: string;
  email: string;
  phone: string | null;
  role: SupportChatRole;
  ownerUid: string | null;
}

/** Resolve a Firebase auth user to a support-chat customer profile (denormalized fields). */
export async function loadCustomerProfile(uid: string): Promise<CustomerProfile> {
  const db = adminDb();
  const snap = await db.collection(USERS_COLLECTION).doc(uid).get();
  if (!snap.exists) {
    throw httpError(404, "User profile not found");
  }
  const d = snap.data() || {};
  if (d.suspended) throw httpError(403, "Account suspended");
  return {
    uid,
    name: String(d.displayName || d.name || "User").trim() || "User",
    email: String(d.email || "").trim(),
    phone: String(d.phone || d.phoneNumber || "").trim() || null,
    role: normalizeRole(d.role || d.systemRole),
    ownerUid: typeof d.ownerUid === "string" && d.ownerUid.trim() ? d.ownerUid.trim() : null,
  };
}

interface AgentProfile {
  uid: string;
  name: string;
  email: string;
  isCallCenterAdmin: boolean;
}

/** Read agent identity for `claim` / `send` audit. Throws if not active. */
export async function loadAgentProfile(uid: string): Promise<AgentProfile> {
  const db = adminDb();
  const snap = await db.collection(AGENT_COLLECTION).doc(uid).get();
  if (!snap.exists) throw httpError(403, "Not a registered call center agent");
  const d = snap.data() || {};
  if (d.suspended) throw httpError(403, "Agent account suspended");
  if (d.ccChatDisabled) throw httpError(403, "Agent chat is disabled");
  const role = String(d.role || "agent").toLowerCase();
  return {
    uid,
    name: String(d.displayName || d.name || "Agent").trim() || "Agent",
    email: String(d.email || "").trim(),
    isCallCenterAdmin: role === "call_center_admin",
  };
}

/** Snapshot of a conversation; null if deleted. */
export async function loadConversation(
  conversationId: string
): Promise<SupportConversation | null> {
  const db = adminDb();
  const snap = await db.collection(CONVERSATIONS).doc(conversationId).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return {
    conversationId,
    userId: String(d.userId || ""),
    userName: String(d.userName || ""),
    userEmail: String(d.userEmail || ""),
    userPhone: d.userPhone ?? null,
    role: normalizeRole(d.role),
    ownerUid: d.ownerUid ?? null,
    status: (d.status as SupportChatStatus) || "waiting",
    agentId: d.agentId ?? null,
    agentName: d.agentName ?? null,
    agentEmail: d.agentEmail ?? null,
    lastMessage: String(d.lastMessage || ""),
    lastMessageAt: d.lastMessageAt instanceof Timestamp ? d.lastMessageAt : null,
    lastSender: (d.lastSender as SupportChatSender) ?? null,
    unreadForAgent: typeof d.unreadForAgent === "number" ? d.unreadForAgent : 0,
    unreadForCustomer: typeof d.unreadForCustomer === "number" ? d.unreadForCustomer : 0,
    createdAt: d.createdAt instanceof Timestamp ? d.createdAt : null,
    updatedAt: d.updatedAt instanceof Timestamp ? d.updatedAt : null,
    claimedAt: d.claimedAt instanceof Timestamp ? d.claimedAt : null,
    closedAt: d.closedAt instanceof Timestamp ? d.closedAt : null,
    closedBy: (d.closedBy as "agent" | "system") ?? null,
  };
}

/** Most recent conversation for `userId`, or null. Used to decide create-vs-append on customer send. */
export async function findLatestConversationForUser(
  userId: string
): Promise<SupportConversation | null> {
  const db = adminDb();
  const snap = await db
    .collection(CONVERSATIONS)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;
  return loadConversation(snap.docs[0].id);
}

/* ─── Mutations ───────────────────────────────────────────────────────── */

/**
 * Customer sends a message. Either appends to the active conversation, or creates a fresh one
 * if none exists / the latest is `closed`. Returns the conversation id + message id.
 *
 * Push fan-out to ALL active agents happens after the write, in the background.
 */
export async function customerSendMessage(args: {
  customer: CustomerProfile;
  text: string;
}): Promise<{ conversationId: string; messageId: string; created: boolean }> {
  const db = adminDb();
  const { customer, text } = args;

  const latest = await findLatestConversationForUser(customer.uid);
  const reuse = latest && latest.status !== "closed";

  let conversationId: string;
  let created = false;

  if (reuse) {
    conversationId = latest!.conversationId;
  } else {
    const ref = db.collection(CONVERSATIONS).doc();
    conversationId = ref.id;
    created = true;
    await ref.set({
      conversationId,
      userId: customer.uid,
      userName: customer.name,
      userEmail: customer.email,
      userPhone: customer.phone,
      role: customer.role,
      ownerUid: customer.ownerUid,
      status: "waiting" as SupportChatStatus,
      agentId: null,
      agentName: null,
      agentEmail: null,
      lastMessage: text.slice(0, 200),
      lastMessageAt: FieldValue.serverTimestamp(),
      lastSender: "customer" as SupportChatSender,
      unreadForAgent: 1,
      unreadForCustomer: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      claimedAt: null,
      closedAt: null,
      closedBy: null,
    });
  }

  const messagesRef = db
    .collection(CONVERSATIONS)
    .doc(conversationId)
    .collection(MESSAGES_SUBCOLLECTION);

  const messageRef = messagesRef.doc();
  await messageRef.set({
    sender: "customer" as SupportChatSender,
    senderId: customer.uid,
    senderName: customer.name,
    message: text,
    timestamp: FieldValue.serverTimestamp(),
    readByAgent: false,
    readByCustomer: true,
  });

  if (!created) {
    await db
      .collection(CONVERSATIONS)
      .doc(conversationId)
      .update({
        lastMessage: text.slice(0, 200),
        lastMessageAt: FieldValue.serverTimestamp(),
        lastSender: "customer",
        unreadForAgent: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
  }

  // Background push fan-out — don't block the response.
  void notifyAgentsAfterCustomerMessage({
    conversationId,
    customerName: customer.name,
    role: customer.role,
    text,
    created,
    assignedAgentId: reuse ? latest!.agentId : null,
  }).catch((e) => console.error("[supportChat] notifyAgentsAfterCustomerMessage:", e));

  return { conversationId, messageId: messageRef.id, created };
}

/**
 * Agent claims a `waiting` conversation. Atomic — the second agent to call this gets 409.
 * Side effect: writes a system message and pushes the customer.
 */
export async function agentClaimConversation(args: {
  agent: AgentProfile;
  conversationId: string;
}): Promise<SupportConversation> {
  const db = adminDb();
  const ref = db.collection(CONVERSATIONS).doc(args.conversationId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Conversation not found");
    const d = snap.data() || {};
    const status = (d.status as SupportChatStatus) || "waiting";
    if (status === "closed") {
      throw httpError(409, "Conversation is already closed");
    }
    if (status === "connected" && d.agentId && d.agentId !== args.agent.uid) {
      throw httpError(409, "Conversation has already been claimed by another agent");
    }
    tx.update(ref, {
      status: "connected" as SupportChatStatus,
      agentId: args.agent.uid,
      agentName: args.agent.name,
      agentEmail: args.agent.email,
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await appendSystemMessage(
    args.conversationId,
    `You are connected with ${args.agent.name}`,
  );

  await db
    .collection(AGENT_COLLECTION)
    .doc(args.agent.uid)
    .set(
      {
        activeChatCount: FieldValue.increment(1),
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  const fresh = await loadConversation(args.conversationId);
  if (!fresh) throw httpError(500, "Conversation disappeared after claim");

  void pushToCustomer(fresh.userId, {
    title: "Support",
    body: `You are now connected with ${args.agent.name}`,
    data: {
      type: "support_chat",
      event: "claimed",
      conversationId: args.conversationId,
      agentName: args.agent.name,
    },
  }).catch((e) => console.error("[supportChat] pushToCustomer (claim):", e));

  return fresh;
}

/** Agent sends a message into a conversation they own. */
export async function agentSendMessage(args: {
  agent: AgentProfile;
  conversationId: string;
  text: string;
}): Promise<{ messageId: string }> {
  const db = adminDb();
  const convo = await loadConversation(args.conversationId);
  if (!convo) throw httpError(404, "Conversation not found");
  if (convo.status === "closed") throw httpError(409, "Conversation is closed");
  if (convo.agentId !== args.agent.uid) {
    throw httpError(403, "You are not the assigned agent for this conversation");
  }

  const ref = db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .doc();

  await ref.set({
    sender: "agent" as SupportChatSender,
    senderId: args.agent.uid,
    senderName: args.agent.name,
    message: args.text,
    timestamp: FieldValue.serverTimestamp(),
    readByAgent: true,
    readByCustomer: false,
  });

  await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .update({
      lastMessage: args.text.slice(0, 200),
      lastMessageAt: FieldValue.serverTimestamp(),
      lastSender: "agent",
      unreadForCustomer: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

  void pushToCustomer(convo.userId, {
    title: `${args.agent.name} (Support)`,
    body: args.text.slice(0, 80),
    data: {
      type: "support_chat",
      event: "message",
      conversationId: args.conversationId,
      agentName: args.agent.name,
    },
  }).catch((e) => console.error("[supportChat] pushToCustomer (message):", e));

  return { messageId: ref.id };
}

/**
 * Agent closes the conversation. Sends the farewell + a system "Chat ended" message,
 * marks status=closed and decrements agent activeChatCount.
 */
export async function agentCloseConversation(args: {
  agent: AgentProfile;
  conversationId: string;
  farewellMessage?: string;
}): Promise<SupportConversation> {
  const db = adminDb();
  const convo = await loadConversation(args.conversationId);
  if (!convo) throw httpError(404, "Conversation not found");
  if (convo.status === "closed") return convo;
  if (convo.agentId && convo.agentId !== args.agent.uid && !args.agent.isCallCenterAdmin) {
    throw httpError(403, "You are not the assigned agent for this conversation");
  }

  const farewell = (args.farewellMessage || "").trim() || "Thank you for contacting support";

  const farewellRef = db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .doc();
  await farewellRef.set({
    sender: "agent" as SupportChatSender,
    senderId: args.agent.uid,
    senderName: args.agent.name,
    message: farewell,
    timestamp: FieldValue.serverTimestamp(),
    readByAgent: true,
    readByCustomer: false,
  });

  await appendSystemMessage(args.conversationId, "Chat ended");

  await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .update({
      status: "closed" as SupportChatStatus,
      lastMessage: farewell.slice(0, 200),
      lastMessageAt: FieldValue.serverTimestamp(),
      lastSender: "agent",
      unreadForCustomer: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      closedAt: FieldValue.serverTimestamp(),
      closedBy: "agent",
    });

  if (convo.agentId) {
    await db
      .collection(AGENT_COLLECTION)
      .doc(convo.agentId)
      .set(
        {
          activeChatCount: FieldValue.increment(-1),
        },
        { merge: true },
      );
  }

  void pushToCustomer(convo.userId, {
    title: "Support",
    body: "Chat ended",
    data: {
      type: "support_chat",
      event: "closed",
      conversationId: args.conversationId,
    },
  }).catch((e) => console.error("[supportChat] pushToCustomer (closed):", e));

  return (await loadConversation(args.conversationId))!;
}

/** Agent transfers to another agent. Requires `call_center_admin`. */
export async function agentTransferConversation(args: {
  caller: AgentProfile;
  conversationId: string;
  toAgentUid: string;
}): Promise<SupportConversation> {
  if (!args.caller.isCallCenterAdmin) {
    throw httpError(403, "Only call center admins can transfer chats");
  }
  const db = adminDb();
  const target = await loadAgentProfile(args.toAgentUid);
  const ref = db.collection(CONVERSATIONS).doc(args.conversationId);

  let previousAgentId: string | null = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Conversation not found");
    const d = snap.data() || {};
    if ((d.status as SupportChatStatus) === "closed") {
      throw httpError(409, "Cannot transfer a closed conversation");
    }
    previousAgentId = d.agentId ?? null;
    tx.update(ref, {
      status: "connected" as SupportChatStatus,
      agentId: target.uid,
      agentName: target.name,
      agentEmail: target.email,
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await appendSystemMessage(
    args.conversationId,
    `Chat transferred to ${target.name}`,
  );

  if (previousAgentId && previousAgentId !== target.uid) {
    await db
      .collection(AGENT_COLLECTION)
      .doc(previousAgentId)
      .set({ activeChatCount: FieldValue.increment(-1) }, { merge: true });
  }
  await db
    .collection(AGENT_COLLECTION)
    .doc(target.uid)
    .set(
      {
        activeChatCount: FieldValue.increment(previousAgentId === target.uid ? 0 : 1),
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return (await loadConversation(args.conversationId))!;
}

/** Reset `unreadForAgent` and stamp `readByAgent` on every customer message older than now. */
export async function markReadByAgent(args: {
  agent: AgentProfile;
  conversationId: string;
}): Promise<void> {
  const db = adminDb();
  const convo = await loadConversation(args.conversationId);
  if (!convo) throw httpError(404, "Conversation not found");
  if (convo.agentId && convo.agentId !== args.agent.uid && !args.agent.isCallCenterAdmin) {
    throw httpError(403, "Not your conversation");
  }
  await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .update({ unreadForAgent: 0, updatedAt: FieldValue.serverTimestamp() });

  const unread = await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .where("sender", "==", "customer")
    .where("readByAgent", "==", false)
    .limit(200)
    .get();
  if (!unread.empty) {
    const batch = db.batch();
    unread.docs.forEach((doc) => batch.update(doc.ref, { readByAgent: true }));
    await batch.commit();
  }
}

/** Reset `unreadForCustomer` and mark agent messages read. Called by the mobile app. */
export async function markReadByCustomer(args: {
  customer: CustomerProfile;
  conversationId: string;
}): Promise<void> {
  const db = adminDb();
  const convo = await loadConversation(args.conversationId);
  if (!convo) throw httpError(404, "Conversation not found");
  if (convo.userId !== args.customer.uid) throw httpError(403, "Not your conversation");

  await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .update({ unreadForCustomer: 0, updatedAt: FieldValue.serverTimestamp() });

  const unread = await db
    .collection(CONVERSATIONS)
    .doc(args.conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .where("sender", "in", ["agent", "system"])
    .where("readByCustomer", "==", false)
    .limit(200)
    .get();
  if (!unread.empty) {
    const batch = db.batch();
    unread.docs.forEach((doc) => batch.update(doc.ref, { readByCustomer: true }));
    await batch.commit();
  }
}

/** Toggle agent presence (called by the agent dashboard). */
export async function setAgentPresence(args: {
  agentUid: string;
  online: boolean;
}): Promise<void> {
  const db = adminDb();
  await db
    .collection(AGENT_COLLECTION)
    .doc(args.agentUid)
    .set(
      {
        online: args.online,
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/** Register / replace an FCM token on the agent doc. */
export async function registerAgentFcmToken(args: {
  agentUid: string;
  token: string;
  platform: string;
}): Promise<void> {
  if (!args.token.trim()) throw httpError(400, "token required");
  const db = adminDb();
  await db
    .collection(AGENT_COLLECTION)
    .doc(args.agentUid)
    .set(
      {
        fcmTokens: FieldValue.arrayUnion(args.token.trim()),
        fcmPlatform: args.platform || "web",
        lastSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/* ─── Internals ───────────────────────────────────────────────────────── */

async function appendSystemMessage(conversationId: string, text: string): Promise<void> {
  const db = adminDb();
  await db
    .collection(CONVERSATIONS)
    .doc(conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .add({
      sender: "system" as SupportChatSender,
      senderId: "system",
      senderName: "System",
      message: text,
      timestamp: FieldValue.serverTimestamp(),
      readByAgent: true,
      readByCustomer: false,
    });
}

interface PushArgs {
  title: string;
  body: string;
  data?: Record<string, string>;
}

async function pushToCustomer(userId: string, push: PushArgs): Promise<void> {
  const tokens = await collectUserFcmTokens(userId);
  if (tokens.length === 0) return;
  await sendPushFanout(tokens, push);
}

async function notifyAgentsAfterCustomerMessage(args: {
  conversationId: string;
  customerName: string;
  role: SupportChatRole;
  text: string;
  created: boolean;
  assignedAgentId: string | null;
}): Promise<void> {
  const db = adminDb();
  let tokens: string[] = [];

  if (args.assignedAgentId) {
    tokens = await collectAgentFcmTokens(args.assignedAgentId);
  } else {
    const snap = await db
      .collection(AGENT_COLLECTION)
      .where("online", "==", true)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (d.suspended || d.ccChatDisabled) continue;
      tokens.push(...extractFcmTokens(d));
    }
  }
  tokens = unique(tokens);
  if (tokens.length === 0) return;

  const title = args.created
    ? `New chat (${prettyRole(args.role)})`
    : args.customerName || "Customer";
  const body = args.created
    ? `${args.customerName}: ${args.text.slice(0, 60)}`
    : args.text.slice(0, 80);

  await sendPushFanout(tokens, {
    title,
    body,
    data: {
      type: "support_chat_agent",
      event: args.created ? "queue_added" : "message",
      conversationId: args.conversationId,
    },
  });
}

function prettyRole(r: SupportChatRole): string {
  if (r === "owner") return "Owner";
  if (r === "branch_admin") return "Branch admin";
  return "Staff";
}

function extractFcmTokens(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fcmTokens = doc.fcmTokens;
  if (Array.isArray(fcmTokens)) {
    for (const t of fcmTokens) {
      if (typeof t === "string" && t.trim()) out.push(t.trim());
    }
  }
  const single = doc.fcmToken;
  if (typeof single === "string" && single.trim()) out.push(single.trim());
  return out;
}

async function collectUserFcmTokens(uid: string): Promise<string[]> {
  const db = adminDb();
  const out: string[] = [];
  const userDoc = await db.collection(USERS_COLLECTION).doc(uid).get();
  if (userDoc.exists) out.push(...extractFcmTokens(userDoc.data() || {}));
  // Mobile app also writes to salon_staff for staff users.
  const staffDoc = await db.collection("salon_staff").doc(uid).get();
  if (staffDoc.exists) out.push(...extractFcmTokens(staffDoc.data() || {}));
  return unique(out);
}

async function collectAgentFcmTokens(uid: string): Promise<string[]> {
  const db = adminDb();
  const snap = await db.collection(AGENT_COLLECTION).doc(uid).get();
  if (!snap.exists) return [];
  return unique(extractFcmTokens(snap.data() || {}));
}

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((x) => x && x.length > 0)));
}

async function sendPushFanout(tokens: string[], push: PushArgs): Promise<void> {
  const messaging = adminMessaging();
  await Promise.all(
    tokens.map(async (token) => {
      const message: Message = {
        token,
        notification: { title: push.title, body: push.body },
        data: normalizeFcmData({ ...(push.data || {}), title: push.title, body: push.body }),
        android: {
          priority: "high",
          ttl: 86400000,
          notification: {
            sound: "default",
            channelId: "appointments",
            priority: "high",
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: apnsAlertConfig(push.title, push.body),
      };
      try {
        await messaging.send(message);
      } catch (e) {
        // Don't blow up on a single bad token; logged for triage only.
        console.warn("[supportChat] FCM send failed:", (e as Error).message);
      }
    }),
  );
}
