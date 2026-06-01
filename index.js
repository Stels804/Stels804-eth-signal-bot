// ============================================================
//  index.js — Crypto Signal Bot для Railway
//  Сканирует 7 монет на 15M + 1H, шлёт сигналы в Telegram
// ============================================================

import fetch from 'node-fetch';
import {
  calcRSI, calcEMA, calcMACD, calcATR, calcADX,
  detectRSIDivergence, detectCandlePattern,
  detectLiquidityZones, detectFakeout,
  calcSupport, calcResist, calcVolRatio, getTrend
} from './indicators.js';

// ============================================================
//  КОНФИГ — задаётся через переменные окружения Railway
// ============================================================
const TG_TOKEN  = process.env.TG_TOKEN;   // токен бота из BotFather
const TG_CHAT   = process.env.TG_CHAT;    // ваш chat_id
const SCAN_15M  = parseInt(process.env.SCAN_15M  || '180');  // секунды
const SCAN_1H   = parseInt(process.env.SCAN_1H   || '3600'); // секунды
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '5');    // минимальный скор сигнала
const ADX_MIN   = parseFloat(process.env.ADX_MIN || '20');   // минимальный ADX

const ASSETS = [
  { key: 'ETH',  symbol: 'ETHUSDT',  decimals: 2 },
  { key: 'BTC',  symbol: 'BTCUSDT',  decimals: 0 },
  { key: 'SOL',  symbol: 'SOLUSDT',  decimals: 2 },
  { key: 'XRP',  symbol: 'XRPUSDT',  decimals: 4 },
  { key: 'DOGE', symbol: 'DOGEUSDT', decimals: 5 },
  { key: 'ADA',  symbol: 'ADAUSDT',  decimals: 4 },
  { key: 'BNB',  symbol: 'BNBUSDT',  decimals: 2 },
];

// Cooldown: не слать повторный сигнал по тому же активу+направлению
// пока предыдущий не закрылся (WIN/LOSS) или не истёк
const openSignals = {}; // { 'ETH_15': { dir, entry, sl, tp1, tp2, candles, tf } }
let btcTrend4h = 'neut';

// ============================================================
//  BYBIT API
// ============================================================
async function fetchKlines(symbol, interval, limit = 150) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result.list.reverse(); // oldest first
}

async function fetchTicker(symbol) {
  const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result.list[0];
}

async function fetchOI(symbol) {
  try {
    const url = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=2`;
    const res = await fetch(url);
    const data = await res.json();
    const list = data.result.list;
    if (!list || list.length < 2) return { current: 0, change: 0 };
    const current = parseFloat(list[0].openInterest);
    const prev    = parseFloat(list[1].openInterest);
    return { current, change: (current - prev) / prev * 100 };
  } catch { return { current: 0, change: 0 }; }
}

async function fetchFunding(symbol) {
  try {
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`;
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.result.list[0]?.fundingRate || 0);
  } catch { return 0; }
}

// ============================================================
//  TELEGRAM
// ============================================================
async function sendTG(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('[TG MOCK]', text.slice(0, 80));
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[TG ERROR]', e.message);
  }
}

// ============================================================
//  АНАЛИЗ ОДНОГО АКТИВА НА ОДНОМ ТФ
// ============================================================
async function analyzeAsset(asset, tf) {
  const { key, symbol, decimals } = asset;
  const tfLabel = tf === '15' ? '15M' : '1H';
  const sigKey  = `${key}_${tf}`;

  try {
    // Данные
    const klines  = await fetchKlines(symbol, tf);
    const closes  = klines.map(k => parseFloat(k[4]));
    const highs   = klines.map(k => parseFloat(k[2]));
    const lows    = klines.map(k => parseFloat(k[3]));
    const opens   = klines.map(k => parseFloat(k[1]));
    const volumes = klines.map(k => parseFloat(k[5]));

    const price = closes[closes.length - 1];

    // Индикаторы
    const rsi      = calcRSI(closes, 14);
    const ema20    = calcEMA(closes, 20);
    const ema50    = calcEMA(closes, 50);
    const macd     = calcMACD(closes);
    const atr      = calcATR(highs, lows, closes, 14);
    const adxData  = calcADX(highs, lows, closes, 14);
    const adx      = adxData.adx;
    const volRatio = calcVolRatio(volumes);
    const support  = calcSupport(lows);
    const resist   = calcResist(highs);
    const div      = detectRSIDivergence(closes, rsi, 14);
    const pattern  = detectCandlePattern(opens, highs, lows, closes);

    // Ликвидность
    const liqData  = detectLiquidityZones(highs, lows, closes, atr);
    const fakeout  = detectFakeout(opens, highs, lows, closes, liqData.zones, atr);

    // OI + Funding (только для 1H чтобы не спамить API)
    let oi = { change: 0 }, funding = 0;
    if (tf === '60') {
      [oi, funding] = await Promise.all([fetchOI(symbol), fetchFunding(symbol)]);
    }

    // 4H тренд для фильтра
    let trend4h = 'neut';
    if (tf === '15') {
      // Используем кэшированный BTC тренд
      trend4h = btcTrend4h;
    } else {
      const k4h   = await fetchKlines(symbol, '240', 60);
      const c4h   = k4h.map(k => parseFloat(k[4]));
      const h4h   = k4h.map(k => parseFloat(k[2]));
      const l4h   = k4h.map(k => parseFloat(k[3]));
      const e20_4h = calcEMA(c4h, 20);
      const e50_4h = calcEMA(c4h, 50);
      const rsi4h  = calcRSI(c4h, 14);
      const macd4h = calcMACD(c4h);
      trend4h = getTrend(c4h[c4h.length - 1], e20_4h, e50_4h, rsi4h, macd4h);
      if (key === 'BTC') btcTrend4h = trend4h; // кэшируем BTC тренд
    }

    // Фильтр диапазона
    const high20 = Math.max(...highs.slice(-20));
    const low20  = Math.min(...lows.slice(-20));
    const rangeRatio = atr > 0 ? (high20 - low20) / (atr * 3) : 1;
    const isSideways = adx < ADX_MIN || rangeRatio < 1;

    // Текущий тренд
    const currentTrend = getTrend(price, ema20, ema50, rsi, macd);

    // ── Проверка открытых сигналов ──────────────────────────
    if (openSignals[sigKey]) {
      const sig = openSignals[sigKey];
      sig.candles++;

      // Истечение: 1H → 8 свечей, 15M → 16 свечей
      const maxCandles = tf === '60' ? 8 : 16;
      if (sig.candles > maxCandles) {
        await sendTG(
          `⏰ <b>Сигнал устарел</b>\n` +
          `${sig.dir === 'LONG' ? '🟢' : '🔴'} ${sig.dir} ${key} ${tfLabel}\n` +
          `Вход: $${sig.entry} | Прошло ${sig.candles} свечей\n` +
          `Текущая цена: $${price.toFixed(decimals)}`
        );
        delete openSignals[sigKey];
        return;
      }

      // WIN: цена достигла TP1
      if (sig.dir === 'LONG'  && price >= sig.tp1) {
        const pnl = ((sig.tp1 - sig.entry) / sig.entry * 100).toFixed(2);
        await sendTG(
          `✅ <b>ТП1 достигнут! +${pnl}%</b>\n` +
          `🟢 ЛОНГ ${key} ${tfLabel}\n` +
          `Вход: $${sig.entry} → TP1: $${sig.tp1}`
        );
        delete openSignals[sigKey];
        return;
      }
      if (sig.dir === 'SHORT' && price <= sig.tp1) {
        const pnl = ((sig.entry - sig.tp1) / sig.entry * 100).toFixed(2);
        await sendTG(
          `✅ <b>ТП1 достигнут! +${pnl}%</b>\n` +
          `🔴 ШОРТ ${key} ${tfLabel}\n` +
          `Вход: $${sig.entry} → TP1: $${sig.tp1}`
        );
        delete openSignals[sigKey];
        return;
      }

      // LOSS: цена достигла SL
      if (sig.dir === 'LONG'  && price <= sig.sl) {
        const pnl = ((sig.sl - sig.entry) / sig.entry * 100).toFixed(2);
        await sendTG(
          `❌ <b>Стоп-лосс ${pnl}%</b>\n` +
          `🟢 ЛОНГ ${key} ${tfLabel}\n` +
          `Вход: $${sig.entry} → SL: $${sig.sl}`
        );
        delete openSignals[sigKey];
        return;
      }
      if (sig.dir === 'SHORT' && price >= sig.sl) {
        const pnl = ((sig.entry - sig.sl) / sig.entry * 100).toFixed(2);
        await sendTG(
          `❌ <b>Стоп-лосс ${pnl}%</b>\n` +
          `🔴 ШОРТ ${key} ${tfLabel}\n` +
          `Вход: $${sig.entry} → SL: $${sig.sl}`
        );
        delete openSignals[sigKey];
        return;
      }

      // Сигнал ещё открыт — не генерируем новый
      return;
    }

    // ── Фильтры ─────────────────────────────────────────────
    if (isSideways) {
      console.log(`[${key} ${tfLabel}] БОКОВИК ADX=${adx.toFixed(1)} range=${(rangeRatio * 100).toFixed(0)}%`);
      return;
    }

    // Время суток (UTC): 00-06 — низкая активность, снижаем требования
    const utcHour = new Date().getUTCHours();
    const isLowTime = utcHour >= 0 && utcHour < 6;
    const timeMulti = isLowTime ? 0.7 : 1.0;

    // ── Скоринг ──────────────────────────────────────────────
    let longScore = 0, shortScore = 0;
    const longReasons = [], shortReasons = [];

    // RSI extreme block
    const rsiBlocksShort = rsi < 35;
    const rsiBlocksLong  = rsi > 65;

    // ЛОНГ
    if (rsi < 30) { longScore += 3; longReasons.push(`RSI перепродан (${rsi.toFixed(1)})`); }
    else if (rsi < 40) { longScore += 2; longReasons.push(`RSI ${rsi.toFixed(1)}`); }
    if (price > ema20 && ema20 > ema50) { longScore += 2; longReasons.push('Цена > EMA20 > EMA50'); }
    else if (price > ema50) { longScore += 1; longReasons.push('Цена > EMA50'); }
    if (macd.cross === 'bull') { longScore += 2; longReasons.push('MACD пересечение ▲'); }
    else if (macd.hist > 0)   { longScore += 1; longReasons.push('MACD гист +'); }
    if (div === 'bull')       { longScore += 2; longReasons.push('Бычья дивергенция RSI'); }
    if (price < support * 1.012) { longScore += 1; longReasons.push('Цена у поддержки'); }
    if (currentTrend === 'bull') { longScore += 1; longReasons.push('Текущий тренд бычий'); }
    if (trend4h === 'bull')      { longScore += 1; longReasons.push('4H тренд бычий'); }
    if (pattern.dir === 'bull')  { longScore += 2; longReasons.push(`Паттерн: ${pattern.name}`); }
    if (oi.change > 1)           { longScore += 1; longReasons.push(`OI +${oi.change.toFixed(1)}%`); }
    if (funding < -0.0005)       { longScore += 1; longReasons.push('Funding отриц.'); }
    // Зона ликвидности снизу + ложный пробой
    if (liqData.nearestBull && Math.abs(price - liqData.nearestBull.level) < atr * 2) {
      longScore += 1;
      longReasons.push(`Зона ликвидности $${liqData.nearestBull.level.toFixed(decimals)} (${liqData.nearestBull.touches} касаний)`);
    }
    if (fakeout.detected && fakeout.dir === 'bull') {
      longScore += 3; // сильный сигнал
      longReasons.push(fakeout.msg);
    }

    // ШОРТ
    if (rsi > 70) { shortScore += 3; shortReasons.push(`RSI перекуплен (${rsi.toFixed(1)})`); }
    else if (rsi > 60) { shortScore += 2; shortReasons.push(`RSI ${rsi.toFixed(1)}`); }
    if (price < ema20 && ema20 < ema50) { shortScore += 2; shortReasons.push('Цена < EMA20 < EMA50'); }
    else if (price < ema50) { shortScore += 1; shortReasons.push('Цена < EMA50'); }
    if (macd.cross === 'bear') { shortScore += 2; shortReasons.push('MACD пересечение ▼'); }
    else if (macd.hist < 0)   { shortScore += 1; shortReasons.push('MACD гист −'); }
    if (div === 'bear')       { shortScore += 2; shortReasons.push('Медвежья дивергенция RSI'); }
    if (price > resist * 0.988) { shortScore += 1; shortReasons.push('Цена у сопротивления'); }
    if (currentTrend === 'bear') { shortScore += 1; shortReasons.push('Текущий тренд медвежий'); }
    if (trend4h === 'bear')      { shortScore += 1; shortReasons.push('4H тренд медвежий'); }
    if (pattern.dir === 'bear')  { shortScore += 2; shortReasons.push(`Паттерн: ${pattern.name}`); }
    if (oi.change < -1)          { shortScore += 1; shortReasons.push(`OI ${oi.change.toFixed(1)}%`); }
    if (funding > 0.001)         { shortScore += 1; shortReasons.push('Funding высокий'); }
    if (liqData.nearestBear && Math.abs(price - liqData.nearestBear.level) < atr * 2) {
      shortScore += 1;
      shortReasons.push(`Зона ликвидности $${liqData.nearestBear.level.toFixed(decimals)} (${liqData.nearestBear.touches} касаний)`);
    }
    if (fakeout.detected && fakeout.dir === 'bear') {
      shortScore += 3;
      shortReasons.push(fakeout.msg);
    }

    // Применяем множители
    const volOk = volRatio >= 0.8;
    const effLong  = Math.floor(longScore  * (volOk ? 1 : 0.7) * timeMulti);
    const effShort = Math.floor(shortScore * (volOk ? 1 : 0.7) * timeMulti);

    // Тренд-фильтр: BTC для альтов
    if (key !== 'BTC' && btcTrend4h !== 'neut') {
      if (btcTrend4h === 'bear' && effLong > effShort) {
        console.log(`[${key} ${tfLabel}] BTC медвежий — лонг заблокирован`);
        return;
      }
    }

    // RSI блоки
    if (rsiBlocksShort && effShort >= MIN_SCORE && effShort > effLong) {
      console.log(`[${key} ${tfLabel}] RSI ${rsi.toFixed(1)} < 35 — шорт заблокирован`);
      return;
    }
    if (rsiBlocksLong && effLong >= MIN_SCORE && effLong > effShort) {
      console.log(`[${key} ${tfLabel}] RSI ${rsi.toFixed(1)} > 65 — лонг заблокирован`);
      return;
    }

    const atrPct = (atr / price * 100).toFixed(2);

    // ── ЛОНГ СИГНАЛ ──────────────────────────────────────────
    if (effLong >= MIN_SCORE && effLong > effShort && trend4h !== 'bear') {
      const entry = price;
      const sl    = Math.max(entry - atr * 1.5, entry * 0.98);
      const risk  = entry - sl;
      const tp1   = entry + risk * 1.5;
      const tp2   = entry + risk * 2.5;
      const rr    = risk > 0 ? (tp1 - entry) / risk : 0;

      // Добавляем зону ликвидности в уведомление
      const liqNote = fakeout.detected && fakeout.dir === 'bull'
        ? `\n🎯 ${fakeout.msg}` : liqData.nearestBull
        ? `\n💧 Зона ликв. снизу: $${liqData.nearestBull.level.toFixed(decimals)}` : '';

      const msg =
        `🟢 <b>СИГНАЛ ЛОНГ ${key} ${tfLabel}</b>\n\n` +
        `💰 Вход: $${entry.toFixed(decimals)}\n` +
        `🛑 Стоп (ATR ${atrPct}%): $${sl.toFixed(decimals)}\n` +
        `🎯 ТП1: $${tp1.toFixed(decimals)}\n` +
        `🎯 ТП2: $${tp2.toFixed(decimals)}\n` +
        `⚖️ R:R 1:${rr.toFixed(1)}\n` +
        `\n📊 RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)} | EMA20/50: ${ema20.toFixed(decimals)}/${ema50.toFixed(decimals)}\n` +
        `📈 Тренд 4H: ${trend4h} | Объём: ${(volRatio * 100).toFixed(0)}%\n` +
        (oi.current > 0 ? `📉 OI: ${oi.change > 0 ? '+' : ''}${oi.change.toFixed(1)}% | ` : '') +
        `Funding: ${(funding * 100).toFixed(4)}%` +
        liqNote +
        `\n\n⚡ ${longReasons.join('\n• ')}\n` +
        `\n🔢 Сила сигнала: ${longScore}/14` +
        (isLowTime ? '\n⚠️ Ночное время UTC — осторожно' : '');

      await sendTG(msg);
      openSignals[sigKey] = { dir: 'LONG', entry, sl, tp1, tp2, candles: 0, tf };
      console.log(`[${key} ${tfLabel}] ✅ ЛОНГ $${entry.toFixed(decimals)} скор:${longScore}`);
    }

    // ── ШОРТ СИГНАЛ ──────────────────────────────────────────
    else if (effShort >= MIN_SCORE && effShort > effLong && trend4h !== 'bull') {
      const entry = price;
      const sl    = Math.min(entry + atr * 1.5, entry * 1.02);
      const risk  = sl - entry;
      const tp1   = entry - risk * 1.5;
      const tp2   = entry - risk * 2.5;
      const rr    = risk > 0 ? (entry - tp1) / risk : 0;

      const liqNote = fakeout.detected && fakeout.dir === 'bear'
        ? `\n🎯 ${fakeout.msg}` : liqData.nearestBear
        ? `\n💧 Зона ликв. сверху: $${liqData.nearestBear.level.toFixed(decimals)}` : '';

      const msg =
        `🔴 <b>СИГНАЛ ШОРТ ${key} ${tfLabel}</b>\n\n` +
        `💰 Вход: $${entry.toFixed(decimals)}\n` +
        `🛑 Стоп (ATR ${atrPct}%): $${sl.toFixed(decimals)}\n` +
        `🎯 ТП1: $${tp1.toFixed(decimals)}\n` +
        `🎯 ТП2: $${tp2.toFixed(decimals)}\n` +
        `⚖️ R:R 1:${rr.toFixed(1)}\n` +
        `\n📊 RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)} | EMA20/50: ${ema20.toFixed(decimals)}/${ema50.toFixed(decimals)}\n` +
        `📉 Тренд 4H: ${trend4h} | Объём: ${(volRatio * 100).toFixed(0)}%\n` +
        (oi.current > 0 ? `📈 OI: ${oi.change > 0 ? '+' : ''}${oi.change.toFixed(1)}% | ` : '') +
        `Funding: ${(funding * 100).toFixed(4)}%` +
        liqNote +
        `\n\n⚡ ${shortReasons.join('\n• ')}\n` +
        `\n🔢 Сила сигнала: ${shortScore}/14` +
        (isLowTime ? '\n⚠️ Ночное время UTC — осторожно' : '');

      await sendTG(msg);
      openSignals[sigKey] = { dir: 'SHORT', entry, sl, tp1, tp2, candles: 0, tf };
      console.log(`[${key} ${tfLabel}] ✅ ШОРТ $${entry.toFixed(decimals)} скор:${shortScore}`);
    } else {
      console.log(`[${key} ${tfLabel}] ожидание L:${effLong} S:${effShort} ADX:${adx.toFixed(1)}`);
    }

  } catch (e) {
    console.error(`[${key} ${tfLabel}] ошибка:`, e.message);
  }
}

// ============================================================
//  ГЛАВНЫЙ ЦИКЛ
// ============================================================
async function scan15M() {
  console.log(`\n[СКАН 15M] ${new Date().toISOString()}`);
  // Обновляем BTC 4H тренд
  try {
    const k4h = await fetchKlines('BTCUSDT', '240', 60);
    const c4h = k4h.map(k => parseFloat(k[4]));
    btcTrend4h = getTrend(
      c4h[c4h.length-1],
      calcEMA(c4h, 20),
      calcEMA(c4h, 50),
      calcRSI(c4h, 14),
      calcMACD(c4h)
    );
    console.log(`[BTC 4H] тренд: ${btcTrend4h}`);
  } catch(e) { console.error('BTC 4H err:', e.message); }

  for (const asset of ASSETS) {
    await analyzeAsset(asset, '15');
    await sleep(400);
  }
}

  for (const asset of ASSETS) {
    await analyzeAsset(asset, '15');
    await sleep(400); // не спамить API
  }
}

async function scan1H() {
  console.log(`\n[СКАН 1H] ${new Date().toISOString()}`);
  for (const asset of ASSETS) {
    await analyzeAsset(asset, '60');
    await sleep(600);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  ЗАПУСК
// ============================================================
async function main() {
  console.log('🚀 Crypto Signal Bot v4.3 запущен');
  console.log(`📋 Активы: ${ASSETS.map(a => a.key).join(', ')}`);
  console.log(`⏱  15M каждые ${SCAN_15M}с | 1H каждые ${SCAN_1H}с`);
  console.log(`🔑 TG Token: ${TG_TOKEN ? '✅ установлен' : '❌ не задан'}`);
  console.log(`💬 TG Chat:  ${TG_CHAT  ? '✅ установлен' : '❌ не задан'}`);

  if (!TG_TOKEN || !TG_CHAT) {
    await sendTG('🚀 Бот запущен (тестовый режим без TG)');
  } else {
    await sendTG(
      `🚀 <b>Crypto Signal Bot запущен</b>\n` +
      `📋 ${ASSETS.map(a => a.key).join(' ')} — 7 монет\n` +
      `⏱ 15M + 1H сканирование\n` +
      `🔍 ADX фильтр: >${ADX_MIN} | Мин.скор: ${MIN_SCORE}\n` +
      `💧 Зоны ликвидности: ВКЛ\n` +
      `🎯 Ложные пробои: ВКЛ`
    );
  }

  // Первый скан сразу
  await scan15M();
  await scan1H();

  // Запускаем таймеры
  setInterval(scan15M, SCAN_15M * 1000);
  setInterval(scan1H,  SCAN_1H  * 1000);

  // Keepalive лог каждые 6 часов
  setInterval(() => {
    const open = Object.keys(openSignals).length;
    console.log(`[HEARTBEAT] ${new Date().toISOString()} | Открытых сигналов: ${open}`);
  }, 6 * 60 * 60 * 1000);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
