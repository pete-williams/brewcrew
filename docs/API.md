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
- [Firestore Background Triggers](#firestore-background-triggers)
  - [1. `onRegistrationCreated` (Retired)](#1-onregistrationcreated-retired)
- [Firestore Data Models & Schemas](#firestore-data-models--schemas)
  - [1. `/config/festival`](#1-configfestival)
  - [2. `/shifts/{shiftId}`](#2-shiftsshiftid)
  - [3. `/users/{userId}`](#3-usersuserid)
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
| `volunteer` | Standard User | Register for open shifts (`claimShift`), cancel own shift with 7-day lockout (`cancelShift`), browse shifts. |
| `manager` | Elevated Staff | All volunteer actions + self-claim unassigned shift as manager (`assignShiftManager`), relinquish shift manager role, inspect volunteer roster. |
| `admin` | Festival Administrator | Full system access: create shifts (`createShift`), update shifts (`updateShift`), delete empty sessions (`deleteFestivalSession`), assign/reassign any manager (`assignShiftManager`), cancel any volunteer's shift bypassing lockout (`cancelShift`), update crew roles (`updateUserRole`), dispatch email announcements (`sendAdminBroadcast`). |

---

## Error Handling & Status Codes

All callable Cloud Functions throw `HttpsError` from `firebase-functions/v2/https`. Standard error codes used across the API:

| Code | HTTP Equivalent | Description |
| :--- | :--- | :--- |
| `unauthenticated` | 401 Unauthorized | Caller is not signed in with a valid Firebase Auth token. |
| `permission-denied` | 403 Forbidden | Caller does not possess the requisite role (`admin` or `manager`). |
| `invalid-argument` | 400 Bad Request | Missing or malformed parameters in `request.data` (e.g. non-existent `sessionId`). |
| `not-found` | 404 Not Found | Referenced entity (shift, session, user, registration) does not exist. |
| `failed-precondition`| 412 Precondition Failed | Operation rejected due to state conflict (e.g. shift full, lockout window active, session has assigned shifts, self-lockout). |
| `already-exists` | 409 Conflict | Duplicate booking or manager slot already filled. |
| `internal` | 500 Internal Server Error | Unexpected downstream error (e.g. SMTP transport failure). |

---

## Callable Functions Reference

### 1. `claimShift`

Registers an authenticated volunteer for an open festival shift atomically, ensuring no capacity overbooking occurs under concurrent requests.

- **Trigger**: `onCall`
- **Permissions**: Authenticated user (`volunteer`, `manager`, or `admin`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shiftId` | `string` | **Yes** | Firestore document ID of the shift in `/shifts`. |

#### Response (`result`)

```json
{
  "success": true
}
```

#### Business Logic & Concurrency
1. Executes within a Firestore transaction (`db.runTransaction`).
2. Reads `/shifts/{shiftId}`. Throws `not-found` if the shift does not exist.
3. Compares `shift.assignedCount >= shift.capacity`. If full, throws `failed-precondition` (`"This shift is already full."`).
4. Checks `/registrations/{shiftId}_{uid}`. If a registration exists with `status: "confirmed"`, throws `already-exists` (`"You are already registered for this shift."`).
5. Atomically executes:
   - Increments `/shifts/{shiftId}.assignedCount` by `1`.
   - Writes `/registrations/{shiftId}_{uid}`:
     ```json
     {
       "shiftId": "shift123",
       "userId": "user456",
       "registeredAt": "FieldValue.serverTimestamp()",
       "status": "confirmed"
     }
     ```

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

Dispatches mass announcement emails to volunteers or crew members via Nodemailer. Accessible directly from the **Admin Panel** or via backend callable API.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `subject` | `string` | **Yes** | Email subject line. |
| `body` | `string` | **Yes** | HTML or text content of the announcement (paragraphs and line breaks formatted automatically). |
| `targetRole` | `string` | No | Target recipient filter: `"volunteer"` (all volunteers), `"manager"`, or `"all"` (all crew members). Defaults to all users if omitted. |

#### Response (`result`)

```json
{
  "success": true,
  "count": 42
}
```

#### Business Logic
1. Verifies caller role is `admin`.
2. Queries documents in `/users`, applying `role == targetRole` filter when `targetRole && targetRole !== "all"`. Extracts distinct non-empty email addresses.
3. Retrieves `/config/festival` document to obtain dynamic `festivalName` (defaults to `"BrewCrew Updates"`).
4. Uses Nodemailer with Gmail SMTP credentials (`GMAIL_EMAIL`, `GMAIL_PASS` from `functions/.env`), with sender formatted as `"${festivalName} <${gmailEmail}>"`.
5. Sends emails concurrently via `Promise.all` and returns the dispatched count.

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

## Firestore Background Triggers

### 1. `onRegistrationCreated` (Retired)

> [!NOTE]
> **Status: Retired / Disabled**
> The automatic transactional email confirmation upon shift registration has been retired as shift registration confirmation emails are no longer required. The Nodemailer email transport infrastructure and administrative broadcast capability ([`sendAdminBroadcast`](#7-sendadminbroadcast)) remain active for volunteer announcements from the Admin Panel.

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

### 2. `/shifts/{shiftId}`

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

### 3. `/users/{userId}`

User profile document created upon initial registration or OAuth sign-in.

| Field | Type | Description |
| :--- | :--- | :--- |
| `fullName` | `string` | Full name of the volunteer or crew member. |
| `email` | `string` | Registered email address (lowercase). |
| `phoneNumber` | `string` | **Mandatory** contact phone number required on registration and onboarding. |
| `role` | `string` | Access tier: `"volunteer"`, `"manager"`, or `"admin"`. |
| `createdAt` | `timestamp` | Server timestamp when the user profile was initialized. |

---

## Firestore Security Rules Overview

While Cloud Functions execute using the Firebase Admin SDK (which bypasses security rules), direct client-side Firestore access is governed by [`firestore.rules`](../firestore.rules):

| Collection | Path | Read Rule | Write / Mutation Rule |
| :--- | :--- | :--- | :--- |
| `config` | `/config/{configId}` | **Public** (`allow read: if true;`) | `admin` only (`isAdmin()`). Enables unauthenticated login screen branding while guarding writes. |
| `users` | `/users/{userId}` | Authenticated users | Create only as `volunteer`; update profile only; only `admin` can mutate `role`. |
| `shifts` | `/shifts/{shiftId}` | Authenticated users | Create/Delete: `admin` only. Update: `admin` or assigned `manager` (manager fields only). |
| `registrations` | `/registrations/{regId}` | Authenticated users | `admin` only. Client writes disabled to prevent race conditions; mutations routed through `claimShift` / `cancelShift`. |
| `incentives` | `/incentives/{incId}` | Authenticated users | `admin` only. |

---

## Maintenance & Documentation Maintenance Policy

> [!IMPORTANT]
> **Ongoing Development Requirement**: Whenever modifications are made to any backend function in `functions/index.js`, new functions are added, or existing signatures/permissions change:
> 1. Update this document ([`docs/API.md`](./API.md)) immediately as part of the same pull request or commit.
> 2. Ensure all request parameters, response structures, permission requirements, and error codes match the implementation.
> 3. Verify that ESLint passes cleanly (`npm run lint` in `functions/`).
> 4. Test callable functions with both authorized and unauthorized user contexts.

This policy is enforced for all automated coding assistants via workspace rules in [`AGENTS.md`](../AGENTS.md).
