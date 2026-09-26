---
target_identity: "file:C:\\Users\\pete\\Dev\\brewcrew-platform\\public\\index.html"
target_fingerprint: "sha256:90532cc47ae2f98b3e1ee25386432de3677796a869eb0d6e843facfd1dec8094"
target_path: "C:\\Users\\pete\\Dev\\brewcrew-platform\\public\\index.html"
timestamp: 2026-09-26T21-00-34Z
slug: public-index-html
---
# Mobile Schedule View Critique Report

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Selected day is visible, but accordion scroll position, total session progress, and shift availability are hard to scan. Floating FAB occludes bottom shifts. |
| 2 | Match System / Real World | 3 | Real-world festival terms (Cask, Keg, Cider, Tokens) are accurate, but "0/3" quota syntax with tiny icons lacks human clarity. |
| 3 | User Control and Freedom | 2 | All time blocks auto-expanded creates an overwhelming scroll with no quick mobile collapse/expand or time-jump controls visible. |
| 4 | Consistency and Standards | 3 | Theme is consistent, but desktop 3-column table is squashed into mobile without responsive flow adaptation. |
| 5 | Error Prevention | 2 | High mis-tap risk: roster modal tap target ("0/3") sits less than 8px from primary "Register" button. |
| 6 | Recognition Rather Than Recall | 3 | Shifts are visible, but identical repetitive styling across 20+ rows forces constant re-reading. |
| 7 | Flexibility and Efficiency | 2 | Finding a specific area or open slot requires scrolling through all accordions; no quick area filter or jump rail on mobile. |
| 8 | Aesthetic and Minimalist Design | 1 | High clutter: 20 identical high-contrast buttons, badge pills around every area name, nested cards detected, and top nav takes 35% of viewport. |
| 9 | Error Recovery | 2 | Clash detection exists but only after conflicts occur; no proactive visual warnings before tapping. |
| 10 | Help and Documentation | 3 | Flow is straightforward, but lacks role explanations or clarity on volunteer hour perks. |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

- **LLM Assessment**: The visual theme (deep amber, malt tones, festival badges) is richly grounded in a British beer festival identity. However, the schedule component suffers from "spreadsheet-in-a-phone" syndrome. Rather than adopting a mobile-first hierarchy, a desktop 3-column table is forced into a narrow 360-390px column. Every row is treated with identical visual urgency (badges, links, and high-contrast filled buttons), producing extreme visual vibration and fatigue.
- **Deterministic Scan**: Ran `impeccable detect` on `public/index.html`. Detected 2 `nested-cards` warnings (cards inside cards creating visual noise and excessive depth; recommending flattening the hierarchy using spacing, typography, and dividers rather than nested containers).
- **Visual Overlays**: Automated browser overlay injection skipped; findings derived directly from static source analysis, CLI detector, and mobile screenshot evidence.

## Overall Impression

Rich, warm brand personality with excellent festival domain grounding, but severely degraded mobile usability. The volunteer is confronted with a dense wall of 20+ identical burnt-orange buttons inside stacked, fully-expanded accordion boxes, with headers consuming a third of the screen before any content is reached.

## What's Working

1. **Warm Festival Personality**: The malt-brown palette, beer glass icons, and warm amber accents feel authentic to a real beer festival rather than a generic SaaS template.
2. **Clear 2-Hour Time Block Segmentation**: Organizing shifts chronologically by festival sessions (12:00–14:00, 14:00–16:00, etc.) reflects how volunteers think about their festival availability.
3. **Essential Information at Hand**: Volunteer counts, area names, and shift times are present without requiring navigation into sub-pages.

## Priority Issues

- **[P1] Wall of 20 Identical "Register" Buttons (Action Exhaustion & No Hierarchy)**
  - *Why it matters*: When every row on a mobile screen ends with an identical bright solid orange button, the interface screams at the user from every direction. The eye cannot prioritize shifts that urgently need help versus shifts that are almost full.
  - *Fix*: De-escalate button intensity. Use secondary/tonal buttons (`bg-amber-50 border border-amber-300 text-amber-900`) for standard available shifts, reserving solid filled buttons for urgent vacancies or active selections.
  - *Suggested command*: `$impeccable layout` or `$impeccable quieter`

- **[P1] Squashed 3-Column Mobile Table & High Mis-Tap Risk**
  - *Why it matters*: Forcing `[Area Pill]`, `[0/3 👥]`, and `[Register]` into a single horizontal row on a 360px viewport pinches area titles ("Tokens & Merch" is squished) and places the tiny roster trigger directly adjacent to the Register button, leading to accidental registrations.
  - *Fix*: Transition from a 3-column table row to a stacked mobile card/list layout. Put the Area Name as a clean bold heading on top with quota metadata underneath ("3 needed · 0/3 filled"), leaving the entire right side for a generous, thumb-friendly button.
  - *Suggested command*: `$impeccable adapt` or `$impeccable layout`

- **[P1] Accordion Overload & Infinite Scroll Fatigue**
  - *Why it matters*: Auto-expanding all 5–7 time blocks at once turns the page into an endless, repetitive scroll, overwhelming the volunteer with 20–30 choices simultaneously (violating Cowan's working memory limit of ≤4 items).
  - *Fix*: Expand only the first or upcoming time block by default. Add a sticky or compact horizontal time-slot jump rail (`[12:00] [14:00] [16:00] [18:00] [20:00]`) so volunteers can jump directly to their preferred time.
  - *Suggested command*: `$impeccable distill` or `$impeccable layout`

- **[P2] Heavy Header Stack Consumes 35% of Mobile Viewport**
  - *Why it matters*: The top navigation bar, the "Select Festival Day" container, day pills carousel, and session info strip stack vertically, pushing the first shift row down past the top third of the phone.
  - *Fix*: Compact the header into a unified single-card strip on mobile: combine day selection with the session title and reduce vertical padding.
  - *Suggested command*: `$impeccable distill` or `$impeccable adapt`

- **[P2] Floating Pint Glass FAB Occludes Bottom Interactive Elements**
  - *Why it matters*: The circular "0h" floating pint button sits at the bottom-right corner, directly covering the lowest shift's Register button and roster links.
  - *Fix*: Add `pb-24` bottom padding to the scroll container, or integrate volunteer hour tracking into a sleek, docked bottom drawer that respects mobile safe areas.
  - *Suggested command*: `$impeccable polish` or `$impeccable adapt`

## Persona Red Flags

- **Casey (Distracted Mobile User)**: Using the phone one-handed on public transport. Tapping the roster number "0/3" to see if friends are working frequently triggers the "Register" button instead due to tight column spacing. The floating FAB blocks the last shift. Casey abandons after two misclicks.
- **Jordan (First-Timer)**: Confronted by 20 rows of cryptic "0/3 👥" badges and identical orange buttons. Has no idea which role is easiest for a newcomer, and feels intimidated by the sheer volume of choices.
- **Alex (Power User)**: Wants to work two shifts on Cask Bar on Friday. Has to scroll through 25 rows and 5 separate accordions looking for "Cask Bar" repeatedly because there is no quick area filter or compact view on mobile.

## Minor Observations

- Area badges add visual noise: wrapping every single area name ("Cask Bar", "Cider Bar") in an enclosed pill container creates repetitive boxes that distract from reading.
- Accordion chevron uses a simple text arrow (▼) rather than a smooth SVG icon with transition.
- Section sub-labels ("4 areas · 7 open") blend into the background with low contrast on darker mobile screens.

## Questions to Consider

- "What if shifts were presented as clean, stacked cards with area and capacity grouped together, rather than a cramped 3-column table?"
- "Could we auto-expand only one time slot at a time or provide time-jump pills, cutting initial screen clutter by 70%?"
- "What if we reserved high-contrast orange buttons only for urgent shifts needing volunteers, making unbooked shifts calm and easy to scan?"
