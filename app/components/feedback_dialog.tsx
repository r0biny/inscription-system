"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export function FeedbackDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (message: string) => Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, submitting]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = feedback.trim();
    if (!message) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(message);
      onClose();
    } catch (submissionError) {
      setError((submissionError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="feedback-dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title">
        <button className="feedback-dialog-close" type="button" onClick={onClose} disabled={submitting} aria-label="关闭反馈窗口"><X size={17} /></button>
        <h2 id="feedback-dialog-title">提交反馈</h2>
        <p>如果你遇到操作问题，或对界面有建议，可以在这里告诉我们。</p>
        <form onSubmit={submit}>
          <label htmlFor="participant-feedback">反馈内容</label>
          <textarea id="participant-feedback" required maxLength={1000} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="请描述你遇到的问题或建议……" />
          <div className="feedback-dialog-meta"><span>{Array.from(feedback).length} / 1000</span></div>
          {error && <p className="feedback-dialog-error" role="alert">{error}</p>}
          <div className="feedback-dialog-actions">
            <button type="button" className="feedback-cancel-button" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="feedback-submit-button" disabled={submitting || !feedback.trim()}>{submitting ? "正在提交…" : "提交反馈"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
