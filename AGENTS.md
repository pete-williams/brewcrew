# Workspace Guidelines & Rules for BrewCrew Platform

## 1. API Documentation Maintenance Policy

**CRITICAL REQUIREMENT**: The API documentation located at `docs/API.md` must be kept strictly up to date with all changes made to the codebase during ongoing development.

Whenever you:
- Add a new Cloud Function or callable endpoint in `functions/index.js`
- Modify existing function parameters, return payloads, or error handling
- Change role-based access control (RBAC) checks or permissions (`volunteer`, `manager`, `admin`)
- Update Firestore triggers or event handling
- Alter Firestore security rules in `firestore.rules` affecting API functionality

**You MUST:**
1. Update `docs/API.md` concurrently within the same task.
2. Verify all request parameter types, optional/required statuses, and descriptions match the code.
3. Update response JSON examples and HTTP/HttpsError status codes.
4. Document any new safeguards, concurrency handling, or business rules.
5. Run `npm run lint` in `functions/` to guarantee code style compliance.

## 2. Security & RBAC Enforcement

- Never expose administrative functions or UI controls (`Admin Panel`, `createShift`, `updateUserRole`, etc.) to non-admin users.
- Always perform server-side authorization checks on `request.auth` and user role inside Cloud Functions; client-side checks are for UI convenience only.
- Ensure Firestore security rules (`firestore.rules`) protect against direct client tampering or privilege escalation.

## 3. Git Commit Policy

- **Do NOT automatically create git commits**: Never run `git commit` or commit changes automatically after completing a task, making changes, or resolving issues.
- **Explicit user request only**: Only commit changes if the user explicitly asks to commit.

## 4. Deployment Policy

- **Do NOT prompt for deployment**: Do NOT ask or prompt the user if they want to run `firebase deploy` after tasks or code changes.
- **Explicit user request only**: Never run `firebase deploy` automatically; only deploy when explicitly instructed to do so by the user.
