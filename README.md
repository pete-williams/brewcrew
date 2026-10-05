# BrewCrew Volunteer Management Platform

[![Firebase](https://img.shields.io/badge/Firebase-v10-orange.svg)](https://firebase.google.com/)
[![Cloud Functions](https://img.shields.io/badge/Cloud%20Functions-2nd%20Gen%20(Node%2024)-blue.svg)](https://firebase.google.com/docs/functions)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-v3-38B2AC.svg)](https://tailwindcss.com/)

A modern, responsive Single Page Application (SPA) designed to manage volunteer scheduling, role-based access control, shift availability, and reward milestone tracking for multi-day festival events.

---

## 📌 Overview

The **BrewCrew Platform** streamlines volunteer coordination for beer and cider festivals. It provides self-service shift registration for volunteers, shift oversight for on-site managers, and full schedule and user management for festival administrators. Concurrency-safe Firestore transactions guarantee shifts cannot be overbooked, while automated background triggers handle email confirmations and communications.

---

## 🚀 Key Features

### 1. Volunteer Portal
* **Interactive Multi-Day Schedule & Smart Grouping:** Filter shifts across festival days and specific area categories (supporting arbitrary custom areas). Features a dual-mode View Switcher (**By Time Slot** vs. **By Area**) with local preference persistence, an interactive **Time Jump** quick-nav bar for fast scrolling to specific start times across ~50 concurrent shifts, smart accordions that auto-expand available shifts while collapsing filled slots, and prominent booked-shift banners.
* **Atomic Shift Booking & Overlap Protection:** Powered by Firestore transactions in Cloud Functions (`claimShift`) to eliminate race conditions and overbooking. Automatically detects and prevents overlapping or simultaneous shift bookings for the same volunteer.
* **My Shifts Dashboard:** Real-time personal schedule with built-in cancellation enforcement.
* **7-Day Lockout Rule:** Prevents volunteers from cancelling shifts within 7 days of the shift start time, ensuring reliable staffing levels.
* **Floating Pint Glass Incentive Tracker:** An interactive pint glass Floating Action Button (FAB) in the bottom-right corner that fills with golden ale as volunteers register for shift hours, crowning with a frothy foam head and celebration glow at 100%. Clicking reveals an anchored roadmap popover (or bottom sheet on mobile) displaying current progress, status badges (*Unlocked* 🍺, *Next Goal* 🎯, *Locked* 🔒), and configurable guest welcome explanation messaging.
* **Automated Confirmations:** Event-driven Cloud Function (`onRegistrationCreated`) dispatches transactional email confirmations upon booking.
* **User Profile & Group/Club Affiliation:** Dedicated "My Profile" modal and account registration workflow enabling volunteers to update contact details, select a Group or Club affiliation from an auto-populated list of established groups or dynamically register a new one ("Other..."), and configure Roster Profile Visibility (`public` vs. `private`). Free-text entries are seamlessly reconciled server-side to canonical managed groups (`groupId`) via the `onUserGroupWrite` background trigger. Includes custom profile photo uploads with in-browser square auto-crop and compression.
* **Shift Roster Viewing with Privacy Protection:** Volunteers can view who is scheduled on any shift. Public profiles display member names, club badges, and photos; private profiles display as anonymous spaces (`🔒 Volunteer - Private Profile`). Contact details (email and phone) are strictly masked from volunteer viewers.

### 2. Shift Manager Experience
* **In-Roster Shift Claiming & Relinquish:** Qualified shift managers can claim unassigned shifts (`assignShiftManager`) directly within the Shift Roster modal and release shifts back to unassigned status if their availability changes.
* **Full Shift Roster Oversight:** Managers can view complete attendee rosters with verified contact information (email addresses and phone numbers) for operational coordination and safety.

### 3. Administrator Console
* **Admin Mode UI Toggle:** Administrators default to Manager View upon sign-in for an uncluttered operational workflow, with an interactive toggle switch to enter Admin Mode and access privileged administrative controls.
* **Schedule & Shift Builder:** Create and edit festival shifts with customizable capacity, start/end dates and times, session assignments, and optional manager pre-assignment.
* **Volunteer Roster & Admin Overrides:** View registered volunteers on any shift and administratively cancel registrations when needed (bypassing the 7-day lockout).
* **Crew Member Directory & RBAC:**
  * Real-time search across all crew members by name, email, phone, or group.
  * Role filtering (`volunteer`, `manager`, `admin`) and account status filtering (`active`, `disabled`).
  * Custom avatar thumbnail and distinct color-coded group badge display.
  * Dynamic role promotion/demotion (`updateUserRole`) with safeguards preventing admins from accidentally revoking their own admin access.
  * 1-click modal for individual volunteer group assignment (`setUserGroup`).
* **Group Management & Incentive Eligibility:**
  * Dedicated **Manage Groups** portal to create, rename, merge, and delete volunteer groups/clubs (CAMRA branches, brewery teams, sponsor crews).
  * Automatic synchronization: Renaming or merging groups instantly updates all associated volunteer profiles.
  * Group Incentives initiative toggle per group (`includeInGroupIncentives`), enabling administrators to include or exclude specific groups from volunteer group reward programs.
  * Flexible group filtering in the crew directory (filter by specific group, "No group", or "All groups" with live member counts), plus "Group (A → Z)" sorting.
  * Recognition and 1-click import of legacy or unlinked group names from existing user profiles.
* **Omnichannel Communications Console:** Unified dispatcher supporting both **Email** and **WhatsApp** broadcasts:
  * 5-tier audience targeting (`all`, `role`, `category`, `shift`, `users` with searchable multi-select picker).
  * Filter toggle to message only volunteers with confirmed shifts.
  * Real-time audience breakdown strip (matching count, channel-ready count, opted-out/missing-contact count).
  * Dynamic placeholder tags (`{{name}}`, `{{first_name}}`, `{{category}}`, `{{date}}`, `{{time}}`, and `{{all_shifts}}` chronological schedule builder).
  * Live dual preview (rendered HTML email and simulated WhatsApp smartphone chat bubble).
  * Safety pre-flight review modal and recent dispatches audit log.
* **1-Tap WhatsApp Roster Links:** Area managers and coordinators can launch direct WhatsApp chats (`wa.me`) with scheduled crew members with a single tap.
* **Two-Way Reply Webhook:** Inbound volunteer replies to the festival WhatsApp number are logged and auto-forwarded to the Volunteer Coordinator's mobile phone with a 1-tap direct reply link.

---

## 🏗 Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│           Frontend Single Page Application             │
│        (HTML5, Tailwind CSS, Firebase Web SDK)         │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
┌─────────────────────────┐ ┌────────────────────────────┐
│ Firebase Authentication │ │   Cloud Firestore (NoSQL)  │
│     (Google OAuth)      │ │  Rules: RBAC & Validation  │
└─────────────────────────┘ └────────────┬───────────────┘
                                         │
                                         ▼
                            ┌────────────────────────────┐
                            │ Cloud Functions (2nd Gen)  │
                            │  • claimShift              │
                            │  • cancelShift             │
                            │  • assignShiftManager      │
                            │  • createShift             │
                            │  • updateUserRole          │
                            │  • createGroup             │
                            │  • updateGroup             │
                            │  • mergeGroups             │
                            │  • deleteGroup             │
                            │  • setUserGroup            │
                            │  • onUserGroupWrite        │
                            │  • sendAdminBroadcast      │
                            │  • sendWhatsAppBroadcast   │
                            │  • twilioWhatsAppWebhook   │
                            │  • onRegistrationCreated   │
                            └──────┬──────────────┬──────┘
                                   │              │
                                   ▼              ▼
                      ┌──────────────────┐ ┌──────────────────┐
                      │ Nodemailer (SMTP)│ │ Twilio WhatsApp  │
                      └──────────────────┘ └──────────────────┘
```

* **Frontend:** Vanilla JavaScript SPA with Tailwind CSS and Firebase Web SDK (v10 Compat).
* **Backend:** Firebase Cloud Functions 2nd Gen running on Node.js 24 runtime with Firebase Admin SDK.
* **Database:** Cloud Firestore (`europe-west2`) secured with granular declarative security rules (`firestore.rules`).
* **Authentication:** Firebase Authentication supporting both Email & Password (with self-service password reset) and Google Sign-In, gated behind a strict authentication gateway.
* **Hosting:** Firebase Hosting with SPA rewrites (`/index.html`) and cache-invalidation headers.
* **Email Service:** Nodemailer configured for Gmail / Google Workspace SMTP.
* **WhatsApp Messaging:** Twilio Programmable Messaging API for transactional alerts, targeted broadcasts, and two-way inbound webhooks.
* **API Documentation:** Comprehensive specifications for all Cloud Functions, webhooks, and endpoints are documented in [`docs/API.md`](docs/API.md).

---

## 🗄 Database Schema & Collections

| Collection | Document ID | Key Fields | Description |
| :--- | :--- | :--- | :--- |
| `users` | `{userId}` | `fullName`, `email`, `phoneNumber`, `whatsappNotifications`, `emailNotifications`, `groupId`, `groupOrClub`, `profileVisibility`, `photoURL`, `role`, `disabled`, `status`, `createdAt`, `updatedAt` | User profile, contact details, notification preferences, server-resolved `groupId` and canonical `groupOrClub` affiliation, roster privacy mode, avatar Data URL, and RBAC permissions (`volunteer`, `manager`, `admin`). |
| `groups` | `{groupId}` | `name`, `nameKey`, `includeInGroupIncentives`, `createdBy`, `createdAt`, `updatedAt`, `updatedBy` | Managed volunteer groups (clubs, CAMRA branches, brewery teams) with group incentive participation flag. Publicly readable for registration picker; write-protected and managed exclusively via Cloud Functions / Admin SDK. |
| `shifts` | `{shiftId}` | `sessionId`, `categoryName`, `capacity`, `assignedCount`, `startTime`, `endTime`, `managerId`, `managerName`, `managerEmail` | Shift inventory, timestamps, categoryName area, and assigned area manager. |
| `registrations` | `{shiftId}_{userId}` | `shiftId`, `userId`, `status`, `registeredAt` | Composite-key join mapping volunteer bookings to shifts. |
| `config` | `festival`, `incentives`, `roles` | `festivalName`, `volunteerManager`, `sessions`, `items` (`hoursRequired`, `rewardName`), `roles` (area briefing guides) | Festival branding, Coordinator contact for message forwarding, schedule sessions, milestone reward definitions, and volunteer role guides. |
| `inboundMessages` | `{messageId}` | `from`, `body`, `userId`, `userName`, `coordinatorPhone`, `forwardedStatus`, `timestamp` | Audit log of volunteer WhatsApp replies received via webhook and forwarded to the Coordinator. |

---

## 📂 Repository Structure

```
brewcrew-platform/
├── .firebaserc                # Active Firebase project configuration
├── firebase.json              # Hosting, Firestore, and Functions deployment specs
├── firestore.rules            # Declarative database security & RBAC rules
├── firestore.indexes.json     # Firestore composite index definitions
├── README.md                  # Project documentation
├── AGENTS.md                  # Workspace rules and documentation maintenance policy
├── docs/                      # Technical documentation
│   ├── API.md                 # Cloud Functions & API documentation
│   └── WHATSAPP_INTEGRATION_PLAN.md # Omnichannel communications integration plan
├── functions/                 # Backend Cloud Functions (2nd Gen)
│   ├── .env                   # Secrets (GMAIL SMTP, TWILIO API) - NOT committed (git-ignored)
│   ├── .env.example           # Template for environment configuration
│   ├── .eslintrc.js           # ESLint configuration (Google styleguide)
│   ├── .gitignore             # Strict ignore rules (.env, .env.*, node_modules)
│   ├── index.js               # Cloud Functions entrypoint & callable handlers
│   ├── package.json           # Backend dependencies (Node 24, twilio, nodemailer)
│   └── package-lock.json
└── public/                    # Frontend client assets
    ├── firebase-config.js     # Client Firebase keys - NOT committed (git-ignored)
    ├── firebase-config.example.js # Template for frontend Firebase credentials
    ├── app.js                 # Volunteer SPA logic, state management, and handlers
    ├── admin.html             # Admin & manager console (Communications, Shifts, Crew, Groups)
    ├── admin.js               # Admin console controller & omnichannel UI handlers
    ├── index.html             # Volunteer portal views and modals (Tailwind CSS)
    └── roles.html             # Public role guides & shift area briefings
```

---

## 🛠 Local Setup & Development

### 1. Prerequisites
* [Node.js](https://nodejs.org/) (version 20 or 24 recommended)
* [Firebase CLI](https://firebase.google.com/docs/cli):
  ```bash
  npm install -g firebase-tools
  ```
* A Google Firebase project with Authentication, Firestore, and Cloud Functions enabled.

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/pete-williams/brewcrew.git
cd brewcrew

# Install functions dependencies
cd functions
npm install
cd ..
```

### 3. Configure Secrets & Project Credentials

> [!IMPORTANT]
> **Zero-Leak Credential Policy:**
> * All API keys, tokens, and credentials are kept strictly out of version control via `.gitignore` rules (`.env`, `.env.*`, and `public/firebase-config.js`).
> * **Twilio secrets and SMTP credentials MUST NEVER be placed in client-side code** (`public/index.html`, `public/admin.html`, `public/app.js`, etc.). They are read exclusively server-side inside Cloud Functions via `process.env`.
> * Only sanitized templates (`functions/.env.example` and `public/firebase-config.example.js`) are committed to Git with placeholder dummy values.

---

#### A. Frontend Configuration (`public/firebase-config.js`)
Copy the frontend template:
```bash
cp public/firebase-config.example.js public/firebase-config.js
```
Open `public/firebase-config.js` and fill in your Firebase Web App configuration from the [Firebase Console](https://console.firebase.google.com/) (*Project Settings > General > Your apps*):
```javascript
window.firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

---

#### B. Backend Secrets Setup (`functions/.env`)
Copy the backend environment template:
```bash
cp functions/.env.example functions/.env
```
Open `functions/.env` and configure both the SMTP email and Twilio WhatsApp credentials:
```ini
# Gmail SMTP Credentials for Nodemailer
GMAIL_EMAIL=volunteer-coordinator@example.com
GMAIL_PASS=your-google-app-password

# Twilio WhatsApp API Credentials
# Account SID (starts with AC...) - always required to identify the account
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Option 1: API Key Authentication (Recommended by Twilio for security & rotation)
TWILIO_API_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=your_twilio_api_key_secret

# Option 2: Auth Token Authentication (Legacy fallback)
# TWILIO_AUTH_TOKEN=your_twilio_auth_token

TWILIO_WHATSAPP_NUMBER=whatsapp:+44xxxxxxxxxx
```

> [!NOTE]
> * **Gmail:** If using Gmail 2-Step Verification, generate a dedicated 16-character [Google Account App Password](https://myaccount.google.com/apppasswords) rather than your personal password.
> * **Twilio API Keys:** Twilio strongly recommends using API Keys (`SK...`) instead of root Auth Tokens for security, scoped permissions, and easy rotation. `TWILIO_ACCOUNT_SID` (`AC...`) is still required alongside your API Key to route requests.
> * **Git Protection:** `functions/.env` is ignored by both `functions/.gitignore` and the root `.gitignore`. It will **never** be included in Git commits.

---

#### C. Twilio WhatsApp API Setup Guide

Follow these steps to obtain and configure your Twilio credentials:

##### Step 1: Create a Twilio Account & Retrieve Credentials
1. Sign up or log into the [Twilio Console](https://console.twilio.com/).
2. On your Twilio Console Dashboard under **Account Info**, copy your **Account SID** (starts with `AC...`).
3. **Generate an API Key (Recommended):**
   * In Twilio Console, navigate to **Account > API keys & tokens** (or search for *API Keys*).
   * Click **Create API Key**.
   * Give it a friendly name (e.g., `BrewCrew Platform`).
   * Twilio will generate a **SID** (starts with `SK...`) and a **Secret**.
   * Paste these into `functions/.env`:
     ```ini
     TWILIO_ACCOUNT_SID=AC...
     TWILIO_API_SID=SK...
     TWILIO_API_KEY=...
     ```
   *(Alternatively, you can provide `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` if using legacy auth token).*

##### Step 2: Choose Your WhatsApp Number (Sandbox vs. Production)

* **For Development & Testing (Twilio Sandbox):**
  1. In the Twilio Console, navigate to **Messaging > Try it out > Send a WhatsApp message**.
  2. Note the sandbox phone number (typically `+1 415 523 8886`) and the join phrase (e.g., `join <keyword>`).
  3. Send the join phrase from your personal phone via WhatsApp to the sandbox number to activate receiving test messages.
  4. In `functions/.env`, set:
     ```ini
     TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
     ```

* **For Production (Live Festival):**
  1. In the Twilio Console, navigate to **Messaging > Senders > WhatsApp Senders**.
  2. Register and verify your organization's business phone number via Meta Business Manager.
  3. Once approved, set your production number in `functions/.env` in full E.164 format with the `whatsapp:` prefix:
     ```ini
     TWILIO_WHATSAPP_NUMBER=whatsapp:+447123456789
     ```

##### Step 3: Configure Inbound Webhook (2-Way Replies & Auto-Forwarding)
BrewCrew provides an automated two-way webhook (`twilioWhatsAppWebhook`) that handles replies from volunteers. When a volunteer replies to any automated alert or broadcast:
1. The message is logged in Firestore under `/inboundMessages`.
2. The message is automatically forwarded to the Festival Volunteer Coordinator's WhatsApp with a 1-tap `wa.me` direct reply link.
3. An automated acknowledgment is sent back to the volunteer.

**To configure the webhook in Twilio:**
1. In the Twilio Console:
   * **If using Sandbox:** Go to **Messaging > Settings > WhatsApp Sandbox Settings**.
   * **If using Production Sender:** Go to **Messaging > Senders > WhatsApp Senders** and click your number.
2. Locate the field **"WHEN A MESSAGE COMES IN"**.
3. Set the webhook URL to your deployed Cloud Function endpoint:
   ```text
   https://<region>-<project-id>.cloudfunctions.net/twilioWhatsAppWebhook
   ```
   *(e.g., `https://europe-west2-brewcrew-festival.cloudfunctions.net/twilioWhatsAppWebhook`)*
4. Ensure the HTTP method is set to **`HTTP POST`**.
5. Save the settings.

> [!TIP]
> **Testing Webhooks Locally:** To receive inbound webhook events while running local emulators, start a tunnel using `ngrok http 5001` and set your Twilio webhook URL to:
> `https://<ngrok-id>.ngrok-free.app/<project-id>/<region>/twilioWhatsAppWebhook`

##### Step 4: Configure Coordinator Forwarding Phone in Firestore
In your Firestore database, ensure the `/config/festival` document contains the Coordinator's mobile number:
```json
{
  "festivalName": "BrewCrew Beer & Cider Festival",
  "coordinatorPhone": "+447987654321"
}
```
All volunteer replies received by the Twilio webhook will automatically forward to this phone number.

---

#### D. Git Security Verification
To guarantee that no secrets or environment files are tracked by Git, run this verification command:
```bash
git check-ignore -v functions/.env functions/.env.local public/firebase-config.js
```
The output should confirm that all credential files are ignored by `.gitignore`:
```text
functions/.gitignore:3:.env    functions/.env
functions/.gitignore:4:.env.*  functions/.env.local
.gitignore:14:public/firebase-config.js  public/firebase-config.js
```

Before committing any changes, always verify with `git status` that no `.env` or configuration files appear under "Untracked files" or "Changes to be committed".

### 4. Local Emulator Suite (Optional)
To test functions and Firestore locally:
```bash
firebase emulators:start
```

### 5. Deployment
Deploy all services (Hosting, Functions, Firestore rules) to your Firebase project:
```bash
firebase login
firebase use default
firebase deploy
```

> [!NOTE]
> `firebase deploy` deploys `public/firebase-config.js` directly to Firebase Hosting so your production site works seamlessly, while Git completely ignores the file so it is never pushed to GitHub.

To deploy specific components:
```bash
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules
```

---

## 🤖 Development & Contribution Guidelines

When developing or refactoring within this repository, follow these core principles:

1. **Cloud Functions v2:** Always use Firebase Functions 2nd Gen API (`firebase-functions/v2/https`, `firebase-functions/v2/firestore`). Do not use legacy v1 imports.
2. **Environment Configuration:** Never use deprecated `functions.config()`. Always read secrets and config via `process.env` backed by `functions/.env`.
3. **Atomic Operations:** Any mutation affecting shift registration counts (`assignedCount`) or manager assignment must be executed inside a Firestore transaction (`runTransaction`) within Cloud Functions to prevent desynchronization.
4. **Security Rules Alignment:** Client-side updates in `public/app.js` must adhere to `firestore.rules`. Sensitive operations (such as registration creation, cancellation, and role modification) must route through backend callable functions with Admin SDK execution.
5. **Lockout Policy:** Maintain the 7-day cancellation lockout check in both backend validation (`cancelShift`) and client UI state.

---

## 📄 License

This project is licensed for the BrewCrew Festival Volunteer Organization. All rights reserved.
