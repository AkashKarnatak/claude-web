// Interactive answer UI for the engine's AskUserQuestion tool, replacing the
// generic Allow/Deny prompt. The tool routes through canUseTool like any
// permission; answering = allowing with `updatedInput.answers` filled in
// (question text → answer string, multi-select comma-separated) — the same
// contract the TUI's picker fulfills.
//
// Flow: step through questions (←/→ moves freely, drafts are remembered),
// answering auto-advances; once every question has an answer, a review
// screen shows the full set — Enter submits, Esc/edit returns to the picker.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PermissionRequest } from '../store';
import { send } from '../ws';

interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** Per-question draft, kept while navigating so choices are remembered. */
interface Draft {
  selected: number; // highlighted row
  choice: number | 'other' | null; // single-select answer
  checked: Set<number>; // multi-select answer
  otherText: string;
}

export function parseQuestions(input: unknown): Question[] | null {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: Question[] = [];
  for (const q of questions) {
    if (typeof q?.question !== 'string' || !Array.isArray(q?.options)) return null;
    parsed.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o: unknown): o is QuestionOption => typeof (o as QuestionOption)?.label === 'string')
        .map((o: QuestionOption) => ({
          label: o.label,
          description: o.description ?? '',
          preview: o.preview,
        })),
    });
  }
  return parsed;
}

export function QuestionPrompt({ req, questions }: { req: PermissionRequest; questions: Question[] }) {
  const [idx, setIdx] = useState(0);
  const [review, setReview] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    questions.map(() => ({ selected: 0, choice: null, checked: new Set<number>(), otherText: '' })),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  const q = questions[idx];
  const draft = drafts[idx];
  const otherIdx = q.options.length; // the trailing "Other" row
  const onOther = draft.selected === otherIdx;

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...p } : d)));

  // Focus follows the screen and the highlighted row: review container, the
  // free-text input when "Other" is selected, else the option list.
  useEffect(() => {
    if (review) reviewRef.current?.focus();
    else if (onOther) otherRef.current?.focus();
    else listRef.current?.focus();
  }, [review, onOther, idx]);

  /** The answer a question's draft currently amounts to, or null. */
  const answerOf = (i: number): string | null => {
    const d = drafts[i];
    const question = questions[i];
    if (question.multiSelect) {
      const labels = question.options.filter((_, j) => d.checked.has(j)).map((o) => o.label);
      if (d.otherText.trim()) labels.push(d.otherText.trim());
      return labels.length > 0 ? labels.join(', ') : null;
    }
    if (d.choice === 'other') return d.otherText.trim() || null;
    if (d.choice !== null) return question.options[d.choice]?.label ?? null;
    return null;
  };

  const finish = () => {
    const answers: Record<string, string> = {};
    questions.forEach((question, i) => {
      answers[question.question] = answerOf(i) ?? '';
    });
    send({
      t: 'permission',
      reqId: req.reqId,
      decision: 'allow',
      updatedInput: { ...(req.input as Record<string, unknown>), answers },
    });
  };

  /** After answering: review once everything is answered (so edits from the
   * review screen bounce right back), else the next/first unanswered one. */
  const advance = (fromIdx: number, next: Draft[] | null = null) => {
    const all = next ?? drafts;
    const answered = (i: number) => {
      const d = all[i];
      const question = questions[i];
      if (question.multiSelect) return d.checked.size > 0 || !!d.otherText.trim();
      return d.choice === 'other' ? !!d.otherText.trim() : d.choice !== null;
    };
    if (questions.every((_, i) => answered(i))) {
      setReview(true);
      return;
    }
    for (let step = 1; step <= questions.length; step++) {
      const i = (fromIdx + step) % questions.length;
      if (!answered(i)) {
        setIdx(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
    if (i === otherIdx) {
      patch(idx, { selected: otherIdx });
      return;
    }
    if (q.multiSelect) {
      const checked = new Set(draft.checked);
      if (checked.has(i)) checked.delete(i);
      else checked.add(i);
      patch(idx, { checked });
    } else {
      const next = drafts.map((d, j) => (j === idx ? { ...d, selected: i, choice: i as Draft['choice'] } : d));
      setDrafts(next);
      advance(idx, next);
    }
  };

  const submitCurrent = () => {
    if (q.multiSelect) {
      if (draft.checked.size > 0 || draft.otherText.trim()) advance(idx);
    } else if (onOther) {
      if (draft.otherText.trim()) {
        const next = drafts.map((d, j) => (j === idx ? { ...d, choice: 'other' as const } : d));
        setDrafts(next);
        advance(idx, next);
      }
    } else {
      activate(draft.selected);
    }
  };

  const dismiss = () =>
    send({
      t: 'permission',
      reqId: req.reqId,
      decision: 'deny',
      reason: 'User dismissed the question dialog',
    });

  // ---- review screen ----

  if (review) {
    const onReviewKeys = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
      } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setReview(false);
      }
    };
    return (
      <div
        className="permission-popover question-prompt"
        ref={reviewRef}
        tabIndex={-1}
        onKeyDown={onReviewKeys}
      >
        <div className="question-head">
          <span className="question-chip">Review</span>
        </div>
        <div className="question-text">Is this what you want?</div>
        <div className="question-options">
          {questions.map((question, i) => (
            <button
              key={i}
              className="question-option review-row"
              title="Edit this answer"
              onClick={() => {
                setReview(false);
                setIdx(i);
              }}
            >
              <span className="question-option-body">
                <span className="question-desc">
                  {question.header ? `${question.header} — ` : ''}
                  {question.question}
                </span>
                <span className="question-label">{answerOf(i)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="permission-actions question-actions">
          <span className="question-hint">enter to submit · esc to edit · click a row to change it</span>
          <button className="btn deny" onClick={() => setReview(false)}>
            Edit
          </button>
          <button className="btn allow" onClick={finish}>
            Submit
          </button>
        </div>
      </div>
    );
  }

  // ---- question screen ----

  const rows = otherIdx + 1;
  const onKeyDown = (e: KeyboardEvent) => {
    const typing = e.target === otherRef.current;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      patch(idx, { selected: (draft.selected + 1) % rows });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      patch(idx, { selected: (draft.selected - 1 + rows) % rows });
    } else if (e.key === 'ArrowLeft' && !typing) {
      if (idx > 0) {
        e.preventDefault();
        setIdx(idx - 1);
      }
    } else if (e.key === 'ArrowRight' && !typing) {
      if (idx + 1 < questions.length) {
        e.preventDefault();
        setIdx(idx + 1);
      } else if (questions.every((_, i) => answerOf(i) !== null)) {
        e.preventDefault();
        setReview(true);
      }
    } else if (e.key === ' ' && q.multiSelect && !onOther) {
      e.preventDefault();
      activate(draft.selected);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (/^[1-9]$/.test(e.key) && !typing) {
      const i = Number(e.key) - 1;
      if (i < q.options.length) {
        e.preventDefault();
        patch(idx, { selected: i });
        activate(i);
      }
    }
  };

  const preview = !onOther ? q.options[draft.selected]?.preview : undefined;
  const navHint = questions.length > 1 ? '←→ questions · ' : '';

  return (
    <div className="permission-popover question-prompt" onKeyDown={onKeyDown}>
      <div className="question-head">
        {q.header && <span className="question-chip">{q.header}</span>}
        {questions.length > 1 && (
          <span className="question-progress">
            {questions.map((_, i) => (
              <span
                key={i}
                className={`question-dot${i === idx ? ' current' : ''}${answerOf(i) !== null ? ' answered' : ''}`}
              />
            ))}
            {idx + 1} / {questions.length}
          </span>
        )}
      </div>
      <div className="question-text">{q.question}</div>
      <div className="question-options" ref={listRef} tabIndex={-1}>
        {q.options.map((o, i) => {
          const chosen = q.multiSelect ? draft.checked.has(i) : draft.choice === i;
          return (
            <button
              key={i}
              className={`question-option${i === draft.selected ? ' selected' : ''}${chosen ? ' chosen' : ''}`}
              onMouseEnter={() => patch(idx, { selected: i })}
              onClick={() => activate(i)}
            >
              <span className="question-mark">
                {q.multiSelect ? (chosen ? '☑' : '☐') : chosen ? '●' : i === draft.selected ? '❯' : ''}
              </span>
              <span className="question-option-body">
                <span className="question-label">{o.label}</span>
                {o.description && <span className="question-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
        <div
          className={`question-option question-other${onOther ? ' selected' : ''}${draft.choice === 'other' ? ' chosen' : ''}`}
          onMouseEnter={() => patch(idx, { selected: otherIdx })}
          onClick={() => patch(idx, { selected: otherIdx })}
        >
          <span className="question-mark">{draft.choice === 'other' ? '●' : onOther ? '❯' : ''}</span>
          <span className="question-option-body">
            <span className="question-label">Other</span>
            <input
              ref={otherRef}
              className="question-other-input"
              value={draft.otherText}
              onChange={(e) => patch(idx, { otherText: e.target.value })}
              onFocus={() => patch(idx, { selected: otherIdx })}
              placeholder="Type your own answer…"
            />
          </span>
        </div>
      </div>
      {preview && <pre className="question-preview">{preview}</pre>}
      <div className="permission-actions question-actions">
        <span className="question-hint">
          {navHint}
          {q.multiSelect ? 'space to toggle · enter to confirm' : 'enter to answer'} · esc to
          dismiss
        </span>
        {q.multiSelect && (
          <button
            className="btn allow"
            onClick={submitCurrent}
            disabled={draft.checked.size === 0 && !draft.otherText.trim()}
          >
            Confirm
          </button>
        )}
      </div>
    </div>
  );
}
