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
  - [4. `assignShiftManager`](#4-assignshiftmanager)
  - [5. `updateUserRole`](#5-updateuserrole)
  - [6. `sendAdminBroadcast`](#6-sendadminbroadcast)
- [Firestore Background Triggers](#firestore-background-triggers)
  - [1. `onRegistrationCreated`](#1-onregistrationcreated)
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
| `admin` | Festival Administrator | Full system access: create shifts (`createShift`), assign/reassign any manager (`assignShiftManager`), cancel any volunteer's shift bypassing lockout (`cancelShift`), update crew roles (`updateUserRole`), dispatch email announcements (`sendAdminBroadcast`). |

---

## Error Handling & Status Codes

All callable Cloud Functions throw `HttpsError` from `firebase-functions/v2/https`. Standard error codes used across the API:

| Code | HTTP Equivalent | Description |
| :--- | :--- | :--- |
| `unauthenticated` | 401 Unauthorized | Caller is not signed in with a valid Firebase Auth token. |
| `permission-denied` | 403 Forbidden | Caller does not possess the requisite role (`admin` or `manager`). |
| `invalid-argument` | 400 Bad Request | Missing or malformed parameters in `request.data`. |
| `not-found` | 404 Not Found | Referenced entity (shift, user, registration) does not exist. |
| `failed-precondition`| 412 Precondition Failed | Operation rejected due to state conflict (e.g. shift full, lockout window active, self-lockout). |
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

Cancels a shift registration. Enforces a strict 7-day lockout prior to the shift start time for standard volunteers, while allowing festival administrators to cancel any volunteer's shift at any time.

- **Trigger**: `onCall`
- **Permissions**:
  - **Self-cancellation**: Caller can cancel their own shift if `>= 7 days` remain before shift start.
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
   - **7-Day Lockout Check**: If caller is **not** an admin, checks `(shift.startTime - Date.now()) < 7 days (604,800,000 ms)`. If within 7 days, throws `failed-precondition` (`"Cannot cancel shifts within 7 days of shift start time."`).
   - Decrements `/shifts/{shiftId}.assignedCount` by `1` (clamped to minimum `0`).
   - Deletes `/registrations/{shiftId}_{targetUid}`.

---

### 3. `createShift`

Creates a new festival shift in the schedule database.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `dayIndex` | `number` / `string` | **Yes** | Integer between `1` and `7` indicating festival day. |
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
2. Validates `dayIndex` (`1 <= dayIndex <= 7`).
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
     dayIndex: Number(dayIndex),
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

### 4. `assignShiftManager`

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

### 5. `updateUserRole`

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

### 6. `sendAdminBroadcast`

Dispatches mass announcement emails to all registered volunteers and crew members via Nodemailer.

- **Trigger**: `onCall`
- **Permissions**: Administrator only (`role === "admin"`).

#### Request Parameters (`data`)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `subject` | `string` | **Yes** | Email subject line. |
| `body` | `string` | **Yes** | HTML or text content of the announcement. |

#### Response (`result`)

```json
{
  "success": true,
  "count": 42
}
```

#### Business Logic
1. Verifies caller role is `admin`.
2. Queries all documents in `/users`. Extracts distinct non-empty email addresses.
3. Retrieves `/config/festival` document to obtain dynamic `festivalName` (defaults to `"BrewCrew Volunteer Platform"`).
4. Uses Nodemailer with Gmail SMTP credentials (`GMAIL_EMAIL`, `GMAIL_PASS` from `functions/.env`), with sender formatted as `"${festivalName} <${gmailEmail}>"`.
5. Sends emails concurrently via `Promise.all` and returns the dispatched count.

---

## Firestore Background Triggers

### 1. `onRegistrationCreated`

Event-driven Cloud Function triggered whenever a volunteer registration is confirmed.

- **Trigger**: `onDocumentCreated("registrations/{registrationId}")`
- **Region**: `europe-west2`
- **Behavior**:
  1. Triggered automatically on document creation in `/registrations`.
  2. Retrieves corresponding `/users/{regData.userId}` and `/shifts/{regData.shiftId}` documents.
  3. Queries the `/config/festival` document to retrieve dynamic branding:
     - `festivalName` (default: `"BrewCrew Volunteer Portal"`)
     - `festivalWebsite` (default: `""`)
     - `festivalLogoUrl` (default: `""`)
     - `volunteerManager`: `{ name, email, phone }`
  4. Formats festival day, start time, end time, and shift duration.
  5. Injects dynamic branding, festival logo, portal link, and volunteer manager contact details into a personalized HTML confirmation email.
  6. Dispatches transactional email to `user.email` via Nodemailer.
  7. Catches and logs errors without obstructing database operations.

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
| `days` | `array` | List of configured session objects: `[{ dayIndex: number, date: string, name: string, description: string }]`. Supports multiple sessions per calendar day. |
| `updatedAt` | `timestamp` | Server timestamp when settings were last modified. |
| `updatedBy` | `string` | UID of administrator who committed the update. |

### 2. `/users/{userId}`

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
| `categories` | `/categories/{catId}` | Authenticated users | `admin` only. |
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
