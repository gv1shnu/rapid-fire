# Round scores and response metrics

One `round_runs` row is stored per `(session_id, player_id, round_id)`. Finalization is idempotent. Wrong answers and timeouts score **zero**; database constraints reject negative scores. Scores and keys never accompany a live question, answer acknowledgement or early completion receipt.

For approved count **N** and seconds per question **T**:

| Metric                  | Definition                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| Correct                 | Correct selections received strictly before their deadline              |
| Wrong                   | Incorrect selections received strictly before their deadline            |
| Timeout                 | No timely selection, including unanswered questions at forced closure   |
| Total answer seconds    | Sum of observed answering time; ordinary timeouts count T seconds       |
| Average answer seconds  | Total answer seconds / N                                                |
| Accuracy percent        | Correct / N × 100                                                       |
| Answers under half time | Selections received strictly before T / 2; both correct and wrong count |

Correct + wrong + timeout = N. Exactly T/2 does not qualify as early; exactly T is a timeout. There is no extra one-second scoring grace. Time between questions is excluded. Offline timeout processing uses the original deadline, not the later reconnect time. Never-served questions at forced closure have no timestamps and contribute zero observed time while remaining in the accuracy denominator. A served question interrupted early contributes time up to termination, capped at T. Interpret averages alongside timeout counts.

A timely correct answer earns `round((100 + 50 × remaining_seconds / T) × multiplier)`. The streak multiplier is 1, then 1.2 from the third consecutive correct answer, then 1.5 from the sixth. Wrong answers/timeouts reset the streak.

## Instructor report

After closure, call `round_report(p_session, p_round)` as the assigned instructor. It returns:

- `students`: ID, nickname, score, correct/wrong/timeout counts, total and average time, accuracy, early-answer count and submission timestamp.
- `summary`: submitted/incomplete counts; averages of scores, correct/wrong/timeout counts, total answering time and per-student mean answering time; average accuracy; early-answer totals.
- `questions`: number of submitted students assigned the question, correct/wrong/timeout counts, average time, accuracy and `students_under_half_time`.

`summary.students_with_under_half_answers` counts each qualifying student once. `summary.answers_under_half_time` counts every qualifying selection. `questions[].students_under_half_time` answers “how many students submitted before half of this question's duration?”

Empty reports have zero counts and null averages, not fabricated zero-percent accuracy. The instructor page shows the class leaderboard after the sitting ends, with expandable student timing details and per-round reports. CSV export remains planned.

## Session-wide instructor leaderboard

`session_report(p_session uuid)` is restricted to the assigned, allowlisted instructor after
session closure or the session cutoff. It finalizes expired runs before reporting; retries are
idempotent. It returns `session_id`, `question_count` (null if no rounds were released),
`students`, and `summary`.

Each student row contains `rank`, `player_id`, `nickname`, `name`, `total_points`, `best_streak`,
`rounds_completed`, `correct_count`, `wrong_count`, `timeout_count`, `answers_under_half_time`,
`total_answer_seconds`, `accuracy_percent`, and `average_answer_seconds`. Display names use
Google `full_name`, then `name`, then nickname. Points descend and total answering time ascends;
exact ties share a SQL `rank()` (1, 1, 3). Only submitted rounds count, including started runs
finalized at closure. Joined students who never started a round have no standings row.

Accuracy is total correct / total questions in submitted rounds × 100; average answer time is
total answering time / that same denominator. With the shared configuration the denominator is
`question_count × rounds_completed`. Migration 003 already replaced the historical `/30`
generated columns with configurable-count formulas; the session report calculates ratios
explicitly from release counts. The existing `round_report` output shape is unchanged.

The session `summary` contains `submitted_students`, `students_joined`, `average_score`,
`average_correct_count`, `average_wrong_count`, `average_timeout_count`,
`average_total_answer_seconds`, `average_answer_seconds`, `average_accuracy_percent`,
`students_with_under_half_answers`, and `answers_under_half_time`. Averages weight each submitted
student equally, even if they completed different numbers of rounds. Empty summaries have zero
result counts and null averages; the UI displays an em dash for unavailable values.

The UI fetches this report once upon entering the ended state. Round details load on first
expansion via `round_report` and are retained across collapse/reopen. Errors offer an explicit
retry; state polling does not refetch completed reports. Preview mode shows an availability note
without fabricated results. No student route or RPC is changed.
