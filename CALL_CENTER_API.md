# Call Center API — BMS Pro Black

**Base URL:** `https://black.bmspros.com.au/api/call-center`  
**Format:** JSON (`Content-Type: application/json`)

**Auth (most routes):** `Authorization: Bearer <Firebase ID token>`  
Agents are Firebase users with a matching Firestore doc: `call_center_agents/{uid}`.

**Production (`https://black.bmspros.com.au`):** the ID token must be sent in the **`Authorization`** header.  
`?access_token=` / `?token=` on the URL **do not work** in production (they are only for local `NODE_ENV=development` debugging). If your UI shows “sign in required” or “workshop API”, it usually means **no valid Bearer token** was sent, or the token is from the **wrong Firebase project**, or the user is not in `call_center_agents`.

**Tenant:** Workshop = `ownerUid` (workshop owner’s Firebase UID). Send as `?ownerUid=...` or header `X-Tenant-Id: <ownerUid>`.

**Machine-readable spec (no login):** `GET /api/call-center/public/request-data`  
**Health:** `GET /api/call-center/public/health`

---

## What BMS provides vs dashboard

| BMS provides | Dashboard implements |
|--------------|----------------------|
| Firebase web config (same project as BMS) | Firebase Auth: email/password → `getIdToken()` |
| Test agent email/password | Store token; attach Bearer on API calls |
| `ownerUid` per workshop | Pass tenant on each scoped request |
| `did_mappings` (optional) or branch phones | DID lookup for screen context |

Bookings and customers created via this API are stored in **BMS Firestore** (admin panel + mobile app). Your own DB (e.g. Supabase) is optional for local UI/call metadata; link rows with `bookingId`, `customerId`, `ownerUid`, `callCenterCallId` on `POST /call-logs`.

---

## Login (example)

```js
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const app = initializeApp(firebaseConfig); // from BMS
const auth = getAuth(app);
const { user } = await signInWithEmailAndPassword(auth, email, password);
const token = await user.getIdToken();
// fetch(baseUrl + "/auth", { headers: { Authorization: `Bearer ${token}` } })
```

---

## Typical sequence

1. `GET /auth` — confirm agent + workshops  
2. `GET /did-lookup?did=...` — map inbound number → `ownerUid` / branch (if configured)  
3. `GET /workshops/{ownerUid}` — branches (each includes weekly `hours`, `bookingLimitPerDay`), services, staff  
3b. `GET /branches?ownerUid=<workshopOwnerUid>` — **all branches** for that owner (array of full branch objects: `hours`, **`daySchedules`**, `bookingLimitPerDay`, …). Optional `?date=YYYY-MM-DD`. **Agents:** any owner; **BMS staff:** must have access to that workshop.  
3c. `GET /branches/{branchId}` — single branch (same fields as each row above). **Call center agents:** any branch (`X-Tenant-Id` optional / ignored). **BMS staff:** scoped to their workshop; optional tenant must match branch. Optional `?date=YYYY-MM-DD` for **`daySchedule`**.  
4. `GET /services?branchId=` (+ tenant) — **list services for the selected branch** (price, duration, available staff per service)  
5. `GET /services/checklists` (+ tenant) — **all checklist/todo lines** across services (scripts / explaining work to customers)  
6. `GET /services/{serviceId}` — **full service detail** (checklist, branches, staff) — optional, for drill-down  
7. `GET /customers?q=...&searchBy=phone` (+ tenant) — screen pop search  
8. `GET /customers/{customerId}` — profile, vehicles, booking list  
9. `GET /bookings/availability?branchId=&date=&serviceIds=` — slots before booking; response includes **`branch`** (`hours`, **`daySchedules`**, `bookingLimitPerDay`, and `daySchedule` for the requested `date`) alongside `branchHours`, `dailyLimit`, and slot arrays  
10. `POST /bookings` — create job in BMS (use `serviceId`s from step 4)  
11. `GET /bookings/{id}` — status / tasks / progress  
12. `GET /bookings/{id}/additional-issues` → `PATCH .../additional-issues/{issueId}` — extra work after customer agrees on phone  
13. `POST /call-logs` — optional audit in BMS; use `callCenterCallId` to tie to your system  

---

## Endpoints

Paths are relative to the base URL above.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/public/request-data` | No auth. Full contract JSON. |
| GET | `/public/health` | No auth. |
| GET | `/auth` | Current agent + `assignedWorkshops`. |
| POST | `/auth` | Create agent. **BMS admin** Bearer only. Body: `email`, `password`, `name`, `role`, `assignedWorkshops[]`. |
| PATCH | `/auth` | Update agent. **BMS admin** Bearer. Body: `agentUid`, optional `assignedWorkshops`, `suspended`, `role`, `name`. |
| GET | `/did-lookup?did=` | Map DID → workshop. |
| POST | `/did-lookup` | **CC admin.** Body: `did`, `ownerUid`, optional `branchId`, `branchName`, `label`. |
| GET | `/workshops` | Workshops the agent can access. |
| GET | `/workshops/{ownerUid}` | Branches (with `hours`, `bookingLimitPerDay`), services, staff. |
| GET | `/branches` | Query: `ownerUid` or `X-Tenant-Id` (required). All branches for that workshop owner. Optional `date`. |
| GET | `/branches/{branchId}` | **Agents:** any branch. **BMS staff:** tenant must match branch if sent. `daySchedules` + optional `date`. |
| GET | `/customers` | Query: `q` (required), `searchBy` optional (`phone` \| `email` \| `name`). Tenant required. |
| POST | `/customers` | Body: `ownerUid`, `name`, optional `email`, `phone`, `vehicleNumber`, `vehicleDetails`, `notes`. |
| GET | `/customers/{customerId}` | Tenant required. |
| GET | `/customers/{customerId}/vehicles` | `ownerUid` / `X-Tenant-Id` optional (inferred from customer). |
| POST | `/customers/{customerId}/vehicles` | Body: **`rego`** or **`registrationNumber`** or **`vehicleNumber`**; optional make, model, year, colour, bodyType, engineNumber, vin, vinChassis, mileage, notes, or nested **`vehicleDetails`**. Returns **`vehicle`** (full object). `ownerUid` optional. |
| GET | `/services` | **Tenant required.** Optional `branchId`. Each service includes **`checklist[]`** (todo template: `index`, `name`, `description`, …) and `checklistCount`. Add **`summary=1`** to omit `checklist[]` (count only). Or `GET /services/checklists` for a flat `todos` list. |
| GET | `/services/{serviceId}` | Full service detail: `checklist[]` items, `branches[]` (with names), `staff[]`. |
| GET | `/services/checklists` | **Tenant required.** All services’ checklist/todo template items: flat `todos[]` (each row has `serviceId`, `serviceName`, `index`, `name`, `description`) plus grouped `services[]`. Optional `branchId`. |
| GET | `/bookings` | Tenant + optional `status`, `date`, `branchId`, `customerId`, `limit`. |
| GET | `/bookings/availability` | Query: `branchId`, `date` (YYYY-MM-DD), `serviceIds` (comma-separated). Tenant. |
| POST | `/bookings` | Body: `ownerUid`, `branchId`, `date`, `time`, `services[]`, `client`, optional `pickupTime`, `clientEmail`, `clientPhone`, `customerId`, `vehicleNumber`, **`vehicleDetails`** (same as book-now: make, model, year, registrationNumber/rego, mileage, bodyType, colour, vin / vinChassis, engineNumber, notes). Vehicle notes are merged with `notes`. |
| GET | `/bookings/{id}` | Job card: services, tasks, issues, progress. |
| GET | `/bookings/{id}/additional-issues` | Extra work list + summary. |
| PATCH | `/bookings/{id}/additional-issues/{issueId}` | Body: `{ "customerResponse": "accept" \| "reject" }` (issue must be `approved` with price). |
| POST | `/call-logs` | Body: `ownerUid`, `callerPhone`, `direction` (`inbound` \| `outbound`), `purpose`, optional `branchId`, `customerId`, `bookingId`, `duration`, `notes`, `outcome`, `callCenterCallId`. |
| GET | `/call-logs` | Query: `ownerUid`, optional `customerId`, `bookingId`, `limit`. |
| GET | `/webhooks` | **CC admin.** |
| POST | `/webhooks` | **CC admin.** Body: `url` (https), `events[]`, optional `secret`, `description`. |
| DELETE | `/webhooks?id=` | **CC admin.** |

---

## Booking status (values)

`Pending` · `AwaitingStaffApproval` · `PartiallyApproved` · `StaffRejected` · `Confirmed` · `Completed` · `Canceled`

---

## Roles

- `call_center_agent` — scoped to `assignedWorkshops`  
- `call_center_admin` — all workshops; DID mapping; webhooks  

Agents cannot change core booking workflow status via these routes; they create bookings and record customer decisions on priced extra work.

---

## Webhooks

`POST /webhooks` registers URLs and events (`booking.status_changed`, `booking.additional_issue`, `booking.issue_priced`, `booking.completed`, `booking.canceled`). **Confirm with BMS** whether server-side delivery to your URL is enabled in production.

---

## Errors

```json
{ "error": "message" }
```

| Code | Typical cause |
|------|----------------|
| 400 | Bad/missing params |
| 401 | Missing/invalid token |
| 403 | Not allowed for tenant/role |
| 404 | Not found |
| 409 | Duplicate customer, etc. |

CORS: responses allow cross-origin calls from your dashboard origin.

---

## Postman

Import: `postman/BMS_Call_Center_API.postman_collection.json` (folder **0. Public** needs no token).

---

## Firestore (reference)

Used by the API: `call_center_agents`, `did_mappings`, `cc_webhooks`, `call_logs`, plus existing `users`, `branches`, `services`, `customers`, `bookings`, `bookingActivities`, `notifications`.

---

# Mobile VoIP API — Yeastar Linkus SDK

These endpoints are used by the **BMS Pro Black mobile app** (Flutter) to log into the Yeastar Linkus SDK after Firebase Auth. They are **not** part of the public call-center API.

**Base URL:** `https://black.bmspros.com.au`
**Auth:** `Authorization: Bearer <Firebase ID token>` on every request. The token must belong to a `users/{uid}` whose `role` is `staff`, `workshop_owner`, or `branch_admin`, and that user must not be suspended.

**Why these exist:** Yeastar OpenAPI `AccessID` / `AccessKey` must NEVER ship in the mobile binary. The mobile app calls these three routes; the server alone holds the credentials and signs each request fresh.

## Login flow (mobile)

```
Firebase signInWithEmailAndPassword
        │
        ▼
GET /api/user-extension?email=…       (Bearer)
        ▼
GET /api/yeastar/sign?extension=…     (Bearer)   ← fresh sign every call
        ▼
Linkus SDK login(extension, sign, host=…ras.yeastar.com, port=443)
        ▼
POST /api/yeastar/register-push       (Bearer)   ← FCM (Android) / APNs (iOS)
```

## `GET /api/user-extension?email=<email>`

Returns the PBX extension assigned to the authenticated user. Reads `users/{uid}.yeastarExtension` (admin-managed field).

The `email` query parameter must equal the email on the Bearer token (we don't allow cross-user lookup).

```
200  { "extension": "1001", "email": "alice@example.com" }
400  email missing/invalid
401  missing/invalid Bearer
403  asked for someone else's email
404  { "error": "extension_not_assigned" }   ← admin hasn't set the field
```

## `GET /api/yeastar/sign?extension=<ext>`

Generates a **fresh** Linkus SDK login signature via Yeastar OpenAPI `sign/create`. The caller's `users/{uid}.yeastarExtension` must equal `extension`.

```
200  { "sign": "…", "host": "bmsproslynbrook.ras.yeastar.com", "port": 443 }
401  missing/invalid Bearer
403  extension does not belong to caller
404  extension_not_assigned
429  rate_limited                    (5/min per user)
502  upstream Yeastar OpenAPI error  (errcode + hint included)
503  yeastar_not_configured
```

The mobile bridge passes `host` to `remoteIp` (and leaves `localeIp` empty for cloud RAS) and `port` to `remotePort` when calling the Linkus SDK login.

A legacy `POST /api/yeastar/linkus-sign` endpoint accepts `{ email | extension | username }` in the body and returns the same data shaped as `{ sign, linkusRemoteIp, linkusLocaleIp, linkusRemotePort, linkusLocalePort }`. **`GET /api/yeastar/linkus-sign?extension=…`** is an alias of `GET /api/yeastar/sign` for clients that hard-coded the older path. New clients should prefer `/api/yeastar/sign`.

## `POST /api/yeastar/register-push`

Registers (or clears) a mobile push token with the PBX so it can wake the device for incoming calls when the SDK socket is dropped (background, screen off, doze).

```jsonc
{
  "extension": "1001",
  "deviceToken": "<fcm or apns hex>",   // empty string clears the registration
  "platform": "android" | "ios",
  "type":     "fcm" | "apns"
}
```

```
200  { "success": true, "cleared": false }
401  missing/invalid Bearer
403  extension does not belong to caller
502  upstream Yeastar OpenAPI error
```

The server proxies to Yeastar OpenAPI `POST /openapi/v1.0/push/set` (with fallback to the legacy `extension/set_push` path for older firmware) and mirrors the registration to `users/{uid}.yeastarPush` for audit.

## Firestore fields used

| Path | Purpose |
|------|---------|
| `users/{uid}.yeastarExtension` | PBX extension number (string). Set by admin. |
| `users/{uid}.yeastarPush` | `{ token, platform, type, updatedAt }` — server-mirrored push registration |

## Required env (`.env.local` / Vercel)

```
YEASTAR_PBX_BASE_URL=https://bmsproslynbrook.ras.yeastar.com
YEASTAR_PBX_ACCESS_ID=…
YEASTAR_PBX_ACCESS_KEY=…
YEASTAR_LINKUS_HOST=bmsproslynbrook.ras.yeastar.com
YEASTAR_LINKUS_PORT=443
```

