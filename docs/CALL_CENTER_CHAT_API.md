# Call center direct chat API

Workshop users (owner, branch admin, staff) chat **only** with call center agents in **1:1** threads. Messages are stored in Firestore under `cc_direct_chats/{chatId}` with a `messages` subcollection. The mobile app listens to Firestore for realtime UI; **sending** and **read receipts** should go through these APIs so FCM and validation stay consistent.

## Authentication

Send the Firebase **ID token** of the signed-in user:

```http
Authorization: Bearer <firebase_id_token>
```

- **Workshop app** (owner / branch admin / staff): use routes under `/api/chats/cc/…`.
- **Call center** (agent): use routes under `/api/call-center/chats/…`.

## Firestore shape (read-only from clients)

- `cc_direct_chats/{chatId}` — room metadata (`participantIds`, `tenantUserUid`, `agentUid`, `workshopOwnerUid`, `lastMessageAt`, etc.).
- `cc_direct_chats/{chatId}/messages/{messageId}` — `senderId`, `text`, `createdAt`, `seenByRecipient`, `readAt`.

`chatId` is deterministic: `cc_<sorted(uidPair)>` (see server `buildCcChatId`).

## Workshop (mobile / admin) HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chats/cc/agents` | All active call center agents (no per-workshop assignment required). |
| `GET` | `/api/chats/cc/rooms?limit=50` | List your threads (same as Firestore query on `tenantUserUid`). |
| `POST` | `/api/chats/cc/rooms` | Body: `{ "queue": true }` to open the **shared queue** (no agent pick — first agent to claim in admin / `POST /api/call-center/chats/[chatId]/claim`). Or `{ "agentUid": "…" }` for a **specific** agent (legacy). Response: `{ chat, created }`. |
| `GET` | `/api/chats/cc/rooms/:chatId/messages?limit=40&before=<messageId>` | Page messages (optional cursor `before`). |
| `POST` | `/api/chats/cc/rooms/:chatId/messages` | Body: `{ "text": "…" }`. Sends message + **FCM** to the agent. |
| `POST` | `/api/chats/cc/rooms/:chatId/read` | Mark inbound messages as read (read receipts). |

Allowed roles: `workshop_owner`, `branch_admin`, `staff` (Firebase `users/{uid}`).

## Call center agent HTTP API

CORS is enabled for browser tools (`Access-Control-Allow-Origin: *` on these routes).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/call-center/chats?limit=50` | Your assigned threads **plus** unclaimed **queue** requests (`queueStatus: pending`). **Workshop scope:** if `call_center_agents/{uid}.assignedWorkshops` is **empty**, the agent sees **all** pending queue items; if non-empty, only those whose `workshopOwnerUid` is in the list (CC admins still see all). |
| `POST` | `/api/call-center/chats/:chatId/claim` | Claim a pending queue chat (body empty). You become `agentUid` on the thread. |
| `GET` | `/api/call-center/chats/:chatId` | Room metadata (participant, or pending queue for your workshop scope). |
| `GET` | `/api/call-center/chats/:chatId/messages?limit=40&before=<messageId>` | List messages. |
| `POST` | `/api/call-center/chats/:chatId/messages` | Body: `{ "text": "…" }`. Sends + **FCM** to the workshop user. |
| `POST` | `/api/call-center/chats/:chatId/read` | Mark messages from the tenant user as read. |

## FCM data payload (chat)

When a message is sent via API, the recipient may receive a push with `data` including:

- `type`: `cc_chat_message`
- `chatId`
- `senderUid`
- `senderName`
- `title` / `body` (duplicate of notification for clients that read data only)

## Deploy notes

- Deploy updated **`firestore.rules`** and **`firestore.indexes.json`** (composite indexes on `cc_direct_chats` for `tenantUserUid` / `agentUid` / `queueStatus` + `lastMessageAt`).

## FCM tokens for agents

Push delivery uses `getUserFcmToken`: it checks `users`, `salon_staff`, and **`call_center_agents/{uid}.fcmToken`**. If you ship a mobile or desktop agent client, persist the device token on the agent’s `call_center_agents` document (or mirror into `users/{uid}`).
