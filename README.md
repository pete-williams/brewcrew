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
* **Interactive 7-Day Schedule Grid:** Filter shifts across 7 festival days and specific area categories (dynamically derived from active shifts, supporting arbitrary custom areas).
* **Atomic Shift Booking:** Powered by Firestore transactions in Cloud Functions (`claimShift`) to eliminate race conditions and overbooking during registration bursts.
* **My Shifts Dashboard:** Real-time personal schedule with built-in cancellation enforcement.
* **7-Day Lockout Rule:** Prevents volunteers from cancelling shifts within 7 days of the shift start time, ensuring reliable staffing levels.
* **Incentive Progress Tracker:** Dynamic visual progress bar tracking accumulated volunteer hours against milestone rewards:
  * **4 Hours:** Free Festival Entry
  * **8 Hours:** Entry Pass + Festival Volunteer T-Shirt
* **Automated Confirmations:** Event-driven Cloud Function (`onRegistrationCreated`) dispatches transactional email confirmations upon booking.

### 2. Shift Manager Experience
* **Self-Service Shift Claiming:** Qualified shift managers can claim unassigned shifts (`assignShiftManager`) to lead specific bars or areas (strictly 1 manager per shift).
* **Shift Roster Oversight:** Managers can view attendee rosters for their assigned shifts.
* **Manager Relinquish:** Managers can unassign themselves if their availability changes prior to the event.

### 3. Administrator Console
* **Schedule & Shift Builder:** Create new festival shifts with customizable capacity, start/end dates and times, festival day index (1–7), and optional manager pre-assignment.
* **Volunteer Roster & Admin Overrides:** View registered volunteers on any shift and administratively cancel registrations when needed (bypassing the 7-day lockout).
* **Crew Member Directory & RBAC:**
  * Real-time search across all crew members by name or email.
  * Role filtering (`volunteer`, `manager`, `admin`).
  * Dynamic role promotion/demotion (`updateUserRole`) with safeguards preventing admins from accidentally revoking their own admin access.
* **Mass Communication Broadcast:** Cloud Function endpoint (`sendAdminBroadcast`) allowing admins to dispatch email announcements to the volunteer crew.

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
                            │  • sendAdminBroadcast      │
                            │  • onRegistrationCreated   │
                            └────────────┬───────────────┘
                                         │
                                         ▼
                            ┌────────────────────────────┐
                            │ Nodemailer (Gmail / SMTP)  │
                            └────────────────────────────┘
```

* **Frontend:** Vanilla JavaScript SPA with Tailwind CSS and Firebase Web SDK (v10 Compat).
* **Backend:** Firebase Cloud Functions 2nd Gen running on Node.js 24 runtime with Firebase Admin SDK.
* **Database:** Cloud Firestore (`europe-west2`) secured with granular declarative security rules (`firestore.rules`).
* **Authentication:** Firebase Authentication supporting both Email & Password (with self-service password reset) and Google Sign-In, gated behind a strict authentication gateway.
* **Hosting:** Firebase Hosting with SPA rewrites (`/index.html`) and cache-invalidation headers.
* **Email Service:** Nodemailer configured for Gmail / Google Workspace SMTP.
* **API Documentation:** Comprehensive specifications for all Cloud Functions and endpoints are documented in [`docs/API.md`](docs/API.md).

---

## 🗄 Database Schema & Collections

| Collection | Document ID | Key Fields | Description |
| :--- | :--- | :--- | :--- |
| `users` | `{userId}` | `fullName`, `email`, `role`, `createdAt`, `updatedAt` | User profile and RBAC permissions (`volunteer`, `manager`, `admin`). |
| `shifts` | `{shiftId}` | `sessionId`, `categoryName`, `capacity`, `assignedCount`, `startTime`, `endTime`, `managerId`, `managerName`, `managerEmail` | Shift inventory, timestamps, categoryName area, and assigned area manager. |
| `registrations` | `{shiftId}_{userId}` | `shiftId`, `userId`, `status`, `registeredAt` | Composite-key join mapping volunteer bookings to shifts. |
| `incentives` | `{incentiveId}` | `hoursRequired`, `rewardName` | Reward tier threshold definitions. |

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
│   └── API.md                 # Cloud Functions & API documentation
├── functions/                 # Backend Cloud Functions (2nd Gen)
│   ├── .env                   # SMTP secrets (GMAIL_EMAIL, GMAIL_PASS) - NOT committed
│   ├── .env.example           # Template for environment configuration
│   ├── .eslintrc.js           # ESLint configuration (Google styleguide)
│   ├── .gitignore             # Node modules and environment ignore rules
│   ├── index.js               # Cloud Functions entrypoint & callable handlers
│   ├── package.json           # Backend dependencies (Node 24)
│   └── package-lock.json
└── public/                    # Frontend client assets
    ├── firebase-config.js     # Client Firebase keys - NOT committed (ignored by Git)
    ├── firebase-config.example.js # Template for frontend Firebase credentials
    ├── app.js                 # SPA logic, state management, and Firebase handlers
    └── index.html             # UI layout, views, and modal dialogs (Tailwind CSS)
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

This repository keeps all credentials and secrets out of version control via `.gitignore`. You must configure both the frontend and backend credentials:

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

#### B. Backend Secrets (`functions/.env`)
Copy the backend environment template:
```bash
cp functions/.env.example functions/.env
```
Populate your SMTP email credentials in `functions/.env`:
```ini
GMAIL_EMAIL=volunteer-coordinator@example.com
GMAIL_PASS=your-google-app-password
```
*(Note: If using Gmail 2-Step Verification, generate and use a Google Account App Password).*

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
