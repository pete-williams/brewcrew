---
name: BrewCrew Volunteer Platform
description: Volunteer management, scheduling, and reward tracking for beer and cider festival volunteers
colors:
  primary: "#b45309"
  primary-dark: "#78350f"
  primary-light: "#fde68a"
  accent: "#f59e0b"
  accent-light: "#fcd34d"
  neutral-bg: "#f5f5f4"
  surface-card: "#ffffff"
  text-main: "#1e293b"
  text-muted: "#64748b"
  text-inverse: "#ffffff"
  border-amber: "#fde68a"
  border-subtle: "#f1f5f9"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: "2.25rem"
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "2rem"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.025em"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  "2xl": "1.5rem"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-inverse}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-dark}"
  card:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.xl}"
    padding: "1.25rem"
---

# Design System: BrewCrew Volunteer Platform

## Overview

**Creative North Star: "The Festival Taproom & Workshop"**

BrewCrew's visual identity balances the warm, celebratory spirit of a craft beer festival with the operational clarity of an industrial shift board. The environment prioritizes high-contrast scanability, clear state signifiers, and tactile surfaces so that volunteers and managers can navigate schedules quickly on desktop or mobile.

The interface lives on a warm stone-100 neutral canvas accented by rich ambers, deep malt browns, and crisp card surfaces. Rather than cold utility software or generic festival flyers, BrewCrew feels like an authentic community taproom: approachable, organized, and genuinely rewarding.

**Key Characteristics:**
- **Warm Operational Palette:** Deep malt amber headers (`amber-900`), warm craft accents (`amber-700`, `amber-500`), and a tactile stone ground (`stone-100`).
- **Disciplined Typographic Hierarchy:** Powered by Inter with strict role scaling, tight editorial heading tracking (`-0.025em`), and tabular numerals (`tnum`) for zero-jitter counters.
- **Surface Layering over Flat Clutter:** Structured white cards on warm neutral backgrounds bounded by delicate amber borders (`amber-200`) and subtle shadows.
- **Gamified Progress Motif:** The dynamic pint glass floating indicator and roadmap cards visually anchor volunteer achievements.

## Colors

The color palette reflects craft brewing traditions—golden ales, rich malts, and warm stone—calibrated for high operational contrast and WCAG AA compliance.

### Primary
- **Malt Amber** (`#b45309` / `amber-700`): The primary actionable brand color, used on primary buttons, active toggles, and emphasis highlights.
- **Deep Brew Malt** (`#78350f` / `amber-900`): Authoritative dark surface color for the top navigation bar, banner cards, and dark surface containers.

### Secondary
- **Golden Honey** (`#f59e0b` / `amber-500`): Warning cues, hover glow states, and filled pint glass liquid progress fill.
- **Pale Foam** (`#fde68a` / `amber-200`): Card borders, badge backgrounds, and warm sub-card accent tints.

### Neutral
- **Stone Ground** (`#f5f5f4` / `stone-100`): The base canvas background for the entire application, avoiding sterile white or reflex beige.
- **Surface White** (`#ffffff`): Card, modal, and drawer elevated surfaces.
- **Slate Text** (`#1e293b` / `slate-800`): High-legibility primary body copy and title text.
- **Slate Muted** (`#64748b` / `slate-500`): Metadata labels, descriptions, and secondary timestamps.

### Named Rules
**The Craft Ground Rule.** The base page background is strictly warm stone (`stone-100`), never pure white or stark cool grey. White is reserved for elevated cards and modals.
**The Dark Halation Rule.** Any text placed over deep amber (`amber-900`/`amber-950`) must have relaxed tracking (`0.005em` to `-0.015em`) and bright tinting (`amber-100` or `white`) to prevent optical irradiation.

## Typography

**Display & Body Font:** Inter (with `ui-sans-serif, system-ui, sans-serif` metric fallbacks).
**Character:** Clean neo-grotesque clarity tuned for rapid operational scanning, tabular data consistency, and compact mobile cards.

### Hierarchy
- **Display (`h1`):** Bold 700 / 800, `2rem` (32px), `line-height: 2.25rem`, `letter-spacing: -0.025em`. Main page headers and hero portal titles.
- **Headline (`h2`):** Bold 700, `1.5rem` (24px), `line-height: 2rem`, `letter-spacing: -0.02em`. Section views, major milestones, and top-level modal dialog headers.
- **Title (`h3`):** Semibold 600 / Bold 700, `1.25rem` (20px), `line-height: 1.75rem`, `letter-spacing: -0.015em`. Card headers, module titles, and settings groups.
- **Subhead (`h4`):** Semibold 600, `1rem` (16px), `line-height: 1.5rem`, `letter-spacing: -0.01em`. Form sub-sections and group labels.
- **Body:** Regular 400 / Medium 500, `1rem` (16px) or `0.875rem` (14px), `line-height: 1.5`. Main descriptions and dialog prose (constrained to 45–75ch).
- **Label / Micro:** Semibold 600 / Bold 700, `0.75rem` (12px / `text-xs`) or `0.625rem` (10px / `text-2xs`), `letter-spacing: 0.025em` with uppercase tracking on badge pills.

### Named Rules
**The Tabular Numerics Rule.** All hour counters, volunteer quotas (`3/8 Filled`), shift times (`12:00 - 17:00`), and percentage badges must use tabular figures (`font-variant-numeric: tabular-nums`) to prevent layout jitter during live updates.

## Layout

The application employs a centered container model with responsive gutters and compact mobile spacing.
- **Global Container:** `max-w-6xl mx-auto px-2.5 sm:px-4` ensuring balanced density on ultra-wide screens while avoiding awkward horizontal stretching.
- **Dialogs & Forms:** Constrained to `max-w-md` (~28rem) and `max-w-lg` (~32rem) to maintain ideal reading measure (45–75 characters per line).
- **Grid Systems:** 1-column on mobile expanding to 2 or 3 columns on tablet/desktop (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4`).

## Elevation & Depth

BrewCrew utilizes tonal layering backed by delicate amber borders and purposeful soft shadows rather than heavy artificial drop shadows.

### Shadow Vocabulary
- **Card Rest (`shadow-xs` / `shadow-sm`):** `0 1px 2px 0 rgba(0, 0, 0, 0.05)` combined with a `border border-amber-200` to anchor content blocks.
- **Interactive Lift (`shadow-md`):** `0 4px 6px -1px rgba(180, 83, 9, 0.15)` on button hover and active card selections.
- **Floating Overlays (`shadow-2xl`):** `0 25px 50px -12px rgba(0, 0, 0, 0.25)` for modal dialogs and the floating pint popover.

### Named Rules
**The Tonal Border Rule.** White cards must carry a subtle border (`border border-amber-200` or `border-slate-100`) rather than relying on shadow alone to delineate boundaries on the stone-100 ground.

## Shapes

- **Base Corners:** `rounded-xl` (12px/16px) for cards, dialogs, and large modules, creating a modern, friendly silhouette.
- **Controls & Buttons:** `rounded-lg` (8px) for buttons, inputs, and selects.
- **Badges & Avatars:** `rounded-full` (9999px) for role pills, status dots, and crew avatars.

## Components

### Buttons
- **Shape:** `rounded-lg` (8px radius) or `rounded-xl` (12px radius) on primary hero actions.
- **Primary:** Background `amber-700`, text `white`, font-bold, padding `px-4 py-2`. Hover shifts to `amber-600` with subtle elevation.
- **Secondary / Subtle:** Background `amber-100`, text `amber-900`, border `border-amber-300`. Hover shifts to `amber-200`.

### Cards
- **Base Card:** Background `white`, `rounded-xl`, `border border-amber-200`, `shadow-sm`, `p-5`.
- **Sub-Section:** Flattened divider layout (`pt-3 border-t border-slate-100`) instead of heavily nested boxed cards.

### Badges & Status Pills
- **Confirmed / Complete:** `bg-green-100 text-green-900 border border-green-300 font-bold text-2xs uppercase tracking-wider px-2 py-0.5 rounded-full`.
- **Open / Available:** `bg-amber-100 text-amber-900 border border-amber-300 font-bold text-2xs uppercase tracking-wider px-2 py-0.5 rounded-full`.
- **Role Badges:** Color-coded by RBAC level: Volunteer (`amber`), Shift Manager (`blue`), Administrator (`purple`).

### Pint Glass FAB & Popover
- **Floating Button:** Circular `bg-amber-900 text-white rounded-full p-3 shadow-xl border-2 border-amber-400 hover:scale-105 active:scale-95`.
- **Popover Card:** `max-w-[420px] rounded-2xl bg-white border border-amber-200 shadow-2xl` with malt gradient header.

## Do's and Don'ts

### Do:
- **Do** preserve the warm amber, malt brown, and stone-100 color relationships.
- **Do** use `tabular-nums` for all numeric metrics, timestamps, and hours counters.
- **Do** enforce `min-h-[44px]` touch targets for all interactive mobile controls.
- **Do** provide SVG icons via inline symbol sprites (`#icon-*`) with descriptive labels.

### Don't:
- **Don't** use generic cold blue or purple primary buttons—the core identity is malt amber (`amber-700`).
- **Don't** reintroduce nested sub-cards inside cards; use semantic section dividers (`border-t border-slate-100`).
- **Don't** introduce ad-hoc pixel typography sizes (`text-[10px]`); use scale tokens (`text-2xs`, `text-xs`, etc.).
- **Don't** expose administrative actions or manager controls to unauthorized roles.
