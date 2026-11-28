import React, { useEffect, useState } from 'react';
import { supabase } from '../cloud/supabase';
import { todayISO } from '../lib/workouts';

interface Entry { id: string; date: string; description: string; status: string }
interface Item { entry_id: string; name: string; kcal: number | null; protein: number | null }
interface Estimate {
  name: string; quantity: number; unit: string; grams: number | null; state: string;
  kcal: number | null; protein: number | null; source: string; sourceId: string | null;
  assumptions: string; version: string; kcalPerGram: number | null; proteinPerGram: number | null;
}
const nonNegative = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const validEstimate = (v: unknown): v is Estimate => {
  if (!v || typeof v !== 'object') return false;
  const x = v as Estimate;
  return typeof x.name === 'string' && x.name.trim().length > 0 && x.name.length <= 200
    && typeof x.quantity === 'number' && Number.isFinite(x.quantity) && x.quantity > 0 && x.quantity < 100000
    && ['g','oz','cup','tbsp','piece','serving'].includes(x.unit)
    && ['raw','cooked','unknown'].includes(x.state)
    && ['USDA','generic'].includes(x.source)
    && typeof x.assumptions === 'string'
    && [x.grams,x.kcal,x.protein,x.kcalPerGram,x.proteinPerGram].every(v => v === null || nonNegative(v) !== null);
};

/** Adapter for the existing normalized diary. Legacy nutrition targets stay unchanged. */
export function FoodDiary({ clientId, readOnly = false }: { clientId: string; readOnly?: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [estimates, setEstimates] = useState<Estimate[] | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const scope = React.useRef(0);
  const clearAnalysis = () => { setEstimates(null); setQuestions([]); setReviewed(false); };
  const locked = busy || analyzing;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = React.useRef<string | null>(null);
  const load = async () => {
    const [a, b] = await Promise.all([
      supabase!.from('food_entries').select('id,date,description,status').eq('client_id', clientId).order('date', { ascending: false }),
      supabase!.from('food_items').select('entry_id,name,kcal,protein').eq('client_id', clientId)
    ]);
    if (a.error || b.error) throw a.error ?? b.error;
    return { entries: a.data as Entry[], items: b.data as Item[] };
  };
  useEffect(() => {
    let active = true;
    scope.current++;
    setReady(false); setEntries([]); setItems([]); setError(null);
    setDescription(''); setDate(todayISO()); setKcal(''); setProtein('');
    setAnalyzing(false); setBusy(false); clearAnalysis(); key.current = null;
    if (supabase) void load().then((data) => { if (active) { setEntries(data.entries); setItems(data.items); setReady(true); } })
      .catch(() => { if (active) setError('Food diary could not load. Reload to retry.'); });
    return () => { active = false; scope.current++; };
  }, [clientId]);
  const analyze = async () => {
    if (!supabase || !ready || locked || readOnly || !description.trim()) return;
    const requestScope = scope.current;
    setAnalyzing(true); clearAnalysis(); setError(null);
    try {
      const { data, error: err } = await supabase.functions.invoke('food-parse', { body: { description: description.trim() } });
      if (scope.current !== requestScope) return;
      if (err) {
        const response = err.context;
        const status = response instanceof Response ? response.status : 0;
        throw new Error(status === 429 ? 'Analysis limit reached. Enter values manually or try later.' : 'Analysis unavailable. Enter foods manually.');
      }
      if (!data || !Array.isArray(data.items) || data.items.length > 20 || !data.items.every(validEstimate)) throw new Error('Analysis unavailable. Enter foods manually.');
      const prompts: string[] = Array.isArray(data.questions) ? data.questions.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0).slice(0,5) : [];
      setQuestions(prompts);
      if (data.items.length) setEstimates(data.items.map((x: Estimate) => ({
        name: x.name, quantity: x.quantity, unit: x.unit, grams: x.grams, state: x.state,
        kcal: x.kcal, protein: x.protein, source: x.source, sourceId: typeof x.sourceId === 'string' ? x.sourceId : null,
        assumptions: x.assumptions, version: 'food-v1', kcalPerGram: x.kcalPerGram, proteinPerGram: x.proteinPerGram
      })));
      else if (!prompts.length) throw new Error('No foods identified. Add more details or enter values manually.');
    } catch (err) {
      if (scope.current === requestScope) setError(err instanceof Error ? err.message : 'Analysis unavailable. Enter foods manually.');
    } finally { if (scope.current === requestScope) setAnalyzing(false); }
  };
  const editEstimate = (index: number, field: 'kcal' | 'protein', value: string) => {
    const amount = value === '' ? null : nonNegative(Number(value));
    setReviewed(false);
    setEstimates(previous => previous?.map((item, i) => i === index ? {
      ...item, [field]: amount, source: 'manual', sourceId: null, kcalPerGram: null, proteinPerGram: null,
      assumptions: 'AI estimate reviewed and edited by client'
    } : item) ?? null);
  };
  if (!supabase) return null;
  return <section className="bg-white border border-gray-100 rounded-[28px] p-4 sm:p-6 my-4 min-w-0">
    <h2 className="text-sm font-bold mb-3">Food diary</h2>
    {error && <p role="alert" className="text-sm text-red-700 mb-3">{error}</p>}
    {!readOnly && <form className="grid gap-3 min-w-0" onSubmit={async (event) => {
      event.preventDefault();
      if (!ready || locked || (estimates && !reviewed)) return;
      const requestScope = scope.current;
      setBusy(true); setError(null);
      key.current ??= crypto.randomUUID();
      try {
        const { error: err } = await supabase!.rpc('pf_save_food_entry', {
          p_client_id: clientId, p_existing_id: null, p_date: date,
          p_description: description.trim(), p_key: key.current,
          p_status: estimates ? (questions.length || estimates.some(item => item.kcal === null || item.protein === null) ? 'incomplete' : 'estimate') : (kcal === '' || protein === '' ? 'incomplete' : 'confirmed'),
          p_items: estimates ?? [{ name: description.trim().slice(0, 200), quantity: 1, unit: 'serving', state: 'unknown',
            kcal: kcal === '' ? null : Number(kcal), protein: protein === '' ? null : Number(protein),
            source: 'manual', assumptions: 'Entered by client', version: 'food-v1' }]
        });
        if (err) throw err;
        const data = await load(); if (scope.current !== requestScope) return;
        setEntries(data.entries); setItems(data.items);
        setDescription(''); setKcal(''); setProtein(''); clearAnalysis(); key.current = null;
      } catch { if (scope.current === requestScope) setError('Meal was not confirmed saved. Retry to check the same entry safely.'); }
      finally { if (scope.current === requestScope) setBusy(false); }
    }}>
      <label className="text-sm">Date<input type="date" required disabled={locked} value={date} max={todayISO()} onChange={(e) => { setDate(e.target.value); key.current = null; }} className="block w-full min-w-0 border rounded-xl px-3 py-3 text-base" /></label>
      <label className="text-sm">Food and portion<textarea aria-label="Food and portion" required disabled={locked} maxLength={2000} value={description} onChange={(e) => { setDescription(e.target.value); clearAnalysis(); setError(null); }} className="block w-full border rounded-xl p-3 text-base" /></label>
      <button type="button" disabled={!ready || locked || !description.trim()} onClick={() => void analyze()} className="min-h-[44px] rounded-full border border-gray-300 font-semibold disabled:opacity-40">{analyzing ? 'Analyzing…' : 'Analyze with AI'}</button>
      {questions.length > 0 && <div className="text-sm bg-gray-50 rounded-xl p-3" role="status"><p className="font-semibold">Please clarify your food description:</p><ul className="list-disc pl-5">{questions.map((question, i) => <li key={i}>{question}</li>)}</ul></div>}
      {estimates ? <div className="grid gap-3 min-w-0">
        <p className="text-sm font-semibold">Review AI estimates</p>
        <p className="text-xs text-gray-500">Check food, portion and estimated nutrients. Unknown values stay blank. To change the food or portion, edit the description and analyze again.</p>
        {estimates.map((item, i) => <div key={i} className="border rounded-xl p-3 grid gap-2 min-w-0">
          <p className="text-sm font-semibold break-words">{item.name}</p>
          <p className="text-xs text-gray-600">{item.quantity} {item.unit}{item.grams !== null ? ' · ' + item.grams + ' g' : ''} · {item.state} · {item.source}</p>
          {item.assumptions && <p className="text-xs text-gray-500 break-words">{item.assumptions}</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Calories (kcal)<input aria-label={'Estimated calories for ' + item.name} type="number" min="0" step="any" disabled={locked} value={item.kcal ?? ''} onChange={e => editEstimate(i, 'kcal', e.target.value)} className="block w-full min-w-0 border rounded-xl p-2 text-base" /></label>
            <label className="text-sm">Protein (g)<input aria-label={'Estimated protein for ' + item.name} type="number" min="0" step="any" disabled={locked} value={item.protein ?? ''} onChange={e => editEstimate(i, 'protein', e.target.value)} className="block w-full min-w-0 border rounded-xl p-2 text-base" /></label>
          </div>
        </div>)}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={locked} checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed these estimates</label>
        <button type="button" disabled={locked} onClick={clearAnalysis} className="text-sm underline text-left min-h-[44px]">Enter manually instead</button>
      </div> : <>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">Calories (kcal)<input type="number" min="0" step="any" disabled={locked} value={kcal} onChange={(e) => setKcal(e.target.value)} className="block w-full min-w-0 border rounded-xl p-3 text-base" /></label>
        <label className="text-sm">Protein (g)<input type="number" min="0" step="any" disabled={locked} value={protein} onChange={(e) => setProtein(e.target.value)} className="block w-full min-w-0 border rounded-xl p-3 text-base" /></label>
      </div>
      <p className="text-xs text-gray-500">Use your label or known values. Leave unknown amounts blank.</p>
      </>}
      <button disabled={!ready || locked || !description.trim() || Boolean(estimates && !reviewed)} className="min-h-[44px] rounded-full bg-[#111827] text-white disabled:opacity-40">{busy ? 'Saving meal…' : 'Save meal'}</button>
    </form>}
    {!ready && !error && <p role="status" className="text-sm text-gray-500">Loading diary…</p>}
    {ready && entries.length === 0 && <p className="text-sm text-gray-500 mt-3">No meals recorded yet.</p>}
    <ul className="divide-y mt-3">{entries.map((entry) => <li key={entry.id} className="py-3 text-sm break-words">
      <p className="font-semibold">{entry.date} · {entry.description}</p>
      {items.filter((item) => item.entry_id === entry.id).map((item, i) => <p key={i} className="text-gray-600">{item.name} · {item.kcal ?? 'Unknown'} kcal · {item.protein ?? 'Unknown'} g protein</p>)}
    </li>)}</ul>
  </section>;
}
