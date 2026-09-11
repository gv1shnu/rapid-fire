# Round score and response metrics

Every successful `submit_round` persists one record per `(session_id, player_id, round_id)` in `public.round_runs`. Repeated submissions return the original debrief and do not add another score or metric record. No scoring or analytics is sent with a question or answer response.

## Per student, per round

| Metric                   | Definition                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score                    | Sum of the 30 server-computed question scores; wrong answers and timeouts score **0**, never a deduction. Database constraints prohibit negative scores. |
| Correct                  | Number of accepted correct answers.                                                                                                                      |
| Wrong                    | Number of accepted wrong selections.                                                                                                                     |
| Timeout                  | No selection, or an answer received after the 13-second server deadline (12 seconds + 1 second latency grace).                                           |
| Total answer time        | Sum of server-measured elapsed times for all 30 MCQs.                                                                                                    |
| Average answer time      | Total answer time divided by 30, in seconds.                                                                                                             |
| Accuracy                 | Correct divided by 30, multiplied by 100. Timeouts contribute zero correct answers.                                                                      |
| Answers before half-time | Number of selections received **strictly before 6 seconds** elapsed. Both right and wrong selections count. Exactly 6 seconds does not count.            |

Correct + wrong + timeout = 30. Timeouts are reported separately from wrong selections to distinguish lack of an answer from a misconception. If a combined unsuccessful count is needed, it is wrong + timeout.

The clock is the database clock, never a browser-supplied duration. Average times include timeout durations as actually recorded, including late/offline submissions beyond 13 seconds. These are observed response times, not capped at the allotted duration. Total answering time excludes story panels, breaks and time between questions.

## Instructor report

Call `supabase.rpc('round_report', { p_session: sessionId, p_round: roundNumber })` after the sitting closes or expires. The database verifies the caller's domain, instructor allowlist entry and ownership of that session. Other students, other instructors and anonymous callers cannot retrieve it. During a sitting, the endpoint refuses detailed reports, preserving the existing counts-only instructor rule.

The JSON result contains:

- `students`: each submitted student's ID, nickname, score, correct/wrong/timeout counts, total/average answering time, accuracy, early-answer count and submission timestamp.
- `summary`: number submitted and number of started-but-incomplete runs; average score, correct/wrong/timeout counts, total answering time per student, per-MCQ answer time, and average accuracy percentage.
- `questions`: per-question submitted student count, correct/wrong/timeout counts, mean response time, accuracy, and `students_under_half_time`.

Half-time counts have explicit denominators:

- `questions[].students_under_half_time`: how many submitted students answered **that MCQ** in under 6 seconds.
- `students[].answers_under_half_time`: how many of a student's 30 selections met the threshold.
- `summary.students_with_under_half_answers`: distinct submitted students with at least one under-6-second selection. A student is counted once here.
- `summary.answers_under_half_time`: total qualifying selections; a student can contribute up to 30.

Question statistics only count students who received that question and submitted the round, since draws differ. Class statistics exclude incomplete rounds, which are counted separately. With no submitted rounds, averages are `null` and counts are zero; there is no fabricated 0% accuracy.

This is implemented in `supabase/migrations/202609110002_round_metrics.sql`, including a backfill for existing submitted rounds. The instructor report UI and CSV export remain future work; the single-question practice preview does not log real student records.
