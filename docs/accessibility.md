# Web accessibility baseline

## Target and release policy

NexaChat targets [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/) for every supported MVP web flow. The target includes authentication, community/category/space navigation, message history and composition, invitation acceptance and administration, and error recovery. Automated results are evidence, not a claim of conformance; manual keyboard, visual, and assistive-technology checks remain required.

An accessibility regression is classified and released as follows:

| Severity | Definition                                                                                                                                                          | Release treatment                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Critical | A critical flow cannot be completed with a keyboard or supported assistive technology; content triggers a seizure risk; or identity/security meaning is unavailable | Blocks merge and release                                                         |
| High     | A WCAG A/AA failure in a critical flow, including inaccessible names, focus loss/trap, contrast, reflow, or missing error/status meaning                            | Blocks release; blocks merge unless the documented exception process is approved |
| Medium   | A WCAG A/AA failure outside a critical flow with a viable accessible path                                                                                           | Must have an owner, issue, target date, and tested workaround before merge       |
| Low      | Best-practice or usability defect that does not fail the target                                                                                                     | Tracked and prioritized; does not alone block release                            |

Exceptions must identify the exact criterion and UI, affected users, workaround, issue, owner, approval, and date by which the exception expires. Expired, unowned, or untested exceptions block release. Automated-rule suppressions are exceptions and follow the same policy; blanket axe exclusions are not allowed.

## Supported test matrix

The release candidate must pass on current stable browser and assistive-technology combinations available to the project:

| Environment       | Keyboard      | Screen reader | Required flows                                             | Current result                     |
| ----------------- | ------------- | ------------- | ---------------------------------------------------------- | ---------------------------------- |
| Windows, Chromium | Full keyboard | NVDA          | Authentication, navigation, messaging, invitations, errors | Not executed for this local commit |
| Windows, Firefox  | Full keyboard | NVDA          | Authentication, navigation, messaging, invitations, errors | Not executed for this local commit |
| macOS, Safari     | Full keyboard | VoiceOver     | Authentication, navigation, messaging, invitations, errors | Not executed for this local commit |
| macOS, Chromium   | Full keyboard | VoiceOver     | Authentication, navigation, messaging, invitations, errors | Not executed for this local commit |

The release owner records browser, OS, assistive-technology versions, tester, date, result, and linked defects. “Not executed” is not a pass. Registration/login screens are not yet implemented, so their matrix cells cannot be completed and issue #20 remains release-blocking.

## Automated procedure

Run:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run test:accessibility
```

The Playwright suite starts the built-in web development server, stubs only the local application API, uses real browser semantics and axe-core WCAG 2.0/2.1/2.2 A/AA rules, and exercises initial, community navigation, message composer, invitation, error, narrow-reflow, reduced-motion, and forced-color states. CI installs its own Chromium and runs the same command. Any violation fails the job. The complete repository format, lint, strict TypeScript, unit/integration, and production-build gates still apply.

## Manual keyboard procedure

For each critical flow, begin with the browser chrome focused and do not use a pointer:

1. Use `Tab` to reveal and activate “Skip to conversation”. Confirm the conversation heading receives a visible, unobscured focus indicator.
2. Traverse every interactive element using `Tab` and `Shift+Tab`. Confirm the order follows the visual and reading order, every action works with `Enter` or `Space`, and focus never becomes trapped.
3. Create or enter a community, select each category/space, send a message, create/copy/accept an invitation, and recover from representative validation, authorization, dependency, and network errors.
4. Confirm selecting a space moves focus to its conversation heading. Submitting a composer or invitation action retains predictable focus. Background history and real-time updates never move focus.
5. Confirm disabled, busy, current, edited, deleted, unread, and error states do not depend on color or visual position alone.
6. Trigger every destructive confirmation once by cancelling and once by confirming. Initial focus, accessible description, focus containment, `Escape`, and return focus must be correct.

Registration/login, destructive confirmation dialogs, and unread controls are mandatory when those interfaces are added; their absence does not waive testing.

## Visual and input procedure

- At 200% browser zoom and at 320 CSS pixels wide, complete every flow without two-dimensional scrolling or loss/overlap of content.
- Test default, hover, focus, disabled, error, selected, and unread states. Normal text must reach 4.5:1, large text 3:1, and meaningful non-text UI and focus indicators 3:1 against adjacent colors.
- Enable the operating system’s increased-contrast/forced-colors mode and confirm controls, current state, errors, and focus remain distinguishable.
- Enable reduced motion before loading. Confirm nonessential animation and transitions are removed and no information depends on motion.
- Use touch emulation and a physical touch device where available. Interactive targets must be at least 24 by 24 CSS pixels; this client adopts 44 by 44 pixels for primary controls.
- Apply text-spacing overrides from WCAG 1.4.12 and confirm content remains available.

## Screen-reader procedure

For each matrix combination, navigate by landmarks, headings, forms, controls, and reading order before completing the critical flows. Confirm:

- community, category, space, invitation, message, author, timestamp, edited/deleted state, and composer meaning is available without position or shape;
- visible control text is included in the accessible name;
- errors identify the failed action and do not disappear before review;
- invitation and foreground-action status changes are concise and announced once;
- initial history is not re-announced as new content;
- real-time message notices are coalesced to at most one announcement per three-second window and never move focus; and
- reading position remains stable when messages arrive.

## Focus-management rules

- Native document order is authoritative; positive `tabindex` is prohibited.
- A user-requested route or space change focuses the new view’s heading after render.
- Opening a modal focuses its heading or first safe action, contains focus, supports `Escape` unless the action must be resolved, and returns focus to the opener.
- Foreground validation and submit errors use an alert and retain focus at the initiating control unless focus must move to a summary to make recovery possible.
- Background failures and real-time updates announce status without taking focus.
- Newly inserted messages never receive focus automatically. History reconciliation preserves the active element and reading position.
- Destructive confirmations initially focus the least destructive action and name the affected resource.

## Known exceptions and incomplete evidence

| Gap                                                                        | Criterion/evidence                                                                          | Impact and workaround                                                                                 | Owner                                     | Target date                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| Registration/login UI is not implemented                                   | Keyboard-complete critical authentication flow and WCAG review cannot run                   | No web authentication flow is available to users; API verification is not an accessibility substitute | Web maintainers, issue #20                | 2026-08-15                            |
| Manual assistive-technology matrix is not executed for this local revision | Human verification is required for semantics, reading order, announcements, and interaction | Automated browser checks catch only a subset; release remains blocked                                 | Release accessibility reviewer, issue #20 | Before MVP release candidate approval |
| Destructive confirmations and unread UI are not implemented                | Their focus and state behavior cannot be inspected                                          | Apply the rules above when introduced; no current UI path is affected                                 | Web maintainers, issue #20                | Before the implementing change merges |

These are tracked gaps, not WCAG waivers. The first two prevent closure of issue #20 and MVP release approval until the evidence is completed.
