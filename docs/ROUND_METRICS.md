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

Empty reports have zero counts and null averages, not fabricated zero-percent accuracy. The report UI and CSV export are planned; the protected RPC and stored metrics are implemented and tested.
