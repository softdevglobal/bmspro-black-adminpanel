# Call Center API — BMS Pro Black

**Base URL:** `https://black.bmspros.com.au/api/call-center`  
**Format:** JSON (`Content-Type: application/json`)

**Auth (most routes):** `Authorization: Bearer <Firebase ID token>`  
Agents are Firebase users with a matching Firestore doc: `call_center_agents/{uid}`.

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
3. `GET /workshops/{ownerUid}` — branches, `serviceId`s, staff  
4. `GET /customers?q=...&searchBy=phone` (+ tenant) — screen pop search  
5. `GET /customers/{customerId}` — profile, vehicles, booking list  
6. `GET /bookings/availability?branchId=&date=&serviceIds=` — slots before booking  
7. `POST /bookings` — create job in BMS  
8. `GET /bookings/{id}` — status / tasks / progress  
9. `GET /bookings/{id}/additional-issues` → `PATCH .../additional-issues/{issueId}` — extra work after customer agrees on phone  
10. `POST /call-logs` — optional audit in BMS; use `callCenterCallId` to tie to your system  

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
| GET | `/workshops/{ownerUid}` | Branches, services, staff. |
| GET | `/customers` | Query: `q` (required), `searchBy` optional (`phone` \| `email` \| `name`). Tenant required. |
| POST | `/customers` | Body: `ownerUid`, `name`, optional `email`, `phone`, `vehicleNumber`, `vehicleDetails`, `notes`. |
| GET | `/customers/{customerId}` | Tenant required. |
| GET | `/customers/{customerId}/vehicles` | Query: `ownerUid`. |
| POST | `/customers/{customerId}/vehicles` | Body: `ownerUid`, `rego`, optional vehicle fields. |
| GET | `/bookings` | Tenant + optional `status`, `date`, `branchId`, `customerId`, `limit`. |
| GET | `/bookings/availability` | Query: `branchId`, `date` (YYYY-MM-DD), `serviceIds` (comma-separated). Tenant. |
| POST | `/bookings` | Body: `ownerUid`, `branchId`, `date`, `time`, `services[]` (`serviceId` required per line), `client`, optional `pickupTime`, `clientEmail`, `clientPhone`, `customerId`, `vehicleNumber`, `vehicleDetails`, `notes`. |
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
