---
name: ExecWard
description: The owner's console for security-first Code Mode.
colors:
  stop-red: "#b00020"
  stop-red-pressed: "#8f001a"
  on-stop: "#ffffff"
  failure-on-dark: "#ff8a98"
  page: "#fbfbfa"
  surface: "#ffffff"
  ink: "#1a1c1e"
  quiet-ink: "#5b6068"
  hairline: "#d9dce0"
  control-edge: "#8b9099"
  hover: "#f0f1f2"
  pressed: "#e4e6e8"
  page-dark: "#131416"
  surface-dark: "#1b1d20"
  ink-dark: "#e8e9eb"
  quiet-ink-dark: "#a3a8b0"
  hairline-dark: "#33363b"
  control-edge-dark: "#7a808a"
  hover-dark: "#25282c"
  pressed-dark: "#2e3136"
typography:
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
  subhead:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  note:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.5
rounded:
  control: "0.375rem"
  item: "0.5rem"
spacing:
  control-gap: "0.5rem"
  field-gap: "0.75rem"
  item-pad: "1rem"
  section-gap: "2rem"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.9rem"
    height: "2.75rem"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-active:
    backgroundColor: "{colors.pressed}"
  button-stop:
    backgroundColor: "{colors.stop-red}"
    textColor: "{colors.on-stop}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.9rem"
    height: "2.75rem"
  button-stop-hover:
    backgroundColor: "{colors.stop-red-pressed}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.6rem"
    height: "2.75rem"
  queue-item:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.item}"
    padding: "1rem"
---

# Design System: ExecWard

## Overview

**Creative North Star: "The Control Panel"**

The console is the labelled switch panel on a piece of equipment. Every control says in
plain words what it does. The stop control is unmistakable. Nothing decorates. It is
quiet until something needs the owner, and then the thing that needs them is at the top.

It had its first design pass on 2026-11-25. That pass kept the bare starting point (one
column, the system typeface, one red) and gave it what it lacked: an order that puts
stopping near the top, one consistent set of controls with real states, figures in
aligned tables, and colours that hold in light and dark.

**Key Characteristics:**
- One narrow column, read top to bottom, in order of urgency.
- A one-line summary under the title: the kill switch and Code Mode at a glance.
- The system typeface, in a tight scale.
- Neutral greys for everything but stopping.
- One red, used only for the stop button and for a message that reports a failure.
- No shadows, no images, no icons, no motion.
- Nothing loaded from anywhere else.

## Colors

A neutral, slightly cool grey scale in a light and a dark set, chosen by the reader's
own setting. One red.

### Primary
- **Stop Red** (`stop-red`): the "Stop everything now" button, and the status message
  when it reports a failure. It darkens to `stop-red-pressed` on hover and press.
- **Failure on Dark** (`failure-on-dark`): the failure message in the dark set, where
  Stop Red would be too dim to read as text.

### Neutral
- **Page** and **Surface** (`page`, `surface`): the page, and the slightly lighter
  ground of controls and queue items.
- **Ink** (`ink`): text, and the focus ring.
- **Quiet Ink** (`quiet-ink`): secondary text. A colour of its own, never the main text
  made see-through, so it keeps its contrast.
- **Hairline** (`hairline`): the rule above each section, table rules, the queue item's
  outline.
- **Control Edge** (`control-edge`): the outline of buttons and fields, strong enough
  to find a control by.
- **Hover** and **Pressed** (`hover`, `pressed`): a button under the pointer and under
  the finger.
- Each has a `-dark` partner for the dark set.

### Named Rules
**The One Red Rule.** Red means stop or failed. It is never used to decorate, to brand,
or to mark something as merely important. A kind of run that loses tokens is marked in
words and weight, not in red.

## Typography

**Body Font:** the system typeface (`system-ui`, falling back to `sans-serif`)

**Character:** whatever the reader's device already uses for its own settings screens.
No typeface is loaded.

### Hierarchy
- **Title** (700, 1.5rem, 1.25): the page's one title.
- **Headline** (700, 1.125rem, 1.3): the name of each section.
- **Subhead** (700, 1rem): a grouping inside a section, such as "By project".
- **Body** (1rem, 1.5): text, buttons and fields.
- **Label** (600, 0.875rem): the name above a field, and table headings.
- **Note** (0.875rem, Quiet Ink): the short explanation under a control, what an option
  does, and the caveats under a set of figures.

Figures in tables use tabular numerals and are set to the right, with thousands
separated.

## Layout

One column, at most 44rem wide, centred, with 1rem of padding at the sides. Sections
follow in a fixed order, each after the first opening with a hairline and its headline,
2rem apart.

The order is by urgency: what is waiting for the owner; the kill switch; Code Mode;
paused projects; client choices; blocked tools; then the figures; then set-up and checks.

The status message stays at the top of the window as the page scrolls, so the result of
pressing a button far down the page is always in view. It keeps its line when empty, so
nothing jumps.

Fields sit in a grid of columns at least 14rem wide: two side by side on a desk, one
above the other on a phone. A field's label sits above it. Buttons follow their fields
in a row that wraps. A table too wide for a phone scrolls sideways inside its own box;
the page itself never does.

## Elevation & Depth

Flat. There are no shadows and no layers. Separation comes from hairlines and from the
slightly lighter surface of controls and queue items.

## Shapes

Gently eased corners: controls at 0.375rem, the queue item at 0.5rem. Every control has
a 1px edge. Buttons and fields share one height (2.75rem), which is also a comfortable
target for a finger.

## Components

### Buttons
- **Shape:** 0.375rem corners, 1px Control Edge, 2.75rem tall.
- **Default:** Surface ground, Ink text.
- **Stop:** Stop Red ground, On Stop text, weight 600. There is one.
- **Hover / Active:** the ground steps to Hover, then Pressed. Stop steps to its
  pressed red.
- **Focus:** a 2px Ink ring, 2px clear of the control. The same ring on every control.
- **Disabled:** dimmed, with the ordinary pointer. Every button but Stop is disabled
  while a request is on its way, so nothing is sent twice. Stop is never disabled: a
  request that hangs must not take the kill switch away.

### Queue item
- **Corner Style:** 0.5rem.
- **Background:** Surface, with a 1px Hairline outline. No shadow.
- **Internal Padding:** 1rem.
- Holds what happened, a reason field, the options and why one is recommended. Each
  option is a row: its button on the left at a fixed width, and what it does beside it
  as a note. On a phone the note drops under its button.

### Inputs / Fields
- **Style:** Surface ground, 1px Control Edge, 0.375rem corners, 2.75rem tall, with a
  Label above. Text fields and drop-down lists share it.
- **Focus:** the shared ring.
- **Placeholder:** Quiet Ink at full strength.

### Tables
- For figures, and for the list of projects with each client's choice. Headings are
  Labels in Quiet Ink; each row ends in a hairline.
- The first column holds the name and takes the spare width; numbers are set to the
  right.
- A row that needs a remark carries it as a note under its name.
- A table with nothing in it is one quiet line saying so, with no headings.

### Status message
- One line under the summary, weight 600, announced politely to assistive technology.
  It turns red when it reports a failure.

### Lists
- Plain bulleted lists for paused projects, blocked tools and proposals. An empty list
  shows one quiet line saying so.

## Do's and Don'ts

### Do:
- **Do** write every value into the page as text, never as markup.
- **Do** style with classes only. The content policy refuses a style written on an
  element.
- **Do** keep the page self-contained: one style block and one script, both under the
  response's nonce, calling only the console's own addresses.
- **Do** say next to each control what it does, in plain words.
- **Do** keep an estimated figure labelled as an estimate wherever it appears.
- **Do** put the safe action first.

### Don't:
- **Don't** load a font, image, icon set, script or stylesheet from anywhere else. Tests
  fail the build if the page reaches outside.
- **Don't** use Stop Red for anything but stopping and failure.
- **Don't** lower secondary text by making it see-through. Use Quiet Ink.
- **Don't** add a build step or a framework for this page without the owner's say.
