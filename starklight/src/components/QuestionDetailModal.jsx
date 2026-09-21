import Modal from './Modal'
import RichHtml from './RichHtml'
import { getSolutionCode, getConstraintsBlock } from '../lib/helpers'

export default function QuestionDetailModal({ question, onClose }) {
  if (!question) return null
  const pq = question.programming_question || {}
  const code = getSolutionCode(question)
  const constraints = getConstraintsBlock(question)

  return (
    <Modal open={!!question} onClose={onClose} title="Question Detail" wide>
      <Section title="Problem Statement">
        <RichHtml html={question.question_data} />
      </Section>
      {pq.input_format && (
        <Section title="Input Format">
          <RichHtml html={pq.input_format} />
        </Section>
      )}
      {pq.output_format && (
        <Section title="Output Format">
          <RichHtml html={pq.output_format} />
        </Section>
      )}
      {constraints && (
        <Section title="Constraints / Test Cases">
          <pre className="bg-black/40 border border-theme rounded-lg p-3 text-xs whitespace-pre-wrap">{constraints}</pre>
        </Section>
      )}
      {code && (
        <Section title="Solution Code">
          <pre className="bg-black/40 border border-theme rounded-lg p-3 text-xs whitespace-pre-wrap overflow-x-auto">{code}</pre>
        </Section>
      )}
      <Section title="Metadata">
        <div className="text-sm text-body-app space-y-1">
          <div>Type: {question.question_type || '—'}</div>
          <div>Difficulty: {question.manual_difficulty || question.automatic_difficulty || '—'}</div>
          <div>Subject: {question.subject?.name || '—'}</div>
          <div>Topic: {question.topic?.name || '—'}</div>
          <div>Tags: {Array.isArray(question.tags) ? question.tags.map(t => t.name).join(', ') : '—'}</div>
        </div>
      </Section>
    </Modal>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted mb-1.5">{title}</h3>
      {children}
    </div>
  )
}
