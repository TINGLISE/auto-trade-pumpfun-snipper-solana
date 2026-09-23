const cost = 0.0216;
const sl = 5;
const tp = 30;
const cases = [
  [0.03528, 'TP', true],
  [0.02808, 'TP', true],
  [0.02700, 'TP', false],
  [0.02052, 'SL', true],
  [0.02000, 'SL', true],
  [0.02100, 'SL', false],
];
let ok = true;
for (const [quote, side, expected] of cases) {
  const pnl = (quote / cost - 1) * 100;
  const got = side === 'TP' ? pnl >= tp : pnl <= -sl;
  if (got !== expected) { ok = false; console.error('FAIL', {quote, side, pnl, got, expected}); }
}
if (!ok) process.exit(1);
console.log('PASS executable exit threshold logic');
