// How an Ask AI answer is laid out. The dashboard's own answer is always the headline. When the AI model wrote a reply
// too, it's a friendly line under the headline, never in its place, so a wrong AI sentence can't stand in for the
// books. Two answer shapes are read: { text (headline), friendly } and the older { text (the model's words), facts:
// { text (headline), bullets, table }, writtenBy: 'model' }.
// Lines a Partly / No answer needs in plain sight (what is still owed in all, where to record a payment): never folded
const KEEP_OPEN = /Settle page|In all, .* owes/;
export function answerParts(a) {
  const f = a.facts;
  // An open question Claude answered from the business snapshot: its answer is the answer
  if (a.writtenBy === 'claude') return { headline: a.text, friendly: null, bullets: null, table: null, folded: null };
  if (a.friendly !== undefined) return { headline: a.text, friendly: a.friendly || null, bullets: a.bullets, table: a.table, folded: null };
  if (a.writtenBy === 'model' && f && f.text) {
    const open = (f.bullets || []).filter((b) => KEEP_OPEN.test(b));
    const rest = (f.bullets || []).filter((b) => !KEEP_OPEN.test(b));
    return { headline: f.text, friendly: a.text || null, bullets: open.length ? open : null, table: null, folded: { ...f, bullets: rest } };
  }
  return { headline: a.text, friendly: null, bullets: a.bullets, table: a.table, folded: null };
}
