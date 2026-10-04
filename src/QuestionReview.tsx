import { useState } from 'react';
import type { DraftReview, ReviewBody, ReviewQuestion } from './instructor-api';

export type QuestionEdit = {
  stem: string;
  options: { id: number; text: string }[];
  correct: number;
  explanation: string;
};

type Props = {
  review: DraftReview;
  busy: boolean;
  onSwap: (round: number, question: number) => void;
  onEdit: (
    round: number,
    question: number,
    edit: QuestionEdit,
  ) => Promise<boolean>;
  onReset: (round: number, question: number) => void;
};

const letters = ['A', 'B', 'C', 'D'];

function Body({ body }: { body: ReviewBody | null }) {
  if (!body) return null;
  return (
    <>
      {body.code_html && (
        <pre>
          <code>{body.code_html}</code>
        </pre>
      )}
      {body.table_json && (
        <table>
          <thead>
            <tr>
              {body.table_json.cols.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.table_json.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c === null ? 'NULL' : String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Editor({
  question,
  busy,
  onSave,
  onCancel,
}: {
  question: ReviewQuestion;
  busy: boolean;
  onSave: (edit: QuestionEdit) => void;
  onCancel: () => void;
}) {
  const [stem, setStem] = useState(question.stem);
  const [texts, setTexts] = useState(
    question.options.map((o) => o.body.text ?? ''),
  );
  const [correct, setCorrect] = useState(
    question.options.find((o) => o.is_correct)!.id,
  );
  const [explanation, setExplanation] = useState(question.explanation);
  const id = `edit-${question.question_id}`;
  const valid =
    stem.trim().length >= 1 &&
    stem.trim().length <= 500 &&
    explanation.trim().length >= 1 &&
    explanation.trim().length <= 1000 &&
    texts.every((t) => t.trim().length >= 1 && t.trim().length <= 300);
  return (
    <form
      className="question-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        onSave({
          stem,
          options: question.options.map((o, i) => ({
            id: o.id,
            text: texts[i],
          })),
          correct,
          explanation,
        });
      }}
    >
      <label htmlFor={`${id}-stem`}>Question</label>
      <textarea
        id={`${id}-stem`}
        value={stem}
        maxLength={500}
        rows={2}
        onChange={(event) => setStem(event.target.value)}
      />
      <fieldset>
        <legend>Options · select the correct answer</legend>
        {question.options.map((o, i) => (
          <div className="editor-option" key={o.id}>
            <input
              type="radio"
              name={`${id}-correct`}
              checked={correct === o.id}
              onChange={() => setCorrect(o.id)}
              aria-label={`Option ${letters[i]} is correct`}
            />
            <span className="option-letter" aria-hidden="true">
              {letters[i]}
            </span>
            <input
              type="text"
              value={texts[i]}
              maxLength={300}
              aria-label={`Option ${letters[i]} text`}
              onChange={(event) =>
                setTexts((prev) =>
                  prev.map((t, j) => (j === i ? event.target.value : t)),
                )
              }
            />
          </div>
        ))}
      </fieldset>
      <label htmlFor={`${id}-explanation`}>
        Explanation shown in the debrief
      </label>
      <textarea
        id={`${id}-explanation`}
        value={explanation}
        maxLength={1000}
        rows={2}
        onChange={(event) => setExplanation(event.target.value)}
      />
      {!valid && (
        <p className="editor-hint" role="status">
          Every field needs text. Questions allow 500 characters, options 300,
          explanations 1000.
        </p>
      )}
      <div className="approval-actions">
        <button className="start-timer" type="submit" disabled={!valid || busy}>
          {busy ? 'Saving…' : 'Save question'}
        </button>
        <button
          className="plain-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function QuestionReview({
  review,
  busy,
  onSwap,
  onEdit,
  onReset,
}: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const total = review.rounds.reduce((n, r) => n + r.questions.length, 0);
  const edited = review.rounds.reduce(
    (n, r) => n + r.questions.filter((q) => q.edited).length,
    0,
  );
  return (
    <section className="question-review" aria-labelledby="review-title">
      <div className="panel-heading">
        <h2 id="review-title">Review the questions</h2>
        <span className="muted">
          {total} QUESTIONS{edited ? ` · ${edited} EDITED` : ''}
        </span>
      </div>
      <p className="review-intro">
        These are the exact questions every student will get, with answers
        marked. Swap any for another from the same lecture, or edit the wording.
        Edits apply to this rapid fire only, and the join link appears once you
        start.
      </p>
      {review.rounds.map((round, index) => {
        const spare = round.available - round.questions.length;
        return (
          <details key={round.id} className="review-round" open={index === 0}>
            <summary>
              <span className="review-round-number">
                {String(round.id).padStart(2, '0')}
              </span>
              <span className="review-round-title">{round.title}</span>
              <span className="muted">
                {round.questions.length} of {round.available}
              </span>
            </summary>
            <ol>
              {round.questions.map((q, n) => (
                <li key={q.question_id} className="review-question">
                  {editing === q.question_id ? (
                    <Editor
                      question={q}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(edit) =>
                        void onEdit(round.id, q.question_id, edit).then(
                          (ok) => {
                            if (ok) setEditing(null);
                          },
                        )
                      }
                    />
                  ) : (
                    <>
                      <div className="review-question-head">
                        <span className="muted">Q{n + 1}</span>
                        {q.edited && (
                          <span className="edited-pill">EDITED</span>
                        )}
                      </div>
                      <h3>{q.stem}</h3>
                      <Body body={q.body} />
                      {q.body?.text && <p>{q.body.text}</p>}
                      <ul className="review-options">
                        {q.options.map((o, i) => (
                          <li
                            key={o.id}
                            className={o.is_correct ? 'correct' : undefined}
                          >
                            <span className="option-letter" aria-hidden="true">
                              {letters[i]}
                            </span>
                            <span>
                              {o.body.text}
                              <Body body={o.body} />
                            </span>
                            {o.is_correct && (
                              <span className="correct-mark">
                                Correct answer
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <p className="review-explanation">
                        <strong>Why:</strong> {q.explanation}
                      </p>
                      <div className="review-actions">
                        <button
                          className="plain-button"
                          disabled={busy || editing !== null}
                          onClick={() => setEditing(q.question_id)}
                        >
                          Edit
                        </button>
                        <button
                          className="plain-button"
                          disabled={busy || editing !== null || spare < 1}
                          title={
                            spare < 1
                              ? 'Every question in this lecture is already in use'
                              : undefined
                          }
                          onClick={() => onSwap(round.id, q.question_id)}
                        >
                          Swap for another
                        </button>
                        {q.edited && (
                          <button
                            className="plain-button"
                            disabled={busy || editing !== null}
                            onClick={() => onReset(round.id, q.question_id)}
                          >
                            Undo edits
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </details>
        );
      })}
    </section>
  );
}
