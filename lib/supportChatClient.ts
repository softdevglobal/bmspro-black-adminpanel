import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type SupportChatMsgRow = {
  id: string;
  sender: string;
  senderName: string;
  message: string;
  timestamp: Timestamp | null;
};

export type LatestConversationRow = {
  id: string;
  status: string;
  agentName: string;
  unreadForCustomer: number;
};

export function subscribeLatestConversation(
  uid: string,
  onData: (row: LatestConversationRow | null) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "conversations"),
    where("userId", "==", uid),
    orderBy("createdAt", "desc"),
    limit(1),
  );
  return onSnapshot(
    q,
    (snap) => {
      if (snap.empty) {
        onData(null);
        return;
      }
      const d = snap.docs[0];
      const data = d.data();
      onData({
        id: d.id,
        status: String(data.status ?? "waiting"),
        agentName: String(data.agentName ?? ""),
        unreadForCustomer:
          typeof data.unreadForCustomer === "number" ? data.unreadForCustomer : 0,
      });
    },
    (err) => onError?.(err),
  );
}

export function subscribeMessages(
  conversationId: string,
  onData: (rows: SupportChatMsgRow[]) => void,
  onError?: (e: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, "conversations", conversationId, "messages"),
    orderBy("timestamp", "asc"),
    limit(500),
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows: SupportChatMsgRow[] = snap.docs.map((docSnap) => {
        const m = docSnap.data();
        const ts = m.timestamp;
        return {
          id: docSnap.id,
          sender: String(m.sender ?? "agent"),
          senderName: String(m.senderName ?? ""),
          message: String(m.message ?? ""),
          timestamp: ts instanceof Timestamp ? ts : null,
        };
      });
      onData(rows);
    },
    (err) => onError?.(err),
  );
}

export async function sendCustomerSupportMessage(message: string): Promise<{
  conversationId: string;
  messageId: string;
  created: boolean;
}> {
  const user = auth.currentUser;
  if (!user) throw new Error("You need to be signed in to chat.");
  const token = await user.getIdToken();
  const res = await fetch("/api/support-chat/customer/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : `Could not send (${res.status})`,
    );
  }
  return {
    conversationId: body.conversationId as string,
    messageId: body.messageId as string,
    created: Boolean(body.created),
  };
}

export async function markCustomerConversationRead(conversationId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const token = await user.getIdToken();
  await fetch(
    `/api/support-chat/customer/conversations/${encodeURIComponent(conversationId)}/read`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}
