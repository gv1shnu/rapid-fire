# Single-config, self-paced rapid fire

The instructor configures the sitting **once** — a section, 1 question per round up to the smallest lecture's pool, and 1–120 seconds per question — and starts it **once** (`start_rapid_fire`). All nine rounds go live together with the same settings; content and the question draw freeze at that moment. There is no per-round configuration, release, or end. "Round" is only a lecture/content label on a question.

Each **student self-paces** straight through all nine rounds — `9 × questions` in total — with no breaks and no instructor handoff. When a student finishes one round, the next is served immediately. One attempt per `(session, student, round)`; a submitted round cannot restart.

## Two clocks

1. **Question deadline:** `served_at + seconds_per_question`, immutable, no acceptance grace. Answers at or after it are timeouts. A successful answer serves the next question at once; an unanswered one times out at its original deadline and the following question's clock starts only when it is first served — so refresh, retries, device-clock changes and duplicate tabs never reset the attempt.
2. **Session cutoff:** set when the sitting opens (max three hours) and the host's **End rapid fire** (`end_session`). Either one finalizes every started run — scoring accepted answers and marking the rest forced timeouts — and reveals answers. `student_state` materializes that finalization when polled after the cutoff, so clocks are enforced even if nobody is polling.

Because every round is live for the whole sitting, a round's own admission never closes independently; a student may enter their next round any time until the session ends.

## Sealing and recovery

`submit_answer` returns only the next question or a completion marker; `submit_round` is an idempotent receipt and never returns keys. `my_result` releases the frozen debrief only after the **whole rapid fire is over** — the session timer has run out or the host ended it — never mid-sitting; `student_state` likewise lists a round as reviewable only once the session has ended, so no solutions leak while play is live.

`session_leaderboard` follows the other clock: it returns cumulative standings — named by each player's real Google profile name — once that student has **finished every round** (`done`), and stays live as classmates finish. It never exposes answers, so a finisher sees their rank without holding the key to pass to peers still playing. It is sealed only for a student who has not yet finished and whose session is still open.

A student may join multiple sessions without changing earlier memberships. Section names are metadata; access is granted by `session_members`. Joining is limited to 10 attempts per account per minute.

## Instructor / preview

The connected control room shows one shared config, the join `/?j=CODE` link, and live progress (`students_joined`, `students_done`) with a single session timer and an **End rapid fire** control. Detailed per-round reports are available to the owning instructor after the session ends.

The offline preview demonstrates the same configure → start → monitor flow with a short nominal countdown and no real session, scores, or students.

## Migration

Apply migrations in order; `202609110012_self_paced.sql` layers the single-config, self-paced control flow onto the existing snapshot/scoring machinery with `create or replace`. The per-round host RPCs (`configure_round`, `go_live`, `end_round`) are revoked from students; `start_rapid_fire` and `end_session` replace them. Deploy the matching frontend. No live rollout should occur mid-assessment.
