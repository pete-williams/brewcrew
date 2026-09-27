---
target: Browse Shifts section
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:C:\\Users\\pete\\Dev\\brewcrew-platform\\public\\index.html"
target_fingerprint: "sha256:be2f0965d2e4b3a92cdd7ed35e0570ac5b371ec1dced64ebff22468e07ca2a67"
target_path: "C:\\Users\\pete\\Dev\\brewcrew-platform\\public\\index.html"
timestamp: 2026-09-27T17-06-43Z
slug: public-index-html
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live metrics bar and real-time Firestore updates are strong. Accordion expand/collapse has no transition animation — content snaps `block`/`hidden` without ease, making state changes feel abrupt. No loading skeleton when shifts re-render. |
| 2 | Match System / Real World | 4 | Language is natural and domain-specific: "Festival Day," "Sessions," "Register," "spots available." Time formats are locale-aware. Volunteer-centric terminology throughout. |
| 3 | User Control and Freedom | 3 | Cancel button on registered shifts is good. Reset Filters link in empty states is helpful. But the `confirm()` dialog for cancellation is a browser native alert — jarring and unstylable. No undo after claiming a shift. |
| 4 | Consistency and Standards | 3 | Accordion cards, buttons, and badge pills follow a coherent system. Emoji icons (🕒, 🏷️, ⚡, 👥, ✏️) used as icon substitutes instead of the existing SVG icon sprite — inconsistent with the navbar and auth screens which use proper SVG `<use>` references. `border-l-4` accent on shift rows violates craft-floor guidance (colored border-left above 1px). |
| 5 | Error Prevention | 3 | Time-clash detection prevents double-booking. Locked shifts (7-day cutoff) are disabled with explanation. `claimShift` pre-checks conflicts client-side before calling Cloud Function. Full shifts show disabled "Full" button. |
| 6 | Recognition Rather Than Recall | 3 | Current day and session are visually highlighted. Active accordion is expanded by default. "By Time / By Area" segmented control is visible. But session chips don't show their time range at-a-glance on mobile when collapsed to single-session view. |
| 7 | Flexibility and Efficiency | 2 | No keyboard shortcuts for navigating between accordions, registering, or switching days/sessions. No bulk registration. Session stepper arrows are the only shortcut. The "Open Only" filter is a useful accelerator but lacks a keyboard binding. |
| 8 | Aesthetic and Minimalist Design | 3 | Clean, calm tonal register buttons are a significant improvement. Compact 2-line shift rows reduce noise. But the sticky navigation card (`#schedule-navigation`) is dense — it packs day pills, session label, session stepper, segmented toggle, session chips, metrics summary, and two utility buttons into a single sticky block. On shorter mobile viewports this consumes ~40-50% of screen height, leaving limited space for the scrollable shift list. |
| 9 | Error Recovery | 2 | `alert()` for failed registration/cancellation shows raw `err.message` — often a Firebase error string like "PERMISSION_DENIED" rather than a human-readable recovery suggestion. Form state is preserved (no wipe), which is good. |
| 10 | Help and Documentation | 1 | No contextual help within Browse Shifts. No tooltip explaining what "Open Only" filters. No onboarding hint for first-time volunteers about how to find and register for shifts. The coordinator contact banner is below the fold, disconnected from the shift browsing flow. |
| **Total** | | **27/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment**: The Browse Shifts section is clearly authored for this product — the warm amber/stone palette, festival-specific terminology ("Festival Day," "Sessions," session stepper), and the volunteer coordinator contact banner are all domain-specific. The accordion-based time-slot grouping fits the mental model of festival shift browsing. However, three areas feel category-interchangeable:

1. **Emoji as icons**: 🕒, 🏷️, ⚡, 👥, ✏️, 👔 are used throughout the shift rendering as icon substitutes. The navbar and authentication screens use a proper SVG icon sprite (`#icon-calendar`, `#icon-clipboard`, etc.). This creates a tonal split — the chrome feels designed while the content area feels assembled.
2. **The sticky navigation card** is a generic multi-tier filter/navigation pattern. It works but doesn't carry festival character — it could be a conference scheduler or a gym booking app without changes.
3. **Register buttons** are now calm tonal buttons (good), but every single shift row looks identical. There's no visual differentiation between shifts the user might care about (e.g. shifts their friends are on, shifts in areas they've previously volunteered).

**Deterministic scan**: 2 findings — both `nested-cards` warnings (severity: warning, category: slop). These are likely from the My Shifts and Admin views rather than the Browse Shifts section specifically, as the schedule view's accordion structure uses flat `role="list"` items inside cards rather than cards-in-cards. The Browse Shifts section itself is structurally clean.

## Overall Impression

The Browse Shifts section has evolved from a noisy wall-of-buttons into a well-structured, calm interface. The single-accordion behavior and auto-focus-on-next-shift are strong UX wins. The biggest opportunity is **reducing the sticky navigation height on mobile** — the schedule navigation card is so dense that the actual shift list gets squeezed into a cramped viewport slice.

## What's Working

1. **Single-accordion mutual exclusion** is excellent. It prevents cognitive overload from 10+ expanded time slots and gives users a clear focal point. The auto-expand-on-first-load with smooth scroll is a genuine delight moment.

2. **Tonal Register buttons** are a strong improvement. By treating all available shifts equally with calm `amber-50/70` tonal buttons, the interface no longer screams at users. The emerald "Booked" and rose "Cancel" states provide clear differentiation for registered shifts.

3. **Live metrics summary** ("14 shifts • 8 open spots") in the utility bar gives immediate orientation. Combined with the "Open Only" filter toggle, users can quickly narrow down to actionable shifts.

## Priority Issues

### [P1] Sticky navigation consumes excessive mobile viewport
**What**: `#schedule-navigation` is sticky at `top-[48px]` and contains 4 tiers of content: day pills, session label + stepper + segmented toggle, session chips, and the utility bar. On a 667px iPhone viewport, this leaves roughly 250-300px for the shift list.
**Why it matters**: Users came to browse shifts, but shifts are pushed below the fold by navigation chrome. The `max-h-[calc(100dvh-295px)]` constraint on `#shifts-table-container` directly reflects this problem.
**Fix**: Collapse the utility bar (metrics + Open Only + Expand All) into the session header row. The metrics summary can sit left of the segmented toggle, and the two utility buttons can move into a `···` overflow menu or be absorbed into the accordion header area.
**Suggested command**: `$impeccable distill`

### [P2] Emoji used as icon system throughout shift rendering
**What**: 🕒, 🏷️, ⚡, 👥, ✏️, 👔, 🔍, 📅, 🔒, ⚠️ are used in accordion headers, shift rows, utility buttons, and admin controls. Meanwhile, the project has a complete SVG icon sprite with `#icon-calendar`, `#icon-check`, `#icon-settings`, etc.
**Why it matters**: Emoji render inconsistently across platforms (Android vs iOS vs Windows vs macOS). They carry no semantic meaning for screen readers. They create a visual split between the polished navbar/auth chrome and the content area.
**Fix**: Replace all functional emoji with SVG `<use>` references from the existing icon sprite. Add missing icons (clock, tag, users, edit, lightning) to the sprite if needed.
**Suggested command**: `$impeccable polish`

### [P2] Accordion expand/collapse has no transition
**What**: Accordion content toggles between `block` and `hidden` — a hard snap with no animation. The chevron rotates smoothly (`transition-transform duration-200 ease-out`), but the panel itself just appears/disappears.
**Why it matters**: The abrupt snap breaks the perceived continuity of the interface. Users lose spatial context about where the content came from. This is especially jarring with the single-accordion behavior where one panel closes as another opens.
**Fix**: Replace `hidden`/`block` with a CSS `max-height` or `grid-template-rows: 0fr → 1fr` transition. The panel should slide open/closed over ~200ms with `ease-out`.
**Suggested command**: `$impeccable animate`

### [P2] Error messages use raw Firebase error strings
**What**: `claimShift` and `cancelShift` catch errors and display `alert("Registration failed: " + err.message)`. The `err.message` is often a Firebase `HttpsError` string like "PERMISSION_DENIED" or "NOT_FOUND."
**Why it matters**: Non-technical volunteers see "Registration failed: The caller does not have permission" instead of "This shift is no longer available. Please try another."
**Fix**: Map common Firebase error codes to human-readable messages. Replace `alert()` with the existing `showNotificationToast()` pattern used elsewhere in the app.
**Suggested command**: `$impeccable harden`

### [P3] No `aria-expanded` on accordion toggle buttons
**What**: The accordion header `<button>` elements in `renderShifts` have no `aria-expanded` attribute. Screen readers cannot communicate whether a time slot section is open or closed.
**Why it matters**: Keyboard-only and screen reader users cannot determine accordion state. The `role="list"` on the inner content is good, but the toggle itself is semantically incomplete.
**Fix**: Add `aria-expanded="${isExpanded}"` to the accordion header button and `aria-controls="${group.id}-content"` pointing to the collapsible panel.
**Suggested command**: `$impeccable harden`

## Persona Red Flags

**Jordan (First-Timer)**: The first thing Jordan sees is a dense navigation card with day pills, session chips, a segmented toggle, and two small utility buttons. No onboarding hint explains what "Sessions" are or how shifts are organized. The "Open Only" button uses ⚡ emoji with no tooltip — Jordan doesn't know what it filters. If Jordan registers for a shift, the only feedback is the real-time re-render (no toast or confirmation message). Jordan may not even realize the registration succeeded.

**Casey (Distracted Mobile User)**: The sticky navigation card pushes shifts far down on Casey's phone. When Casey scrolls through the shift list and taps "Register," the `claimShift` function fires but shows nothing until it succeeds or fails — no loading state on the button, no optimistic UI. If the connection is slow, Casey will tap again, potentially double-submitting. The `confirm()` dialog for cancellation is a browser native alert that may be blocked by some mobile browsers' pop-up settings.

**Sam (Accessibility-Dependent)**: Accordion toggles lack `aria-expanded`. Emoji icons have no screen reader text equivalent. The `border-l-4` on shift rows conveys "registered" vs "conflicting" status through color alone (emerald vs amber) with no text alternative visible to the line itself — though the "Booked" badge and "Clash" badge partially compensate. The "Collapse"/"Expand" text label on accordion headers is `hidden sm:inline`, invisible on mobile screen readers.

## Minor Observations

- The `border-l-4 border-l-transparent` on every shift row adds 4px of invisible left border. This shifts content alignment subtly compared to other list patterns in the app.
- The `text-[11px]` font size on mobile shift metadata falls below the WCAG minimum text size recommendation (12px / 0.75rem). Consider using `text-xs` (12px) consistently.
- The "Collapse All" / "Expand All" button text doesn't wrap gracefully on very narrow viewports (< 320px).
- The scrollbar styling in `#shifts-table-container` uses `#fde68a` (amber-200) for the default thumb — this is very low contrast against the white card backgrounds inside the container.
- Day pill buttons shrink to `min-w-[54px]` on mobile but session chips are full-width grid items — inconsistent density treatment.

## Questions to Consider

- What would Browse Shifts feel like if the navigation card were half its current height — one row of day+session instead of four tiers?
- Should the "Register" button change to show the area name or time on hover/focus, so users can confirm what they're signing up for?
- What happens when a volunteer has already registered for every available session? Should the interface acknowledge completion rather than showing an unchanged browse experience?
