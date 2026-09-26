# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** Beer/cider festival enthusiasts and CAMRA members who volunteer at multi-day events. They sign up and manage their own shifts independently — from home, on a phone or laptop — well before the festival weekend. They are self-motivated, digitally comfortable, and expect a smooth self-service experience without needing to contact the organiser.

**Secondary:** On-site shift managers who oversee and coordinate volunteers during the event. They use the platform operationally, primarily on the day, to view rosters and claim/release shift management assignments.

**Tertiary:** Festival administrators (typically a small committee) who build the schedule, manage the crew, and broadcast communications.

## Product Purpose

BrewCrew is a volunteer management platform for beer and cider festivals. It exists to replace the coordination overhead of spreadsheets and email chains with a fully self-service booking system: volunteers find shifts, claim them, track their progress, and manage cancellations entirely without organiser involvement. Success means a festival's volunteer coordinator spends zero time on routine booking logistics, and every volunteer knows exactly where they stand.

## Positioning

BrewCrew's meaningful difference is end-to-end volunteer self-service backed by concurrency-safe booking: atomic Firestore transactions guarantee no shift is overbooked or double-booked even at peak sign-up moments, while the role hierarchy (volunteer / manager / admin) gives every participant exactly the right access surface without manual intervention.

## Operating Context

- Volunteers sign up from home in the days or weeks before the festival; the critical usage window is the booking announcement through to the event weekend.
- On the day, managers use the platform on mobile for roster lookups and shift coordination; admins may make last-minute schedule or roster changes.
- Typical scale: 50–150 volunteers, 50–200 shifts across 2–4 days.
- The platform is currently deployed for a single annual BrewCrew festival, with a future intention to be published for other charity and not-for-profit festival organisations (multi-tenant white-label use).
- Festival name, branding, and incentive configuration are admin-configurable; the product name "BrewCrew" is fixed.
- Email (Gmail/SMTP via Nodemailer) handles booking confirmations and admin broadcasts.

## Capabilities and Constraints

- **Stack:** HTML5 SPA, Vanilla JavaScript, Tailwind CSS v3, Firebase Web SDK (v10 compat), Firebase Hosting, Cloud Firestore (europe-west2), Cloud Functions 2nd Gen (Node 24), Firebase Authentication (Email/Password + Google Sign-In).
- **Booking integrity:** All registration mutations (claim, cancel, manager assignment) run inside Firestore transactions in Cloud Functions to prevent race conditions.
- **Cancellation lockout:** 7-day pre-shift lockout enforced server-side in `cancelShift`; admins can bypass.
- **RBAC:** Three roles — `volunteer`, `manager`, `admin` — enforced server-side in Cloud Functions and Firestore security rules; client-side role checks are UI convenience only.
- **Profile privacy:** Volunteers control roster visibility (`public` / `private`); contact details (email, phone) are hidden from non-manager volunteer views.
- **Incentive tracker:** A configurable pint glass FAB fills as volunteers accumulate shift hours, with milestone rewards defined in the `config/incentives` Firestore document.
- **Volunteer role guides:** Shift areas map 1-to-1 to volunteer roles; admins configure guidelines and briefings via a popout WYSIWYG editor stored in `config/roles`, viewable directly on shift rosters and via a dedicated public `roles.html` catalog.
- **Multi-tenant future:** Festival name, sessions, and incentive configuration are per-deployment; the product identity "BrewCrew" is the fixed umbrella name.
- **No accessibility standard mandated** beyond general good practice.

## Brand Commitments

- **Product name:** "BrewCrew" — fixed and not configurable per deployment.
- **Festival identity** (name, logo, colour scheme) is fully configurable by administrators via Firestore `config/festival`.
- Existing visual implementation (Tailwind CSS, amber/dark palette, pint glass motif) is the current incumbent design authority.

## Evidence on Hand

- Full working codebase: `public/index.html`, `public/app.js`, `functions/index.js`.
- Architecture and feature documentation in `README.md`.
- Cloud Functions API specification in `docs/API.md`.
- Firestore schema and security rules in `firestore.rules` and `firestore.indexes.json`.
- No real testimonials, press, or benchmark data on file — future work must not fabricate these.

## Product Principles

1. **Self-service first.** Every volunteer action — browsing, booking, cancelling, tracking rewards — must be completable without contacting the organiser.
2. **Trust through reliability.** Booking integrity (no overbooking, no data loss) is non-negotiable; every write that affects shift capacity runs in a transaction.
3. **Right access, right surface.** Volunteers, managers, and admins each see exactly what their role requires — no more, no less — without configuration per user.
4. **Festival personality.** The product accommodates the fun, community culture of beer festivals: the gamified tracker, the pint glass motif, and configurable festival branding are features, not frivolity.
5. **Open for adoption.** Design and architecture decisions should not lock the platform to one event; configuration surfaces should make it easy for another charity festival to deploy their own instance.
