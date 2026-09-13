import { useEffect, useState } from 'react';
import {
  instructorRpc,
  parseRoundReport,
  parseSessionReport,
  type ReportMetrics,
  type ReportSummary,
  type RoundPool,
} from './instructor-api';

const value = (n: number | null, suffix = '') =>
  n === null ? '—' : `${Number(n.toFixed(1))}${suffix}`;

// A mounted report loads once, independently of the instructor state poll.
// Unmounting (including sign-out/session changes) discards late responses.
function useReport<T extends { session_id: string }>(
  session: string,
  round: number | null,
  enabled: boolean,
  parse: (x: unknown) => T,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      try {
        const payload = await instructorRpc<unknown>(
          round === null ? 'session_report' : 'round_report',
          {
            p_session: session,
            ...(round === null ? {} : { p_round: round }),
          },
        );
        const report = parse(payload);
        if (
          report.session_id !== session ||
          (round !== null &&
            (!('round_id' in report) || report.round_id !== round))
        )
          throw new Error('Invalid report response. Please reconnect.');
        if (active) setData(report);
      } catch (err) {
        if (active)
          setError(
            err instanceof Error
              ? err.message
              : 'Could not load the report. Please reconnect.',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [session, round, enabled, parse, attempt]);
  return {
    data,
    error,
    retry: () => {
      setError('');
      setAttempt((n) => n + 1);
    },
  };
}
function ReportError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div>
      <p className="form-error" role="alert">
        {error}
      </p>
      <button className="plain-button" onClick={retry}>
        Retry report
      </button>
    </div>
  );
}
function Summary({
  summary,
  totalTime,
  joined,
}: {
  summary: ReportSummary;
  totalTime: number | null;
  joined?: number;
}) {
  const cells: [string, string | number][] = [
    ['Students with results', summary.submitted_students],
    ...(joined === undefined
      ? []
      : [['Students joined', joined] as [string, number]]),
    ['Average points', value(summary.average_score)],
    ['Average accuracy', value(summary.average_accuracy_percent, '%')],
    ['Average correct', value(summary.average_correct_count)],
    ['Average wrong', value(summary.average_wrong_count)],
    ['Average timeouts', value(summary.average_timeout_count)],
    ['Average time / question', value(summary.average_answer_seconds, ' s')],
    ['Average total answering time', value(totalTime, ' s')],
    ['Answers under half time', summary.answers_under_half_time],
    [
      'Students answering under half time',
      summary.students_with_under_half_answers,
    ],
  ];
  return (
    <dl className="release-settings report-summary">
      {cells.map(([label, content]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{content}</dd>
        </div>
      ))}
    </dl>
  );
}
function Metrics({ stats }: { stats: ReportMetrics }) {
  return (
    <>
      <td>{value(stats.accuracy_percent, '%')}</td>
      <td>
        {stats.correct_count} / {stats.wrong_count} / {stats.timeout_count}
      </td>
      <td>{value(stats.average_answer_seconds, ' s')}</td>
    </>
  );
}
function StudentDetails({ stats }: { stats: ReportMetrics }) {
  return (
    <dl className="report-student-details">
      <div>
        <dt>Total answering time</dt>
        <dd>{value(stats.total_answer_seconds, ' s')}</dd>
      </div>
      <div>
        <dt>Answers under half time</dt>
        <dd>{stats.answers_under_half_time}</dd>
      </div>
    </dl>
  );
}
function RoundDrilldown({
  session,
  round,
}: {
  session: string;
  round: RoundPool;
}) {
  const [requested, setRequested] = useState(false);
  const { data, error, retry } = useReport(
    session,
    round.id,
    requested,
    parseRoundReport,
  );
  return (
    <details
      className="report-round"
      onToggle={(e) => {
        if (e.currentTarget.open) setRequested(true);
      }}
    >
      <summary>
        Round {round.id} · {round.title}
      </summary>
      {requested &&
        (error ? (
          <ReportError error={error} retry={retry} />
        ) : !data ? (
          <p role="status">Loading round report…</p>
        ) : (
          <>
            <Summary
              summary={data.summary}
              totalTime={data.summary.average_round_answer_seconds}
            />
            <p>
              Incomplete runs: {data.summary.incomplete_students} · Half-time
              threshold: {value(data.half_time_seconds, ' s')}
            </p>
            <h4>Students</h4>
            {data.students.length === 0 ? (
              <p>No submitted results for this round.</p>
            ) : (
              <div
                className="report-table-scroll"
                role="region"
                aria-label={`Round ${round.id} student stats`}
                tabIndex={0}
              >
                <table className="report-table">
                  <caption>Round {round.id} student results</caption>
                  <thead>
                    <tr>
                      <th scope="col">Student</th>
                      <th scope="col">Points</th>
                      <th scope="col">Accuracy</th>
                      <th scope="col">Correct / wrong / timeout</th>
                      <th scope="col">Time / question</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.students.map((s) => (
                      <tr key={s.player_id}>
                        <th scope="row">
                          <details>
                            <summary>{s.nickname}</summary>
                            <StudentDetails stats={s} />
                            <p>
                              Submitted{' '}
                              {new Date(s.submitted_at).toLocaleString()}
                            </p>
                          </details>
                        </th>
                        <td>{s.score}</td>
                        <Metrics stats={s} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h4>Questions</h4>
            {data.questions.length === 0 ? (
              <p>No question results for this round.</p>
            ) : (
              <div
                className="report-table-scroll"
                role="region"
                aria-label={`Round ${round.id} question stats`}
                tabIndex={0}
              >
                <table className="report-table">
                  <caption>
                    Question IDs refer to the frozen question set; counts
                    include only students assigned each question.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Question ID</th>
                      <th scope="col">Students</th>
                      <th scope="col">Correct / wrong / timeout</th>
                      <th scope="col">Accuracy</th>
                      <th scope="col">Average time</th>
                      <th scope="col">Under half time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.questions.map((q) => (
                      <tr key={q.question_id}>
                        <th scope="row">{q.question_id}</th>
                        <td>{q.submitted_students}</td>
                        <td>
                          {q.correct_count} / {q.wrong_count} /{' '}
                          {q.timeout_count}
                        </td>
                        <td>{value(q.accuracy_percent, '%')}</td>
                        <td>{value(q.average_answer_seconds, ' s')}</td>
                        <td>{q.students_under_half_time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ))}
    </details>
  );
}
export function InstructorReports({
  session,
  rounds,
}: {
  session: string;
  rounds: RoundPool[];
}) {
  const { data, error, retry } = useReport(
    session,
    null,
    true,
    parseSessionReport,
  );
  return (
    <section
      className="leaderboard instructor-report"
      aria-labelledby="report-heading"
    >
      <p className="eyebrow">CLASS RESULTS</p>
      <h2 id="report-heading">Leaderboard</h2>
      {error ? (
        <ReportError error={error} retry={retry} />
      ) : !data ? (
        <p role="status">Loading class results…</p>
      ) : (
        <>
          <p>
            {data.question_count === null
              ? 'No rounds were released.'
              : `${data.question_count} questions per round. Results cover submitted rounds, including runs finalized at closure.`}{' '}
            Expand a student for timing details.
          </p>
          <Summary
            summary={data.summary}
            joined={data.summary.students_joined}
            totalTime={data.summary.average_total_answer_seconds}
          />
          {data.students.length === 0 ? (
            <p role="status">
              No submitted student results. Class averages are unavailable.
            </p>
          ) : (
            <div
              className="report-table-scroll"
              role="region"
              aria-label="Session standings"
              tabIndex={0}
            >
              <table className="report-table">
                <caption>
                  Ranked by total points, then shortest total answering time.
                  Equal results share a rank.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Student</th>
                    <th scope="col">Points</th>
                    <th scope="col">Accuracy</th>
                    <th scope="col">Correct / wrong / timeout</th>
                    <th scope="col">Time / question</th>
                    <th scope="col">Best streak</th>
                    <th scope="col">Rounds completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.students.map((s) => (
                    <tr key={s.player_id}>
                      <td>{s.rank}</td>
                      <th scope="row">
                        <details>
                          <summary>{s.name}</summary>
                          <p>Nickname: {s.nickname}</p>
                          <StudentDetails stats={s} />
                        </details>
                      </th>
                      <td>{s.total_points}</td>
                      <Metrics stats={s} />
                      <td>{s.best_streak}</td>
                      <td>{s.rounds_completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="report-note">
            Timeouts stay in the accuracy and average-time denominator.
            Never-served questions contribute zero observed time. Class averages
            weight each student equally; — means no data.
          </p>
          <h3>Per-round reports</h3>
          {rounds.map((r) => (
            <RoundDrilldown key={r.id} session={session} round={r} />
          ))}
        </>
      )}
    </section>
  );
}
