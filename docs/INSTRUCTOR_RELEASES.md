# Instructor-controlled releases

The instructor selects a section, 1–300 questions (limited to the pool), and 1–120 seconds per question. Settings and content freeze at approval. The next round retains those settings, capped by its available pool. Rounds run in sequence; end the current release before approving the next.

## Three distinct clocks

1. **Question deadline:** `served_at + seconds_per_question`. This is immutable. There is no additional acceptance grace. Answers at or after this boundary are timeouts.
2. **Joining window:** release start plus question count × seconds. It closes admission to new attempts, not the question clocks of existing attempts. The instructor display labels this explicitly.
3. **Session hard cutoff:** configured when opening the sitting (maximum three hours). It and manual instructor closure terminate outstanding questions early.

A successful answer immediately serves the next question. An unanswered question times out at its original deadline; the next question's clock follows that deadline even offline. Recovery catches up all expired questions and returns only the currently pending question. Neither refresh, retries, clock changes nor duplicate tabs reset the attempt.

The release automatically ends after the joining window closes and all started runs are finalized. If nobody started, it ends when admission closes. State/report calls materialize finalization; clocks are enforced even if nobody is polling. Manual closure scores accepted answers and marks remaining questions as forced timeouts.

## Sealing and recovery

`submit_answer` returns only the next question or a completion marker. `submit_round` is an idempotent receipt; it never returns keys. `my_result` checks membership and releases the full frozen debrief only after the whole rapid fire is over — the session timer has run out or the host ended the session — never merely when one round's release closed. `student_state` likewise lists a round as reviewable only once the session has ended, so no solutions leak between rounds while play is live.

`session_leaderboard` follows a different clock. It returns the cumulative standings — named by each player's real Google profile name — to a student as soon as that student has submitted, and stays live afterwards as classmates finish. It never exposes answers, so a finisher can see where they rank without holding the key to pass to peers who are still playing. It is sealed only for a student who has not yet submitted and whose session is still open.

A student may join multiple sessions without changing earlier memberships. Section names are metadata; actual access is granted by `session_members`. Joining is limited to 10 attempts per account per minute. A submitted `(session, student, round)` cannot restart.

## Instructor / preview

The connected screen uses actual question counts, an instructor email allowlist and session ownership checks. Share its `/?j=CODE` URL manually; no Google Spaces messages are sent yet. Detailed reports are available to the owning instructor after the selected release ends.

The offline preview demonstrates settings and a nominal countdown, with no student attempts to extend the window. It does not create sessions or scores. Public practice is also ungraded.

## Migration

Apply `202609110008_production_protocol.sql` between sittings and deploy its matching frontend. UUID option tokens replace the numeric submission signature. Existing completed runs retain results; historical attempts establish membership during upgrade. Lobby users with no attempt need to rejoin. Existing releases keep their prior cutoff; only newly launched releases use the separated clocks. No live rollout should occur mid-assessment.
