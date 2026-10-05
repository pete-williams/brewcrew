# BrewCrew Platform - API Documentation

This document provides a comprehensive technical reference for all backend Cloud Functions and API endpoints in the BrewCrew Volunteer Management Platform.

---

## Table of Contents

- [Overview & Architecture](#overview--architecture)
- [Authentication & Role-Based Access Control (RBAC)](#authentication--role-based-access-control-rbac)
- [Error Handling & Status Codes](#error-handling--status-codes)
- [Callable Functions Reference](#callable-functions-reference)
  - [1. `claimShift`](#1-claimshift)
  - [2. `cancelShift`](#2-cancelshift)
  - [3. `createShift`](#3-createshift)
  - [4. `updateShift`](#4-updateshift)
  - [5. `assignShiftManager`](#5-assignshiftmanager)
  - [6. `updateUserRole`](#6-updateuserrole)
  - [7. `sendAdminBroadcast`](#7-sendadminbroadcast)
  - [8. `deleteFestivalSession`](#8-deletefestivalsession)
  - [9. `getShiftCategories`](#9-getshiftcategories)
  - [10. `setUserDisabledStatus`](#10-setuserdisabledstatus)
  - [11. `deleteAndBlockUser`](#11-deleteandblockuser)
  - [12. `unblockUserEmail`](#12-unblockuseremail)
  - [13. `sendWhatsAppBroadcast`](#13-sendwhatsappbroadcast)
  - [14. `createGroup`](#14-creategroup)
  - [15. `updateGroup`](#15-updategroup)
  - [16. `mergeGroups`](#16-mergegroups)
  - [17. `deleteGroup`](#17-deletegroup)
  - [18. `setUserGroup`](#18-setusergroup)
- [HTTP Webhook Endpoints](#http-webhook-endpoints)
  - [1. `twilioWhatsAppWebhook`](#1-twiliowhatsappwebhook)
- [Firestore Background Triggers](#firestore-background-triggers)
  - [1. `onRegistrationCreated` (Retired)](#1-onregistrationcreated-retired)
  - [2. `onUserGroupWrite`](#2-onusergroupwrite)
- [Firestore Data Models & Schemas](#firestore-data-models--schemas)
  - [1. `/config/festival`](#1-configfestival)
  - [2. `/config/incentives`](#2-configincentives)
  - [3. `/config/roles`](#3-configroles)
  - [4. `/shifts/{shiftId}`](#4-shiftsshiftid)
  - [5. `/users/{userId}`](#5-usersuserid)
  - [6. `/blockedEmails/{emailId}`](#6-blockedemailsemailid)
  - [7. `/inboundMessages/{messageId}`](#7-inboundmessagesmessageid)
  - [8. `/groups/{groupId}`](#8-groupsgroupid)
- [Firestore Security Rules Overview](#firestore-security-rules-overview)
- [Maintenance & Documentation Maintenance Policy](#maintenance--documentation-maintenance-policy)

---

## Overview & Architecture

The BrewCrew backend is built on **Firebase Cloud Functions (2nd Gen)** running on the **Node.js 24** runtime using the Firebase Admin SDK (`firebase-admin`).

- **Base Project ID**: `brewcrew-f27fb`
- **Callable Region (Default)**: `us-central1`
- **Firestore Event Trigger Region**: `europe-west2`
- **Protocol**: Firebase HTTPS Callable (`onCall` from `firebase-functions/v2/https`)
- **Transport Format**: JSON over HTTPS, handled natively by Firebase Web SDK (`functions.httpsCallable(...)`)

Callable functions automatically handle deserialization of the JSON payload into `request.data` and attach verified caller authentication metadata to `request.auth`.

---

## Authentication & Role-Based Access Control (RBAC)

All callable functions (except background triggers) require user authentication. Caller authorization is determined by querying the user's profile document in the Firestore `/users/{uid}` collection.

### Defined Roles

| Role | Hierarchy Level | Capabilities |
| :--- | :--- | :--- |
| `volunteer` | Standard User | Register for open shifts (`claimShift`), cancel own shift with 7-day lockout (`cancelShift`), browse shifts, view privacy-masked shift rosters, manage own profile (public/private visibility, group/club, custom avatar). |
| `manager` | Elevated Staff | All volunteer actions + inspect complete volunteer rosters (including contact info), self-claim unassigned shifts as manager (`assignShiftManager`) or release assigned shifts in the roster modal, update shift notes/status. |
| `admin` | Festival Administrator | Full system access: create shifts (`createShift`), update shifts (`updateShift`), delete empty sessions (`deleteFestivalSession`), assign/reassign any manager (`assignShiftManager`), cancel any volunteer's shift bypassing lockout (`cancelShift`), update crew roles (`updateUserRole`), dispatch email announcements (`sendAdminBroadcast`), manage volunteer groups (`createGroup`, `updateGroup`, `mergeGroups`, `deleteGroup`, `setUserGroup`). |

#### Admin Mode UI Toggle (Client-Side Interface Switching)

To maintain an uncluttered operational interface, users with the `admin` role default to **Manager View** upon sign-in:
- **Manager View (Default on Login)**: Admin users operate with shift manager capabilities (browsing shifts, viewing volunteer rosters, claiming unassigned shifts as manager). Administrative controls (`createShift`, `assignShiftManager`, individual volunteer registration cancellations, Admin Panel view) are hidden.
- **Admin Mode (Toggled)**: Admin users can enter **Admin Mode** at any time via the user profile dropdown menu or the schedule view action banner. Activating Admin Mode dynamically exposes all administrator functions and controls (create new shifts, edit shifts, assign shift managers, cancel individual volunteer registrations, and access the Admin Panel). An enabled role badge (`Admin`, `Manager`, `Volunteer`) is displayed directly over the user's avatar in the navigation header.
- **Security Assurance**: Non-admin users (`volunteer` and `manager`) never see the toggle and cannot activate Admin Mode. Server-side authorization in Cloud Functions and Firestore security rules independently verify the caller's Firestore role document on every operation regardless of client state.

---

## Error Handling & Status Codes

All callable Cloud Functions throw `HttpsError` from `firebase-functions/v2/https`. Standard error codes used across the API:

| Code | HTTP Equivalent | Description |
| :--- | :--- | :--- |
| `unauthenticated` | 401 Unauthorized | Caller is not signed in with a valid Firebase Auth token. |
| `permission-denied` | 403 Forbidden | Caller does not possess the requisite role (`admin` or `manager`). |
| `invalid-argument` | 400 Bad Request | Missing or malformed parameters in `request.data` (e.g. non-existent `sessionId`). |
| `not-found` | 404 Not Found | Referenced entity (shift, session, user, registration) does not exist. |
| `failed-precondition`| 412 Precondition Failed | Operation rejected due to state conflict (e.g. shift full, lockout window active, session has assigned shifts, self-lockout, overlapping shift registrations). |
| `already-exists` | 409 Conflict | Duplicate booking or manager slot already filled. |
| `internal` | 500 Internal Server Error | Unexpected downstream error (e.g. SMTP transport failure). |

---

## Callable Functions Reference

### 1. `claimShift`

Registers an authenticated volunteer for an open festival shift atomically, ensuring no capacity overbooking occurs under concurrent requests and preventing concurrent/overlapping shift bookings for the same volunteer. Also supports administrators directly assigning shifts to registered volunteers.

- **Trigger**: `onCall`
- **Permissions**:
  - **Self-registration**: Any authenticated user (`volunteer`, `manager`, or `admin`).
  - **Admin assignment**: Administrator only (`role === "admin"`). Can assign any registered volunteer via `targetUserId`.

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shiftId` | `string` | **Yes** | Firestore document ID of the shift in `/shifts`. |
| `targetUserId` | `string` | No | Target volunteer UID to register/assign (Admin only). Defaults to caller UID. |

#### Response (`result`)

```json
{
  "success": true,
  "assignedUserId": "user456"
}
```

#### Business Logic & Concurrency
1. Inspects caller role in `/users/{callerUid}`:
   - Throws `permission-denied` if caller account has `disabled: true`.
   - If `targetUserId` is specified and `targetUserId !== callerUid` and caller is **not** an admin, throws `permission-denied` (`"Only administrators can assign shifts to other volunteers."`).
2. Determines `assignedUid = (targetUserId && isAdmin) ? targetUserId : callerUid`.
3. Executes within a Firestore transaction (`db.runTransaction`):
   - Reads `/shifts/{shiftId}`. Throws `not-found` if the shift does not exist.
   - If `assignedUid !== callerUid`, verifies `/users/{assignedUid}` exists and does not have `disabled: true`. Throws `failed-precondition` if the target volunteer account is disabled.
   - Compares `shift.assignedCount >= shift.capacity`. If full, throws `failed-precondition` (`"This shift is already full."`).
   - Checks `/registrations/{shiftId}_{assignedUid}`. If a registration exists with `status: "confirmed"`, throws `already-exists` (`"You are already registered for this shift."` or `"This volunteer is already registered for this shift."`).
   - **Overlapping & Simultaneous Shift Registration Safeguard**:
     - Parses target shift `startTime` and `endTime` into epoch timestamps.
     - Queries assigned volunteer's active registrations (`/registrations` where `userId == assignedUid` and `status == "confirmed"`).
     - Within the transaction, fetches all other registered shift documents (`transaction.getAll`).
     - Validates for time conflicts using interval intersection: `targetStart < otherEnd && otherStart < targetEnd`.
     - If an overlapping shift is detected, aborts the transaction and throws `failed-precondition` with shift conflict details.
   - Atomically executes:
     - Increments `/shifts/{shiftId}.assignedCount` by `1`.
     - Writes `/registrations/{shiftId}_{assignedUid}`:
       ```json
       {
         "shiftId": "shift123",
         "userId": "user456",
         "registeredAt": "FieldValue.serverTimestamp()",
         "status": "confirmed",
         "assignedBy": "adminUid123"
       }
       ```
       *(Note: `assignedBy` is recorded only when assigned by an administrator).*
4. **Asynchronous WhatsApp Booking Confirmation**:
   - Following successful transaction commit, queries `/users/{assignedUid}`.
   - If `whatsappNotifications !== false` and a valid `phoneNumber` is registered, dispatches an automated WhatsApp booking confirmation via Twilio containing shift area name, date, and formatted working hours.
   - Delivery errors are non-blocking and logged without rolling back the confirmed registration.

---

### 2. `cancelShift`

Cancels a shift registration. Enforces a 7-day lockout prior to the date of the shift for standard volunteers, while allowing festival administrators to cancel any volunteer's shift at any time.

- **Trigger**: `onCall`
- **Permissions**:
  - **Self-cancellation**: Caller can cancel their own shift at any point until 7 days before the shift date (e.g. if the shift is on 14-May-2027, cancellation is permitted through 23:59:59 on 7-May-2027).
  - **Admin cancellation**: Users with `role: "admin"` can cancel any volunteer's shift at any time.

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shiftId` | `string` | **Yes** | Firestore document ID of the shift in `/shifts`. |
| `targetUserId` | `string` | No | Target volunteer UID to cancel (Admin only). Defaults to caller UID. |

#### Response (`result`)

```json
{
  "success": true
}
```

#### Business Logic & Concurrency
1. Inspects caller role in `/users/{callerUid}`:
   - If `targetUserId` is specified and `targetUserId !== callerUid` and caller is **not** an admin, throws `permission-denied` (`"Only admins can cancel shifts for other volunteers."`).
2. Executes within a Firestore transaction:
   - Reads `/shifts/{shiftId}` and `/registrations/{shiftId}_{targetUid}`. Throws `not-found` if either is missing.
   - **7-Day Before Shift Date Lockout Check**: If caller is **not** an admin, computes the calendar cutoff date as 23:59:59.999 on the 7th calendar day prior to the shift date (`shiftDate.getDate() - 7`). If `Date.now() > cutoffDate.getTime()`, throws `failed-precondition` (`"Cannot cancel shifts within 7 days of shift date."`).
   - Decrements `/shifts/{shiftId}.assignedCount` by `1` (clamped to minimum `0`).
   - Deletes `/registrations/{shiftId}_{targetUid}`.
3. **Asynchronous WhatsApp Cancellation Alert**:
   - Following successful transaction commit, queries `/users/{targetUid}`.
   - If `whatsappNotifications !== false` and a valid `phoneNumber` is registered, dispatches an automated WhatsApp cancellation notice via Twilio detailing the cancelled shift area and scheduled time.
   - Delivery errors are non-blocking and logged without impacting the cancellation state.

---

### 3. `createShift`

Creates a new festival shift in the schedule database. Strictly enforces foreign key validation ensuring the referenced `sessionId` exists in `/config/festival`.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | **Yes** | ID of an active festival session in `/config/festival` (e.g. `"sess_1"`). Must exist. |
| `categoryName` | `string` | **Yes** | Area name (e.g. `"Cider Bar"`, `"Cask Bar"`, `"Gate"`, etc.). |
| `capacity` | `number` / `string` | **Yes** | Positive integer specifying volunteer capacity. |
| `startTime` | `string` / `number` | **Yes** | ISO-8601 string or timestamp representing shift start. |
| `endTime` | `string` / `number` | **Yes** | ISO-8601 string or timestamp representing shift end (must be after `startTime`). |
| `managerUserId` | `string` | No | Optional UID of a designated shift manager or admin. |

#### Response (`result`)

```json
{
  "success": true,
  "shiftId": "generatedShiftDocId"
}
```

#### Business Logic & Validation
1. Validates caller profile: throws `permission-denied` if `caller.role !== "admin"`.
2. Validates `sessionId` is provided and exists in `/config/festival.sessions`. Throws `invalid-argument` if missing or not found.
3. Validates `categoryName` (non-empty string).
4. Validates `capacity` (integer `>= 1`).
5. Validates `endTime > startTime`.
6. If `managerUserId` is provided:
   - Fetches `/users/{managerUserId}`. Throws `not-found` if user does not exist.
   - Verifies target user has `role === "manager"` or `role === "admin"`. Throws `failed-precondition` otherwise.
   - Extracts `managerName` and `managerEmail`.
7. Adds document to `/shifts`:
   ```javascript
   {
     sessionId: sessionId.trim(),
     categoryName: categoryName.trim(),
     capacity: Number(capacity),
     assignedCount: 0,
     startTime: Timestamp.fromDate(new Date(startTime)),
     endTime: Timestamp.fromDate(new Date(endTime)),
     managerId: managerData.managerId,
     managerName: managerData.managerName,
     managerEmail: managerData.managerEmail,
     createdAt: FieldValue.serverTimestamp(),
     createdBy: request.auth.uid
   }
   ```

---

### 4. `updateShift`

Updates an existing festival shift's details (times, area category, session assignment, capacity).

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shiftId` | `string` | **Yes** | Firestore document ID of the shift in `/shifts`. |
| `categoryName` | `string` | No | Updated area / bar category name. |
| `capacity` | `number` / `string` | No | New volunteer capacity (must be `>=` number of currently assigned volunteers). |
| `startTime` | `string` / `number` | No | Updated shift start datetime ISO string. |
| `endTime` | `string` / `number` | No | Updated shift end datetime ISO string (must be after `startTime`). |
| `sessionId` | `string` | No | Updated festival session template ID. Must exist in `/config/festival.sessions`. |

#### Response (`result`)

```json
{
  "success": true,
  "shiftId": "shiftDocId"
}
```

#### Business Logic & Safeguards
1. Validates caller is authenticated and has `role === "admin"`.
2. Verifies `/shifts/{shiftId}` exists. Throws `not-found` if missing.
3. If `categoryName` is supplied, validates that it is a non-empty string.
4. If `sessionId` is supplied, validates that it exists in `/config/festival.sessions`. Throws `invalid-argument` if not found.
5. If `capacity` is modified, validates that `capacity >= 1` and `capacity >= shift.assignedCount`. Throws `failed-precondition` if capacity would be reduced below confirmed bookings.
6. If timestamps are modified, validates `endTime > startTime`.
7. Updates `/shifts/{shiftId}` with modified fields, `updatedAt: serverTimestamp()`, and `updatedBy: callerUid`.

---

### 5. `assignShiftManager`

Assigns or unassigns a designated Shift Manager for a specific shift. Strictly enforces a **1 manager per shift** rule.

- **Trigger**: `onCall`
- **Permissions**:
  - `manager`: Can assign themselves to an unassigned shift (`managerUserId === callerUid`) or unassign themselves (`managerUserId === null`).
  - `admin`: Can assign, reassign, or unassign any qualifying user (`manager` or `admin`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shiftId` | `string` | **Yes** | Firestore document ID of the shift in `/shifts`. |
| `managerUserId` | `string` \| `null` | No | UID of user to assign, or `null`/empty to unassign. |

#### Response (`result`)

**When Assigning:**
```json
{
  "success": true,
  "assigned": true,
  "managerId": "user123",
  "managerName": "Jane Doe"
}
```

**When Unassigning:**
```json
{
  "success": true,
  "assigned": false
}
```

#### Business Logic & Concurrency
1. Checks caller role: throws `permission-denied` if caller is not `manager` or `admin`.
2. If caller is `manager` (non-admin) and passes `managerUserId && managerUserId !== callerUid`: throws `permission-denied` (`"Managers can only assign themselves."`).
3. Runs within a Firestore transaction:
   - Reads `/shifts/{shiftId}`. Throws `not-found` if missing.
   - **Unassigning (`!managerUserId`)**:
     - If caller is not admin and `shift.managerId !== callerUid`, throws `permission-denied` (`"You can only unassign yourself as manager."`).
     - Updates `managerId: null`, `managerName: null`, `managerEmail: null`.
   - **Assigning**:
     - If `shift.managerId && shift.managerId !== managerUserId` and caller is not admin, throws `already-exists` (`"This shift already has a manager... Only one manager can be assigned per shift."`).
     - Verifies target user exists and has role `manager` or `admin`.
     - Updates `managerId`, `managerName`, `managerEmail`.

---

### 6. `updateUserRole`

Promotes or demotes crew members across `volunteer`, `manager`, and `admin` roles.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `targetUserId` | `string` | **Yes** | Firestore document ID in `/users`. |
| `newRole` | `string` | **Yes** | Must be one of: `"volunteer"`, `"manager"`, or `"admin"`. |

#### Response (`result`)

```json
{
  "success": true,
  "userId": "user123",
  "role": "manager"
}
```

#### Business Logic & Safeguards
1. Verifies caller is admin: throws `permission-denied` if not.
2. Validates `newRole` against `["volunteer", "manager", "admin"]`.
3. Verifies `/users/{targetUserId}` exists.
4. **Self-Lockout Safeguard**: If `targetUserId === request.auth.uid && newRole !== "admin"`, throws `failed-precondition` (`"You cannot revoke your own administrator privileges."`).
5. Updates `/users/{targetUserId}` with `role`, `updatedAt: serverTimestamp()`, `updatedBy: callerUid`.

---

### 7. `sendAdminBroadcast`

Dispatches targeted mass announcement emails to volunteers or crew members via Nodemailer, with dynamic personalization tokens and 5-tier targeting. Accessible directly from the **Admin Panel** or via backend callable API.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `subject` | `string` | **Yes** | Email subject line (supports dynamic personalization tokens). |
| `body` | `string` | **Yes** | HTML or text announcement body (supports dynamic personalization tokens; formatted automatically into styled HTML paragraphs). |
| `targetType` | `string` | No | Target recipient filter mode: `"all"`, `"role"`, `"category"`, `"shift"`, or `"users"`. Defaults to `"all"` (or `"role"` if `targetRole` is provided). |
| `targetRole` | `string` | No | Target role filter when `targetType === "role"`: `"volunteer"` or `"manager"`. |
| `targetCategory` | `string` | No | Target shift area/category name when `targetType === "category"` (e.g. `"Keg Bar"`). |
| `targetShiftId` | `string` | No | Target shift document ID when `targetType === "shift"`. |
| `targetUserIds` | `string[]` | No | Explicit array of user IDs when `targetType === "users"`. |
| `onlyWithConfirmedShifts` | `boolean` | No | If `true`, only users with at least one confirmed shift are messaged. Defaults to `false`. |

#### Dynamic Placeholders Supported in Subject & Body

| Placeholder | Replaced With |
| :--- | :--- |
| `{{name}}` | Recipient's full name (fallback: `"Volunteer"`). |
| `{{first_name}}` | Recipient's first name (fallback: `"there"`). |
| `{{category}}` | Targeted or upcoming shift area (fallback: `"Festival Shift"`). |
| `{{date}}` | Formatted shift date (e.g. `"Sat 3 Aug"`). |
| `{{time}}` | Formatted shift hours (e.g. `"12:00 - 17:00"`). |
| `{{all_shifts}}` | Chronological styled HTML `<ul>` list of all confirmed upcoming shifts for that recipient (date, working hours, and area; manager name omitted). Fallback: `No shifts currently scheduled`. |

#### Response (`result`)

```json
{
  "success": true,
  "count": 42,
  "skippedCount": 3
}
```

#### Business Logic & Safeguards
1. Verifies caller is authenticated and has `role === "admin"`.
2. Validates caller account is not disabled.
3. Resolves recipients using `resolveBroadcastRecipients`, filtering by `targetType` and `onlyWithConfirmedShifts`.
4. Checks each recipient's `emailNotifications !== false` preference and valid email format. Skips opted-out or invalid recipients, incrementing `skippedCount`.
5. Substitutes placeholders for each recipient individually in both subject and body.
6. Formats body into clean HTML and wraps in BrewCrew branded container.
7. Uses Nodemailer with Gmail SMTP credentials (`GMAIL_EMAIL`, `GMAIL_PASS` from `functions/.env`), with sender formatted as `"${festivalName} <${gmailEmail}>"`.
8. Dispatches emails and returns `{ success: true, count, skippedCount }`.

---

### 8. `deleteFestivalSession`

Safely removes a festival session from `/config/festival`. Strictly prevents deletion if any shifts are currently assigned to the session.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | **Yes** | ID of the session to delete (e.g. `"sess_1"`). |

#### Response (`result`)

```json
{
  "success": true,
  "sessionId": "sess_1"
}
```

#### Business Logic & Safeguards
1. Validates caller is authenticated and has `role === "admin"`. Throws `permission-denied` if not.
2. Validates `sessionId` is provided. Throws `invalid-argument` if missing.
3. Queries `/shifts` where `sessionId == sessionId`:
   - If any shifts are found, throws `failed-precondition` (`"Cannot delete session because X shift(s) are currently assigned to it. Please reassign or delete the associated shifts first."`).
4. Reads `/config/festival`. Throws `not-found` if the session does not exist in `config.sessions`.
5. Ensures at least one session remains in configuration: throws `failed-precondition` if `sessions.length <= 1`.
6. Removes the session from `sessions` array, updates `/config/festival` with `updatedAt: serverTimestamp()` and `updatedBy: callerUid`.

---

### 9. `getShiftCategories`

Retrieves all unique, active category/area names from active documents in the `/shifts` collection. This replaces hard-coded category presets and dedicated collections by sourcing areas dynamically from existing shift records.

- **Trigger**: `onCall`
- **Permissions**: `volunteer`, `manager`, or `admin` (Any authenticated user).

#### Request Parameters (`data`)

*None required*.

#### Response (`result`)

```json
{
  "categories": [
    "Cask Bar",
    "Cider Bar",
    "Gate",
    "Keg Bar",
    "Token and Merch"
  ]
}
```

#### Business Logic & Safeguards
1. Validates caller is authenticated (`request.auth`). Throws `unauthenticated` if caller is not logged in.
2. Queries the `/shifts` collection.
3. Iterates over all shift documents and extracts non-empty string values for `categoryName`, trimming whitespace.
4. Deduplicates the category names using a `Set`.
5. Returns `{ categories: string[] }` sorted alphabetically ascending.
6. Returns an empty array `{ "categories": [] }` if no shifts exist.

---

### 10. `setUserDisabledStatus`

Disables or re-enables a crew member's user account, immediately revoking refresh tokens and blocking login and operations across the platform.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `targetUserId` | `string` | **Yes** | Firestore document ID in `/users`. |
| `disabled` | `boolean` | **Yes** | `true` to disable/deactivate account; `false` to reactivate. |
| `reason` | `string` | No | Optional administrative rationale for disabling the account. |

#### Response (`result`)

```json
{
  "success": true,
  "userId": "user123",
  "disabled": true
}
```

#### Business Logic & Safeguards
1. Verifies caller is authenticated and has `role === "admin"`.
2. Validates caller account is not disabled.
3. Validates `targetUserId` is provided and target document exists in `/users/{targetUserId}`.
4. **Self-Lockout Safeguard**: Throws `failed-precondition` if `targetUserId === callerUid`.
5. Updates `/users/{targetUserId}` with `disabled`, `status: disabled ? "disabled" : "active"`, `disabledAt`, `disabledBy`, and `disabledReason`.
6. Invokes Firebase Admin Auth `admin.auth().updateUser(targetUserId, { disabled: disabled })`.
7. When disabling, immediately revokes active refresh tokens via `admin.auth().revokeRefreshTokens(targetUserId)`.

---

### 11. `deleteAndBlockUser`

Permanently deletes a user's account from Firebase Auth and Firestore, automatically releases all festival shifts currently allocated to the user (decrementing shift capacity counts), clears any manager assignments, and permanently blacklists their email address in `/blockedEmails` to prevent re-registration.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `targetUserId` | `string` | **Yes** | Firestore document ID in `/users`. |
| `reason` | `string` | No | Optional administrative justification for deleting and blocking. |

#### Response (`result`)

```json
{
  "success": true,
  "deletedUserId": "user123",
  "blockedEmail": "volunteer@example.com",
  "releasedShiftsCount": 3
}
```

#### Business Logic & Safeguards
1. Verifies caller is authenticated and has `role === "admin"`.
2. Validates caller account is not disabled.
3. **Self-Deletion Safeguard**: Throws `failed-precondition` if `targetUserId === callerUid`.
4. Reads `/users/{targetUserId}` to retrieve user profile and registered email address. Throws `not-found` if user does not exist.
5. Queries all active confirmed shift registrations for the user (`/registrations` where `userId == targetUserId` and `status == "confirmed"`).
6. Queries all shifts where the user is assigned as Shift Manager (`/shifts` where `managerId == targetUserId`).
7. Executes an atomic batch mutation:
   - For each shift registration: decrements `/shifts/{shiftId}.assignedCount` by `1` and deletes the `/registrations/{shiftId}_{targetUserId}` document.
   - For each managed shift: resets `managerId: null`, `managerName: null`, `managerEmail: null`.
   - Writes record to `/blockedEmails/{normalizedEmail}`:
     ```json
     {
       "email": "volunteer@example.com",
       "originalUserId": "user123",
       "fullName": "John Doe",
       "reason": "Administrative removal & block",
       "blockedAt": "FieldValue.serverTimestamp()",
       "blockedBy": "adminUid",
       "blockedByEmail": "admin@festival.org"
     }
     ```
   - Deletes `/users/{targetUserId}` profile document.
8. Deletes the user account from Firebase Authentication (`admin.auth().deleteUser(targetUserId)`).
9. Returns confirmation payload including `releasedShiftsCount`.

---

### 12. `unblockUserEmail`

Removes an email address from the `/blockedEmails` blacklist, restoring the ability for the email to register or log in with festival administrator consent.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `email` | `string` | **Yes** | Email address to unblock (case-insensitive). |

#### Response (`result`)

```json
{
  "success": true,
  "unblockedEmail": "volunteer@example.com"
}
```

#### Business Logic & Safeguards
1. Verifies caller is authenticated and has `role === "admin"`.
2. Validates caller account is not disabled.
3. Normalizes input email (trimmed, lowercase).
4. Verifies `/blockedEmails/{normalizedEmail}` exists. Throws `not-found` if missing.
5. Deletes `/blockedEmails/{normalizedEmail}` document.

---

### 13. `sendWhatsAppBroadcast`

Dispatches targeted mass announcement messages to volunteers or crew members via Twilio WhatsApp, using the identical 5-tier targeting and dynamic personalization placeholder engine as `sendAdminBroadcast`. Accessible from the **Admin Panel (Communications Console)** or via backend callable API.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `body` | `string` | **Yes** | WhatsApp message body (supports dynamic personalization tokens and standard WhatsApp markdown: `*bold*`, `_italic_`). |
| `targetType` | `string` | No | Target recipient filter mode: `"all"`, `"role"`, `"category"`, `"shift"`, or `"users"`. Defaults to `"all"`. |
| `targetRole` | `string` | No | Target role filter when `targetType === "role"`: `"volunteer"` or `"manager"`. |
| `targetCategory` | `string` | No | Target shift area/category name when `targetType === "category"` (e.g. `"Keg Bar"`). |
| `targetShiftId` | `string` | No | Target shift document ID when `targetType === "shift"`. |
| `targetUserIds` | `string[]` | No | Explicit array of user IDs when `targetType === "users"`. |
| `onlyWithConfirmedShifts` | `boolean` | No | If `true`, only users with at least one confirmed shift are messaged. Defaults to `false`. |

#### Dynamic Placeholders Supported in Body

| Placeholder | Replaced With |
| :--- | :--- |
| `{{name}}` | Recipient's full name (fallback: `"Volunteer"`). |
| `{{first_name}}` | Recipient's first name (fallback: `"there"`). |
| `{{category}}` | Targeted or upcoming shift area (fallback: `"Festival Shift"`). |
| `{{date}}` | Formatted shift date (e.g. `"Sat 3 Aug"`). |
| `{{time}}` | Formatted shift hours (e.g. `"12:00 - 17:00"`). |
| `{{all_shifts}}` | Chronological Markdown bullet list (`• *Date (Time)*: Area`) of all confirmed upcoming shifts for that recipient (manager name omitted). Fallback: `_No shifts currently scheduled_`. |

#### Response (`result`)

```json
{
  "success": true,
  "count": 38,
  "skippedCount": 7,
  "warning": null,
  "errors": []
}
```
*(Note: If Twilio credentials are missing, placeholder, or delivery fails, `warning` returns a human-readable diagnostic message (e.g. `"Twilio Error 21654 (ContentSid Required): WhatsApp blocks outbound free-form messages outside a 24-hour window..."`), and `errors` returns an array of specific recipient-level delivery issues.)*

#### Business Logic & Safeguards
1. Verifies caller is authenticated and has `role === "admin"`.
2. Validates caller account is not disabled.
3. Resolves recipients using `resolveBroadcastRecipients`, filtering by `targetType` and `onlyWithConfirmedShifts`.
4. Checks whether Twilio credentials (either API Key: `TWILIO_API_SID` + `TWILIO_API_KEY` + `TWILIO_ACCOUNT_SID`, or legacy: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`, along with `TWILIO_WHATSAPP_NUMBER`) are valid and non-placeholder. If unconfigured, gracefully skips all targeted recipients (`skippedCount++`, `count: 0`) and returns an informative diagnostic warning without failing the request.
5. Checks each recipient's `whatsappNotifications !== false` preference and normalizes their phone number to E.164 via `normalizeE164`. Skips opted-out or invalid phone numbers, incrementing `skippedCount` and logging the specific reason.
6. Substitutes placeholders for each recipient individually using WhatsApp channel formatting.
7. Prefixes message with branded festival header: `🍺 *${broadcastFromName}*\n\n${personalizedBody}`.
8. Dispatches WhatsApp messages via `sendWhatsAppAlert` (Twilio API) and **only increments `count` if Twilio returns a verified message SID (`dispatchResult.sid`)**. Failed deliveries increment `skippedCount` and record friendly translations for Twilio error codes (e.g. 21654 24h window policy, 21608 sandbox not joined, 20003 auth error).
9. Returns `{ success: true, count, skippedCount, warning, errors }`.

---

### Group Management Callables (14–18)

Shared behaviour for all group callables:
- **Trigger**: `onCall` · **Permissions**: Administrator only (`role === "admin"`, account not disabled). Errors: `unauthenticated`, `permission-denied` (`"Only administrators can manage groups."` / `"Administrator account is disabled."`).
- **Name rules**: names are trimmed and internal whitespace collapsed; length must be **2–50** characters (`invalid-argument`). Uniqueness is case/whitespace-insensitive via `nameKey` (`already-exists`).
- **Membership resolution** (rename/merge/delete): a user belongs to a group if `users.groupId == groupId`, **or** (lazy migration) the user has no `groupId` and their normalised `groupOrClub` matches the group's `nameKey`. User updates are written in chunked batches (≤450 writes per batch).
- All writes to `/groups` happen server-side; clients cannot write the collection (see [Security Rules](#firestore-security-rules-overview)).

### 14. `createGroup`

Creates a managed volunteer group.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | Group display name (2–50 chars after normalisation). |
| `includeInGroupIncentives` | `boolean` | No | Group Incentives eligibility. Defaults to `true`. |

```json
{ "success": true, "groupId": "Xy12AbC", "name": "CAMRA North Branch" }
```

**Errors**: `invalid-argument` (bad name / non-boolean flag), `already-exists` (a group with the same `nameKey` exists; checked inside a transaction).

### 15. `updateGroup`

Renames a group and/or toggles its Group Incentives eligibility. Renames propagate to every member's `groupOrClub` (and link lazy members by setting `groupId`).

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `groupId` | `string` | **Yes** | Target group ID. |
| `name` | `string` | No* | New display name. |
| `includeInGroupIncentives` | `boolean` | No* | Include (`true`) or exclude (`false`) from Group Incentives. |

\* At least one of `name` / `includeInGroupIncentives` is required.

```json
{
  "success": true,
  "groupId": "Xy12AbC",
  "name": "CAMRA North",
  "includeInGroupIncentives": true,
  "updatedUsers": 6
}
```

**Errors**: `invalid-argument`, `not-found` (group missing), `already-exists` (new name clashes with another group — use `mergeGroups` instead).

### 16. `mergeGroups`

Moves all members of the source group into the target group, then deletes the source. The source is deleted **before** members are moved so the `onUserGroupWrite` trigger cannot re-link users to it.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sourceGroupId` | `string` | **Yes** | Group to merge away (deleted). |
| `targetGroupId` | `string` | **Yes** | Group that receives the members. Must differ from source. |

```json
{ "success": true, "targetGroupId": "Xy12AbC", "targetName": "CAMRA North", "movedUsers": 3 }
```

**Errors**: `invalid-argument` (missing IDs / same group), `not-found` (either group missing).

### 17. `deleteGroup`

Deletes a group; all members are set to "No group" (`groupId: null`, `groupOrClub: ""`).

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `groupId` | `string` | **Yes** | Group to delete. |

```json
{ "success": true, "groupId": "Xy12AbC", "affectedUsers": 4 }
```

**Errors**: `invalid-argument`, `not-found`.

### 18. `setUserGroup`

Assigns an individual user to a group, or clears their group.

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `targetUserId` | `string` | **Yes** | UID of the user to update. |
| `groupId` | `string` \| `null` | **Yes** | Group ID to assign, or `null` for "No group". |

```json
{ "success": true, "userId": "user456", "groupId": "Xy12AbC", "groupName": "CAMRA North" }
```

**Errors**: `invalid-argument` (missing `targetUserId`, or `groupId` neither a non-empty string nor `null`), `not-found` (user or group missing).

---

## HTTP Webhook Endpoints

### 1. `twilioWhatsAppWebhook`

Inbound webhook handler for messages sent by volunteers to the dedicated BrewCrew Twilio WhatsApp number. Automatically resolves volunteer identity and upcoming shift schedule, logs the inbound conversation into `/inboundMessages`, auto-forwards the inquiry to the Volunteer Coordinator's mobile phone with a 1-tap `wa.me` direct reply link, and dispatches an instant automated acknowledgment reply to the volunteer.

- **Trigger**: `onRequest` (HTTP POST)
- **Permissions**: Public endpoint (secured via Twilio webhook signature / sender verification).

#### Inbound Request Payload (Twilio Form URL-Encoded / JSON)

| Field | Type | Description |
| :--- | :--- | :--- |
| `From` | `string` | Originating WhatsApp sender string (e.g. `"whatsapp:+447123456789"`). |
| `To` | `string` | Destination bot number. |
| `Body` | `string` | Text content of the volunteer's WhatsApp reply. |
| `MessageSid` | `string` | Unique Twilio message identifier. |

#### Business Logic & Workflow
1. Verifies HTTP request method is `POST`.
2. Strips `"whatsapp:"` prefix and normalizes the sender's mobile phone number to standard E.164 via `normalizeE164`.
3. Looks up the volunteer profile in `/users` matching the normalized phone number.
4. If a volunteer is identified, queries active confirmed shift registrations (`/registrations` where `userId == volunteer.id`) to determine their next upcoming shift area, date, and time.
5. Retrieves the Volunteer Coordinator's mobile phone number from `/config/festival`.
6. Logs the message record into Firestore collection `/inboundMessages`.
7. Auto-forwards the inbound message to the Volunteer Coordinator's WhatsApp via `sendWhatsAppAlert`, complete with sender context, upcoming shift details, and an embedded 1-tap reply link:
   `https://wa.me/<cleanVolunteerPhone>`.
8. Sends an immediate automated confirmation reply to the volunteer assuring them their message has been forwarded to festival coordination.
9. Returns HTTP 200 with empty TwiML `<Response></Response>`.

---

## Firestore Background Triggers

### 1. `onRegistrationCreated` (Retired)

> [!NOTE]
> **Status: Retired / Disabled**
> The automatic transactional email confirmation upon shift registration has been retired as shift registration confirmation emails are no longer required. The Nodemailer email transport infrastructure and administrative broadcast capability ([`sendAdminBroadcast`](#7-sendadminbroadcast)) remain active for volunteer announcements from the Admin Panel.

### 2. `onUserGroupWrite`

Resolves a user's free-text `groupOrClub` to a canonical `/groups` document and sets `groupId` server-side, so clients never write `groupId` directly. Also performs **lazy migration** of legacy free-text groups: any write to an unlinked user profile resolves it.

- **Trigger**: `onDocumentWritten("users/{userId}")` · **Region**: `europe-west2`

#### Workflow
1. Ignores deletes. **Fast path**: exits if `groupId` is set and neither `groupOrClub` nor `groupId` changed in this write (prevents loops and cost on unrelated profile writes).
2. Normalises `groupOrClub` (trim + collapse whitespace). If shorter than 2 characters, clears `groupId` (leaves the text untouched) and exits.
3. If already linked to a group with the same `nameKey`, rewrites `groupOrClub` to the canonical name if casing/spacing differs, then exits.
4. Otherwise, in a **transaction**, finds a group by `nameKey` or creates one (`createdBy: "signup"`, `includeInGroupIncentives: true`, name truncated to 50 chars). The transaction prevents duplicate groups under concurrent signups with the same name.
5. Writes `groupId` and canonical `groupOrClub` to the user if they differ. The resulting re-trigger exits at step 3.

> [!NOTE]
> Groups created via signup/profile "Other…" are **immediately public** in the signup dropdown (no moderation). Admins clean up via rename/merge/delete.

---

## Firestore Data Models & Schemas

### 1. `/config/festival`

Global festival settings document storing brand identity, manager contacts, and schedule sessions.

| Field | Type | Description |
| :--- | :--- | :--- |
| `festivalName` | `string` | Display name of the festival (e.g. `"Manchester Beer & Cider Festival"`). |
| `festivalWebsite` | `string` | Official website URL of the festival. |
| `festivalLogoUrl` | `string` | Public URL to festival logo image, displayed in navbars and emails. |
| `volunteerManager` | `map` | Coordinator contact info: `{ name: string, email: string, phone: string }`. |
| `sessions` | `array` | List of configured session objects: `[{ id: string, name: string, date: string, startTime: string, endTime: string, description: string }]`. |
| `updatedAt` | `timestamp` | Server timestamp when settings were last modified. |
| `updatedBy` | `string` | UID of administrator who committed the update. |

### 2. `/config/incentives`

Global volunteer incentives and milestone rewards configuration document defining reward thresholds earned as volunteers accumulate shift hours and guest welcome messaging.

| Field | Type | Description |
| :--- | :--- | :--- |
| `welcomeTitle` | `string` | Custom greeting title displayed to unauthenticated visitors inside the floating pint glass incentive popover. |
| `welcomeText` | `string` | Custom explanatory text displayed to unauthenticated visitors describing the festival volunteer program and how lending a hand unlocks rewards. |
| `items` | `array` | List of configured reward milestone objects: `[{ id: string, hours: number, hoursRequired: number, name: string, rewardName: string, description: string }]`. |
| `updatedAt` | `timestamp` | Server timestamp when incentives were last updated. |
| `updatedBy` | `string` | UID of administrator who committed the update. |

### 3. `/config/roles`

Global volunteer role guides and area briefings configuration document. Defines role metadata, summaries, emoji icons, and rich-text briefings for shift areas (derived dynamically from active shift `categoryName`s).

- **Read Access:** Public (`allow read: if true;`), allowing prospective volunteers to browse roles on `roles.html` without authenticating.
- **Write Access:** `admin` only (`allow write: if isAdmin();`).

| Field | Type | Description |
| :--- | :--- | :--- |
| `roles` | `map` | Map of area/role names (e.g. `"Cask Bar"`, `"Tokens & Merch"`, `"Gate"`) to role profile objects. |
| `roles.{area}.icon` | `string` | Optional emoji icon (e.g. `"🍺"`, `"🎟️"`, `"🚪"`). |
| `roles.{area}.summary` | `string` | Concise 1–2 sentence summary blurb for card badges and roster previews. |
| `roles.{area}.description` | `string` | Sanitized rich HTML content containing section headings (`<h2>`, `<h3>`), paragraphs, bold formatting, bulleted lists, numbered lists, and off-site hyperlinks. |
| `roles.{area}.updatedAt` | `timestamp` | Server timestamp when this role guide was last saved. |
| `roles.{area}.updatedBy` | `string` | UID of administrator who last updated this role. |
| `updatedAt` | `timestamp` | Server timestamp when the roles configuration document was last modified. |
| `updatedBy` | `string` | UID of administrator who committed the update. |

### 4. `/shifts/{shiftId}`

Festival shift documents defining individual working slots.

| Field | Type | Description |
| :--- | :--- | :--- |
| `sessionId` | `string` \| `null` | Associated festival session template ID (e.g. `"sess_1"`). |
| `categoryName` | `string` | Bar or working area name (e.g. `"Cider Bar"`, `"Gate"`). |
| `capacity` | `number` | Total volunteer slots available. |
| `assignedCount` | `number` | Currently confirmed volunteer bookings. |
| `startTime` | `timestamp` | Start date and time of the shift. |
| `endTime` | `timestamp` | End date and time of the shift. |
| `managerId` | `string` \| `null` | UID of assigned Shift Manager. |
| `managerName` | `string` \| `null` | Display name of assigned Shift Manager. |
| `managerEmail` | `string` \| `null` | Email of assigned Shift Manager. |
| `createdAt` | `timestamp` | Server timestamp when shift was created. |
| `createdBy` | `string` | UID of administrator who created the shift. |
| `updatedAt` | `timestamp` | Server timestamp when shift was last edited. |
| `updatedBy` | `string` | UID of administrator who last edited the shift. |

### 5. `/users/{userId}`

User profile document created upon initial registration or OAuth sign-in, manageable by volunteers via the "My Profile" modal.

| Field | Type | Description |
| :--- | :--- | :--- |
| `fullName` | `string` | Full name of the volunteer or crew member. |
| `email` | `string` | Registered email address (lowercase). |
| `phoneNumber` | `string` | **Mandatory** contact phone number required on registration and onboarding. Normalized to international E.164 format (e.g. `+447123456789`). |
| `whatsappNotifications` | `boolean` | Volunteer notification opt-out preference for WhatsApp alerts and broadcasts. Defaults to `true`. Configurable in "My Profile" modal. |
| `emailNotifications` | `boolean` | Volunteer notification opt-out preference for email updates and announcements. Defaults to `true`. Configurable in "My Profile" modal. |
| `groupOrClub` | `string` | Optional group/club name (e.g. CAMRA branch, brewery team). Chosen at signup / in "My Profile" from the `/groups` dropdown or typed via "Other…". Normalised server-side to the canonical group name by [`onUserGroupWrite`](#2-onusergroupwrite). Visible to other volunteers only when `profileVisibility` is `"public"`. |
| `groupId` | `string` \| `null` | **Server-written only.** ID of the linked `/groups` document, set by `onUserGroupWrite` or admin group callables. Clients cannot create or modify this field (security rules). Missing on legacy profiles until their next write (lazy migration); the Admin Panel falls back to matching `groupOrClub` by normalised name. |
| `profileVisibility` | `string` | Profile privacy setting: `"public"` (default) or `"private"`. When `"public"`, user name and group/club are displayed on volunteer shift rosters. When `"private"`, other volunteers see only an anonymous placeholder space. Shift managers and admins can always view full roster details. |
| `photoURL` | `string` | Optional custom profile avatar stored as a client-compressed (128x128 JPEG) Data URL. When `profileVisibility` is `"public"`, displayed in shift rosters to volunteers. When `"private"`, masked with an anonymous lock placeholder to volunteer viewers. Shift managers and admins always see avatars. |
| `role` | `string` | Access tier: `"volunteer"`, `"manager"`, or `"admin"`. |
| `disabled` | `boolean` | Account operational status. When `true`, user cannot sign in or invoke callable API endpoints. Defaults to `false`. |
| `status` | `string` | Indexed status string: `"active"` (default) or `"disabled"`. |
| `disabledAt` | `timestamp` \| `null` | Timestamp when account was deactivated by an administrator. |
| `disabledBy` | `string` \| `null` | Administrator UID who deactivated the account. |
| `disabledReason` | `string` \| `null` | Optional reason recorded when the account was disabled. |
| `createdAt` | `timestamp` | Server timestamp when the user profile was initialized. |
| `updatedAt` | `timestamp` | Server timestamp when the user profile was last updated. |

#### Shift Roster Privacy & Access Control Rules

The Shift Roster Modal (`shift-roster-modal`) allows participants to view roster occupancy while enforcing privacy boundaries:
- **Shift Managers & Admins**: Can view all registered volunteers' full names, custom avatar photos, group/club affiliations, email addresses, phone numbers, and privacy badges (`🌐 Public` / `🔒 Private`). In Admin Mode, administrators can cancel individual registrations or directly allocate open shift slots to registered volunteers.
- **Volunteers Viewing Roster**:
  - **Self Row**: Volunteers see their own registration marked with a `You` badge, their avatar photo, their group/club affiliation, their privacy status, and an inline link to edit profile settings.
  - **Public Profiles**: Volunteers see other registered crew members' names, custom avatar photos (or letter initials), and optional group/club affiliations. Contact details (email and mobile phone) are **never** exposed to volunteer viewers.
  - **Private Profiles**: Volunteers see an anonymous space (`🔒 Volunteer - Private Profile`) indicating that the shift slot is occupied, without revealing the volunteer's name, avatar photo, group, email, or phone.
  - **Shift Manager**: Volunteers see the assigned shift manager's name and avatar photo (or "Unassigned"); the manager's personal email is hidden from volunteer viewers.

### 6. `/blockedEmails/{emailId}`

Blacklist collection storing email addresses permanently blocked from registering or accessing the BrewCrew platform following administrative removal.

- **Document ID**: Normalized lowercase email address (e.g. `volunteer@example.com`).
- **Read Access**: Public (`allow read: if true;`), allowing the client-side pre-registration validator to check whether an email address is permitted to register.
- **Write Access**: `admin` only (`allow write: if isAdmin();`).

| Field | Type | Description |
| :--- | :--- | :--- |
| `email` | `string` | Lowercase email address permanently blacklisted from registration. |
| `originalUserId` | `string` | UID of the user account at the time it was deleted. |
| `fullName` | `string` | Volunteer display name at time of account deletion. |
| `reason` | `string` | Administrative justification recorded for the block. |
| `blockedAt` | `timestamp` | Server timestamp when the account was deleted and blocked. |
| `blockedBy` | `string` | UID of administrator who committed the block action. |
| `blockedByEmail` | `string` \| `null` | Email of administrator who committed the block action. |

### 7. `/inboundMessages/{messageId}`

Collection storing inbound WhatsApp inquiries and replies sent by volunteers to the BrewCrew dedicated Twilio bot number.

- **Document ID**: Auto-generated Firestore document ID.
- **Read Access**: Shift Managers and Administrators (`allow read: if isManager();`).
- **Write Access**: `admin` only (`allow write: if isAdmin();`). Inbound creation handled by Cloud Functions backend.

| Field | Type | Description |
| :--- | :--- | :--- |
| `from` | `string` | Normalized E.164 phone number of the volunteer. |
| `fromName` | `string` | Display name of the volunteer (fallback: `"Volunteer"`). |
| `userId` | `string` \| `null` | Firestore user ID in `/users` if identified. |
| `body` | `string` | Message content received from the volunteer. |
| `messageSid` | `string` \| `null` | Twilio message SID. |
| `receivedAt` | `timestamp` | Server timestamp when the webhook processed the message. |
| `status` | `string` | Message status: `"received"`. |
| `forwardedTo` | `string` \| `null` | Normalized E.164 phone number of the coordinator the message was forwarded to. |

### 8. `/groups/{groupId}`

Managed volunteer groups (clubs, CAMRA branches, brewery teams). Listed in the signup and "My Profile" group dropdowns and used for Admin Panel filtering and future Group Incentives.

- **Document ID**: Auto-generated Firestore document ID.
- **Read Access**: **Public** (`allow read: if true;`) so the signup screen can list groups before authentication.
- **Write Access**: None from clients (`allow write: if false;`). Created/updated only by [`onUserGroupWrite`](#2-onusergroupwrite) and the admin group callables (14–18).

| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Canonical display name (2–50 chars, trimmed, whitespace collapsed). |
| `nameKey` | `string` | Lowercased normalised name; unique lookup key used for de-duplication. |
| `includeInGroupIncentives` | `boolean` | Whether the group participates in the Group Incentives initiative. Defaults to `true`. Toggled in Admin Panel → Manage Groups. |
| `createdAt` | `timestamp` | Server timestamp when the group was created. |
| `createdBy` | `string` | Admin UID, or `"signup"` when auto-created from a volunteer's "Other…" entry. |
| `updatedAt` | `timestamp` | Server timestamp of last change. |
| `updatedBy` | `string` | UID of the administrator who last updated the group (absent for trigger-created groups). |

> [!NOTE]
> Member counts are not stored; the Admin Panel derives them client-side from `/users` (by `groupId`, falling back to normalised `groupOrClub` for unlinked legacy profiles).

---

## Firestore Security Rules Overview

While Cloud Functions execute using the Firebase Admin SDK (which bypasses security rules), direct client-side Firestore access is governed by [`firestore.rules`](../firestore.rules):

| Collection | Path | Read Rule | Write / Mutation Rule |
| :--- | :--- | :--- | :--- |
| `blockedEmails` | `/blockedEmails/{emailId}` | **Public** (`allow read: if true;`) | `admin` only (`isAdmin()`). Client registration checks blocked list; modifications restricted to administrators. |
| `config` | `/config/{configId}` | **Public** (`allow read: if true;`) | `admin` only (`isAdmin()`). Enables unauthenticated login screen branding (`/config/festival`), volunteer reward milestone configuration (`/config/incentives`), and public volunteer role guides (`/config/roles`) while guarding writes. |
| `groups` | `/groups/{groupId}` | **Public** (`allow read: if true;`) | **Denied** to all clients (`allow write: if false;`). Managed exclusively by `onUserGroupWrite` and admin group callables via the Admin SDK. |
| `users` | `/users/{userId}` | Authenticated users | Create: `volunteer` role only, `disabled == false`, `groupId` absent or `null`, and email must NOT exist in `/blockedEmails`. Update: profile fields only (including `whatsappNotifications`, `emailNotifications`, and `groupOrClub`); only `admin` can mutate `role`, `disabled`, `disabledAt`, `disabledBy`, `disabledReason`, `status`, or `groupId` (normally set server-side by `onUserGroupWrite` / `setUserGroup`). |
| `shifts` | `/shifts/{shiftId}` | Authenticated users | Create/Delete: `admin` only. Update: `admin` or assigned `manager` (manager fields only). |
| `registrations` | `/registrations/{regId}` | Authenticated users | `admin` only. Client writes disabled to prevent race conditions; mutations routed through `claimShift` / `cancelShift`. |
| `incentives` | `/incentives/{incId}` | Authenticated users | `admin` only. (Legacy fallback path; active incentive configuration stored in `/config/incentives`). |
| `inboundMessages` | `/inboundMessages/{msgId}` | `isManager()` | `admin` only. Client writes disabled; inbound WhatsApp volunteer replies logged via Cloud Functions. |


---

## Maintenance & Documentation Maintenance Policy

> [!IMPORTANT]
> **Ongoing Development Requirement**: Whenever modifications are made to any backend function in `functions/index.js`, new functions are added, or existing signatures/permissions change:
> 1. Update this document ([`docs/API.md`](./API.md)) immediately as part of the same pull request or commit.
> 2. Ensure all request parameters, response structures, permission requirements, and error codes match the implementation.
> 3. Verify that ESLint passes cleanly (`npm run lint` in `functions/`).
> 4. Test callable functions with both authorized and unauthorized user contexts.

This policy is enforced for all automated coding assistants via workspace rules in [`AGENTS.md`](../AGENTS.md).
