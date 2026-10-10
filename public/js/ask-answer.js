// How an Ask AI answer is laid out. The dashboard's own answer is always the headline. When the AI model wrote a reply
// too, it's a friendly line under the headline, never in its place, so a wrong AI sentence can't stand in for the
// books. Two answer shapes are read: { text (headline), friendly } and the older { text (the model's words), facts:
// { text (headline), bullets, table }, writtenBy: 'model' }.
export function answerParts(a) {
  const f = a.facts;
  if (a.friendly !== undefined) return { headline: a.text, friendly: a.friendly || null, bullets: a.bullets, table: a.table, folded: null };
  if (a.writtenBy === 'model' && f && f.text) return { headline: f.text, friendly: a.text || null, bullets: null, table: null, folded: f };
  return { headline: a.text, friendly: null, bullets: a.bullets, table: a.table, folded: null };
}
