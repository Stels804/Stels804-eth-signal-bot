// ============================================================
//  indicators.js — все технические расчёты
// ============================================================

// RSI (метод Wilder — как на TradingView)
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcEMAArr(closes, period) {
  if (closes.length < period) return [closes[closes.length - 1] || 0];
  const k = 2 / (period + 1);
  const r = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  r.push(ema);
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); r.push(ema); }
  return r;
}

function calcMACD(closes) {
  if (closes.length < 35) return { macd: 0, signal: 0, hist: 0, cross: 'none' };
  const e12 = calcEMAArr(closes, 12), e26 = calcEMAArr(closes, 26);
  const ml = Math.min(e12.length, e26.length);
  const macdLine = [];
  for (let i = 0; i < ml; i++)
    macdLine.push(e12[e12.length - ml + i] - e26[e26.length - ml + i]);
  const sa = calcEMAArr(macdLine, 9);
  const mv = macdLine[macdLine.length - 1], sv = sa[sa.length - 1];
  const hist = mv - sv;
  let cross = 'none';
  if (macdLine.length > 1 && sa.length > 1) {
    const pm = macdLine[macdLine.length - 2], ps = sa[sa.length - 2];
    if (pm < ps && mv > sv) cross = 'bull';
    if (pm > ps && mv < sv) cross = 'bear';
  }
  return { macd: mv, signal: sv, hist, cross };
}

// ATR (Wilder)
function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return closes[closes.length - 1] * 0.02;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ADX (Wilder)
function calcADX(highs, lows, closes, period = 14) {
  const n = highs.length;
  if (n < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR  / period + trs[i];
    sPDM = sPDM - sPDM / period + plusDM[i];
    sMDM = sMDM - sMDM / period + minusDM[i];
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const dx  = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dxArr.push({ dx, pdi, mdi });
  }
  if (dxArr.length < period) return { adx: 0, plusDI: 0, minusDI: 0 };
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx * (period - 1) + dxArr[i].dx) / period;
  const last = dxArr[dxArr.length - 1];
  return { adx, plusDI: last.pdi, minusDI: last.mdi };
}

// Дивергенция RSI
function detectRSIDivergence(closes, currentRSI, period = 14) {
  if (closes.length < 30) return 'none';
  const w = closes.slice(-20);
  const minP = Math.min(...w), maxP = Math.max(...w);
  const prevRSI = calcRSI(closes.slice(0, -5), period);
  if (closes[closes.length - 1] <= minP * 1.002 && currentRSI > prevRSI + 3) return 'bull';
  if (closes[closes.length - 1] >= maxP * 0.998 && currentRSI < prevRSI - 3) return 'bear';
  return 'none';
}

// Свечные паттерны
function detectCandlePattern(opens, highs, lows, closes) {
  const n = closes.length;
  if (n < 3) return { name: '—', dir: 'none' };
  const o = opens[n-1], h = highs[n-1], l = lows[n-1], c = closes[n-1];
  const body = Math.abs(c - o), range = h - l;
  const po = opens[n-2], pc = closes[n-2];
  const ppo = opens[n-3], ppc = closes[n-3];
  const lowerWick = Math.min(o, c) - l;
  const upperWick = h - Math.max(o, c);

  if (body > 0 && lowerWick > body * 2 && upperWick < body * 0.5 && c > o)
    return { name: '🔨 Молот', dir: 'bull' };
  if (body > 0 && upperWick > body * 2 && lowerWick < body * 0.5 && c < o)
    return { name: '⭐ Звезда', dir: 'bear' };
  if (c > o && pc < po && c > po && o < pc)
    return { name: '📈 Бычье поглощение', dir: 'bull' };
  if (c < o && pc > po && c < po && o > pc)
    return { name: '📉 Медвежье поглощение', dir: 'bear' };
  if (range > 0 && body / range < 0.1)
    return { name: '⚖ Доджи', dir: 'neut' };
  if (ppc < ppo && Math.abs(pc - po) / Math.max(0.0001, highs[n-2] - lows[n-2]) < 0.3 && c > o && c > (ppo + ppc) / 2)
    return { name: '🌅 Утр.звезда', dir: 'bull' };
  if (ppc > ppo && Math.abs(pc - po) / Math.max(0.0001, highs[n-2] - lows[n-2]) < 0.3 && c < o && c < (ppo + ppc) / 2)
    return { name: '🌆 Веч.звезда', dir: 'bear' };
  return { name: '—', dir: 'none' };
}

// ============================================================
//  ЗОНЫ ЛИКВИДНОСТИ
//  Ищем скопления стопов: локальные экстремумы за N свечей
//  где цена несколько раз подходила близко но не пробивала
// ============================================================
function detectLiquidityZones(highs, lows, closes, atr) {
  const n = closes.length;
  if (n < 30) return { zones: [], nearestBull: null, nearestBear: null };

  const zones = [];
  const priceNow = closes[n - 1];
  const tolerance = atr * 0.3; // зона = ±0.3 ATR

  // Ищем локальные максимумы (зоны медвежьей ликвидности — стопы лонгистов выше)
  for (let i = 5; i < n - 5; i++) {
    const isLocalHigh =
      highs[i] >= Math.max(...highs.slice(i - 5, i)) &&
      highs[i] >= Math.max(...highs.slice(i + 1, i + 6));
    if (!isLocalHigh) continue;

    // Сколько раз цена подходила к этому уровню (±tolerance)?
    let touches = 0;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(highs[j] - highs[i]) < tolerance) touches++;
    }
    if (touches >= 2) {
      zones.push({
        level: highs[i],
        type: 'bear', // ликвидность выше рынка
        touches: touches + 1,
        strength: touches >= 4 ? 'strong' : 'moderate'
      });
    }
  }

  // Ищем локальные минимумы (зоны бычьей ликвидности — стопы шортистов ниже)
  for (let i = 5; i < n - 5; i++) {
    const isLocalLow =
      lows[i] <= Math.min(...lows.slice(i - 5, i)) &&
      lows[i] <= Math.min(...lows.slice(i + 1, i + 6));
    if (!isLocalLow) continue;

    let touches = 0;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(lows[j] - lows[i]) < tolerance) touches++;
    }
    if (touches >= 2) {
      zones.push({
        level: lows[i],
        type: 'bull', // ликвидность ниже рынка
        touches: touches + 1,
        strength: touches >= 4 ? 'strong' : 'moderate'
      });
    }
  }

  // Ближайшие зоны к текущей цене
  const bullZones = zones.filter(z => z.type === 'bull' && z.level < priceNow)
    .sort((a, b) => b.level - a.level);
  const bearZones = zones.filter(z => z.type === 'bear' && z.level > priceNow)
    .sort((a, b) => a.level - b.level);

  return {
    zones,
    nearestBull: bullZones[0] || null,  // ближайшая зона ликвидности снизу
    nearestBear: bearZones[0] || null,  // ближайшая зона ликвидности сверху
  };
}

// ============================================================
//  ЛОЖНЫЙ ПРОБОЙ (Liquidity Sweep / Stop Hunt)
//  Цена пробила уровень ликвидности, но закрылась обратно —
//  это сигнал разворота
// ============================================================
function detectFakeout(opens, highs, lows, closes, zones, atr) {
  const n = closes.length;
  if (n < 3 || zones.length === 0) return { detected: false, dir: 'none', level: null, msg: '' };

  const c0 = closes[n - 1]; // текущая свеча
  const h0 = highs[n - 1];
  const l0 = lows[n - 1];
  const c1 = closes[n - 2]; // предыдущая
  const tolerance = atr * 0.15;

  for (const zone of zones) {
    const lvl = zone.level;

    // Бычий ложный пробой: свеча пробила зону снизу (sweep стопов шортов),
    // но закрылась ВЫШЕ зоны → разворот вверх
    if (zone.type === 'bull') {
      const swept = l0 < lvl - tolerance; // пробила вниз
      const closed_above = c0 > lvl;       // закрылась выше
      if (swept && closed_above) {
        return {
          detected: true,
          dir: 'bull',
          level: lvl,
          msg: `🎯 Ложный пробой вниз $${lvl.toFixed(4)} — вынос стопов, разворот вверх`
        };
      }
    }

    // Медвежий ложный пробой: свеча пробила зону сверху (sweep стопов лонгов),
    // но закрылась НИЖЕ зоны → разворот вниз
    if (zone.type === 'bear') {
      const swept = h0 > lvl + tolerance; // пробила вверх
      const closed_below = c0 < lvl;       // закрылась ниже
      if (swept && closed_below) {
        return {
          detected: true,
          dir: 'bear',
          level: lvl,
          msg: `🎯 Ложный пробой вверх $${lvl.toFixed(4)} — вынос стопов, разворот вниз`
        };
      }
    }
  }

  return { detected: false, dir: 'none', level: null, msg: '' };
}

// Поддержка/сопротивление (кластерный метод)
function calcSupport(lows) {
  const s = [...lows].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.1)];
}
function calcResist(highs) {
  const s = [...highs].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.9)];
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 1;
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? volumes[volumes.length - 1] / avg : 1;
}

function getTrend(price, ema20, ema50, rsi, macd) {
  let s = 0;
  if (price > ema20) s++;
  if (ema20 > ema50) s++;
  if (rsi > 55) s++;
  if (rsi < 45) s--;
  if (macd.hist > 0) s++;
  if (macd.hist < 0) s--;
  if (s >= 2)  return 'bull';
  if (s <= -1) return 'bear';
  return 'neut';
}

module.exports = {
  calcRSI, calcEMA, calcEMAArr, calcMACD, calcATR, calcADX,
  detectRSIDivergence, detectCandlePattern,
  detectLiquidityZones, detectFakeout,
  calcSupport, calcResist, calcVolRatio, getTrend
};
