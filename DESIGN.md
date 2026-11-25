---
name: ExecWard
description: The owner's console for security-first Code Mode.
colors:
  stop-red: "#b00020"
  on-stop: "#ffffff"
  hairline: "#8884"
  item-border: "#8886"
typography:
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.4rem"
    lineHeight: 1.5
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.1rem"
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  item: "0.4rem"
spacing:
  control-gap: "0.25rem"
  control-pad: "0.5rem 1rem"
  field-pad: "0.4rem"
  item-pad: "0.5rem 0.75rem"
  section-gap: "2rem"
components:
  button-stop:
    backgroundColor: "{colors.stop-red}"
    textColor: "{colors.on-stop}"
    typography: "{typography.label}"
    padding: "0.5rem 1rem"
  queue-item:
    rounded: "{rounded.item}"
    padding: "0.5rem 0.75rem"
---

# Design System: ExecWard

## Overview

**Creative North Star: "The Control Panel"**

The console is the labelled switch panel on a piece of equipment. Every control says in
plain words what it does. The stop control is unmistakable. Nothing decorates. It is
quiet until something needs the owner, and then the thing that needs them is at the top.

This file records the console as it stands on 2026-11-25. It has never had a design
pass. What is here is the browser's own look with a handful of choices on top: one
column, the system typeface, hairline rules between sections, and one red kept for
stopping. Treat it as an honest record of the starting point, not as a finished
identity to be defended.

**Key Characteristics:**
- One narrow column, read top to bottom.
- The system typeface at one size, with weight and a slightly larger size for headings.
- The browser's own buttons, fields and colours, in the reader's light or dark scheme.
- One red, used only for the stop button and for a message that reports a failure.
- No shadows, no images, no icons, no motion.
- Nothing loaded from anywhere else.

## Colors

Almost no colour of its own: text and background are the browser's, following the
reader's light or dark setting.

### Primary
- **Stop Red** (`stop-red`): the "Stop everything now" button, and the status message
  when it reports a failure. Nothing else.

### Neutral
- **On Stop** (`on-stop`): the text on the stop button.
- **Hairline** (`hairline`): the rule above each section. A translucent grey, so it
  holds in both light and dark schemes.
- **Item Border** (`item-border`): the outline of a queue item, a little stronger than
  the hairline.
- Text and page background are not set. They are the browser's defaults under
  `color-scheme: light dark`.

### Named Rules
**The One Red Rule.** Red means stop or failed. It is never used to decorate, to brand,
or to mark something as merely important.

## Typography

**Body Font:** the system typeface (`system-ui`, falling back to `sans-serif`)

**Character:** whatever the reader's device already uses for its own settings screens.
No typeface is loaded.

### Hierarchy
- **Title** (1.4rem): the page's one title, "ExecWard console".
- **Headline** (1.1rem, 2rem above): the name of each section.
- **Body** (16px, line height 1.5): everything else, including buttons and fields,
  which inherit it.
- **Label** (weight 600): the status message under the title, and the stop button.

Secondary text is the body at 70% opacity (the `muted` class): the short explanation
under a control, and what an option does.

## Layout

One column, at most 44rem wide, centred, with 1rem of padding at the sides and 2rem
above. Sections follow in a fixed order, each opening with a hairline rule and its
headline. Controls flow inline and wrap; fields never exceed the column. There are no
breakpoints: the same column serves a phone and a desk.

The order is by urgency: what is waiting for the owner first, then figures, then the
kill switch and the other switches.

## Elevation & Depth

Flat. There are no shadows and no layers. Separation comes from the hairline above each
section and the outline round each queue item.

## Shapes

Square by default. The one rounded form is the queue item (0.4rem corners), which marks
it as a thing to be decided, apart from the page's standing sections. Buttons and
fields keep the browser's own shape.

## Components

### Buttons
- **Default:** the browser's own button, in the body typeface, with 0.5rem by 1rem of
  padding and a 0.25rem gap.
- **Stop:** Stop Red with On Stop text, no border, weight 600. There is one.
- **Hover / Focus:** the browser's own. Nothing is added or removed.
- A queue option's button is followed on the same line by muted text saying what it
  does, and "Cannot be undone." or "Needs a reason." when that applies. The recommended
  option says "(recommended)" in its label.

### Queue item
- **Corner Style:** 0.4rem.
- **Border:** 1px, Item Border. No fill, no shadow.
- **Internal Padding:** 0.5rem by 0.75rem, with 0.75rem between items.
- Holds what happened, a reason field, the options with their effects, and why one is
  recommended.

### Inputs / Fields
- **Style:** the browser's own text field and select, in the body typeface, 0.4rem of
  padding.
- **Focus:** the browser's own.
- A field's label is plain text wrapped round it.

### Status message
- One line under the title, weight 600, announced politely to assistive technology. It
  turns Stop Red when it reports a failure. It always reserves its line, so the page
  does not jump.

### Lists
- Plain bulleted lists for figures, paused projects, blocked tools and proposals. An
  empty list shows one muted line saying so.

## Do's and Don'ts

### Do:
- **Do** write every value into the page as text, never as markup.
- **Do** keep the page self-contained: one style block and one script, both under the
  response's nonce, calling only the console's own addresses.
- **Do** say next to each control what it does, in plain words.
- **Do** keep an estimated figure labelled as an estimate wherever it appears.
- **Do** put the safe action first.

### Don't:
- **Don't** load a font, image, icon set, script or stylesheet from anywhere else. Tests
  fail the build if the page reaches outside.
- **Don't** use Stop Red for anything but stopping and failure.
- **Don't** add a build step or a framework for this page without the owner's say.
