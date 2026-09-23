const GAP = 5;
const ACTIVATE = 5;

function lockForPeak(peak, current, previous = -5) {
  let lock = previous;
  if (peak >= ACTIVATE) lock = Math.max(lock, peak - GAP);
  return { peak, current, lock, shouldSell: current <= lock };
}

const a = lockForPeak(20, 15);
if (a.lock !== 15 || !a.shouldSell) throw new Error('20% -> 15% harus close di +15%');

const b = lockForPeak(20, 16);
if (b.lock !== 15 || b.shouldSell) throw new Error('20% -> 16% belum boleh close');

const c = lockForPeak(10, 5);
if (c.lock !== 5 || !c.shouldSell) throw new Error('10% -> 5% harus close di +5%');

const d = lockForPeak(4, -5);
if (d.lock !== -5 || !d.shouldSell) throw new Error('Tanpa profit harus hard SL -5%');

const e = lockForPeak(25, 20);
if (e.lock !== 20 || !e.shouldSell) throw new Error('25% -> 20% harus close di +20%');

const f = lockForPeak(5, 0);
if (f.lock !== 0 || !f.shouldSell) throw new Error('5% -> 0% harus close di 0%');

console.log('PASS dynamic profit-lock gap logic');
