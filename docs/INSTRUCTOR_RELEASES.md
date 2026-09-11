# Instructor-controlled rapid fire

The latest requested workflow overrides the original fixed 30-question / 12-second settings. Those remain defaults, but each round can have its own approved settings.

## Interface

Open `/instructor` to:

1. See the total questions available in the selected round's pool.
2. Choose how many to release (1–300, limited by the actual pool) and seconds per question (1–120).
3. See total duration change immediately: questions × seconds. For example, 20 questions × 15 seconds = 5 minutes.
4. Review the settings, then **Approve & release**. Approval starts the shared countdown immediately and freezes the settings.
5. Watch the countdown or select **End rapid fire**, followed by **End for everyone**.
6. After closure, configure the next round when its question pool exists. The previous release stays closed.

Without both public Supabase environment values, this screen explicitly runs as a local setup preview, with sample pool counts. Its state persists within the browser tab; **New setup preview** is available only in this demonstration mode. It does not create student sessions or student scores.

With Supabase configured, the same screen requires Google sign-in and instructor authorization. It retrieves pool counts and sections from `instructor_state`, creates an instructor-owned session, saves settings with `configure_round`, releases using `go_live`, and ends using `end_round`. Google OAuth, the domain hook, instructor and roster provisioning must be configured as described in the README. The Google OAuth redirect allowlist must include `/instructor` for the deployed origin.

The URL distribution and Google Spaces integration are intentionally not implemented yet. No messages are sent.

## Timing and one-attempt rules

- One release corresponds to one round in a session. Nine sequential rounds remain supported.
- A release closes at its server start time plus its approved count × seconds. Everyone shares that closing time; late arrivals receive only the remaining window.
- Each served question also has its own approved timer and the existing one-second network grace. Grace never extends the overall release deadline.
- Every game RPC checks the server deadline. Editing browser clocks, leaving the page, refreshing, or opening a second tab does not create more time or a second draw.
- `(session_id, player_id, round_id)` uniquely identifies a student's run. A reconnect resumes that same run, a submitted run cannot restart, and an ended release cannot reopen.
- The instructor can end a release early. Accepted answers are scored; all remaining questions are marked as forced timeouts worth zero.
- The database rejects answers immediately after the deadline, even if no instructor tab is open. `instructor_state` polls every three seconds and finalizes expired runs; `round_report`, `go_live` and `end_session` also finalize when needed. If no one calls any of these, score materialization waits for the next call, but answer access is already closed by the database clock.
- Detailed reports become accessible to the owning instructor after that release ends, without waiting for the whole sitting to end.
- The three-hour sitting limit remains. A release that would exceed the existing session's closing time is refused.

## Metrics

Each run snapshots its approved `question_count` and `seconds_per_question`. Accuracy and average time use that question count, and the early-answer threshold is strictly less than half that approved question time. For example, a 20-second question uses a 10-second threshold. Wrong answers remain zero points.

On forced closure, never-served questions keep NULL timestamps and contribute zero observed response time; they still count as timeouts in the accuracy denominator. A served, unanswered question records observed elapsed time until closure. The `forced_timeout` flag distinguishes forced closure from a student's recorded answer. The class average remains the average of per-student mean answer times, including zero time for never-seen questions; use the timeout counts alongside it when interpreting early-ended rounds.

## Verification

Migration `202609110003_configurable_releases.sql` extends the existing RPCs, RLS, grants and metrics. Tests cover configurable draws above 30, custom scoring and half-time boundaries, insufficient pools, invalid settings, shared deadline rejection, partial result preservation, owner-only closure, immutable retries and denial of direct calls to internal scorers/finalizers.

The browser preview has been tested locally. Hosted Supabase OAuth, PostgREST, real multi-user concurrency and student URL access still require integration testing before classroom use.
