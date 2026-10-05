/**
 * 基数変換＆早見表ツール (Base Converter & Lookup)
 * Vanilla JavaScript (ES2020+) — 外部ライブラリ非依存
 * 任意桁の値を正確に扱うため BigInt を使用
 */
'use strict';

/* =========================================================
   定数
   ========================================================= */
const LIMITS = Object.freeze({
  MAX_ROWS: 1000,                                  // 早見表の安全上限
  HEX_DIGITS: { min: 1, max: 64, def: 2 },
  BIN_DIGITS: { min: 1, max: 256, def: 8 },
  POW_EXACT_MAX: 1024,                             // 2^n を厳密値で表示する上限
  POW_EXACT_MIN: -64,                              // 2^-n を厳密な小数で表示する下限
  POW_APPROX_ABS_MAX: 1e9,                         // 近似表示の上限（超えたら省略）
});

const STORAGE_KEY = 'base-converter-theme';

const RADIX = Object.freeze({
  hex: { radix: 16, bitsPerDigit: 4, prefix: '0x' },
  bin: { radix: 2, bitsPerDigit: 1, prefix: '0b' },
});

const PATTERNS = Object.freeze({
  dec: { valid: /^-?\d+$/,        allowed: /[0-9-]/, help: '半角数字（0〜9）と先頭の「-」のみ入力できます。' },
  hex: { valid: /^-?[0-9A-F]+$/,  allowed: /[0-9A-F-]/, help: '0〜9・A〜F と先頭の「-」のみ入力できます。' },
  bin: { valid: /^[01]+$/,        allowed: /[01]/,   help: '0 と 1 のみ入力できます。' },
});

/* =========================================================
   変換コア（DOM 非依存）
   settings = { hexDigits, binDigits, signed: boolean, bitWidth: number|null }
   ========================================================= */

/** 整数に変換し範囲内へ丸める（不正値は既定値） */
function clampInt(raw, { min, max, def }) {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** BigInt(>=0) のビット長 */
function bitLength(n) {
  return n === 0n ? 0 : n.toString(2).length;
}

const padUpper = (s, digits) => s.toUpperCase().padStart(digits, '0');

/** 固定ビット幅で表現可能な範囲（負数=符号付き下限、正数=符号なし上限） */
function widthRange(bitWidth) {
  const w = BigInt(bitWidth);
  return { min: -(1n << (w - 1n)), max: (1n << w) - 1n };
}

/** 値が固定ビット幅の範囲内かを検査。範囲外ならエラーメッセージを返す */
function checkRange(value, settings) {
  if (!settings.bitWidth) return null;
  const { min, max } = widthRange(settings.bitWidth);
  if (value < min || value > max) {
    return `${settings.bitWidth}bit で表現できる範囲（${min} 〜 ${max}）を超えています。`;
  }
  return null;
}

/**
 * 値を HEX/BIN 文字列に整形する。
 * - 正数: 有効桁数でゼロ埋め
 * - 負数: 2の補数表現（固定幅=そのビット幅、自動=有効桁数以上で表現可能な最小幅）
 * @returns {{text:string}|{error:string}}
 */
function formatRadix(value, kind, settings) {
  const { radix, bitsPerDigit } = RADIX[kind];
  const minDigits = kind === 'hex' ? settings.hexDigits : settings.binDigits;

  if (settings.bitWidth) {
    const err = checkRange(value, settings);
    if (err) return { error: err };
    if (value >= 0n) return { text: padUpper(value.toString(radix), minDigits) };
    const w = BigInt(settings.bitWidth);
    const digits = Math.max(minDigits, Math.ceil(settings.bitWidth / bitsPerDigit));
    return { text: padUpper(((1n << w) + value).toString(radix), digits) };
  }

  if (value >= 0n) return { text: padUpper(value.toString(radix), minDigits) };

  // 自動: 符号ビットを含めて表現できる最小ビット数を、桁単位に切り上げ
  const needed = Math.max(minDigits * bitsPerDigit, bitLength(-value - 1n) + 1);
  const digits = Math.ceil(needed / bitsPerDigit);
  const bits = BigInt(digits * bitsPerDigit);
  return { text: padUpper(((1n << bits) + value).toString(radix), digits) };
}

/** 種別ごとの整形 */
function formatValue(kind, value, settings) {
  if (kind === 'dec') return { text: value.toString() };
  return formatRadix(value, kind, settings);
}

/** 表示用：不正文字の見せ方 */
function describeChar(c) {
  if (c === ' ') return '半角スペース';
  if (c === '\u3000') return '全角スペース';
  if (c === '\t') return 'タブ';
  return c;
}

/**
 * 入力文字列を検証・解析して BigInt を返す。
 * @returns {{value:bigint}|{error:string}|{empty:true}}
 */
function parseInput(kind, raw, settings) {
  let text = String(raw).trim();
  if (kind === 'hex') text = text.toUpperCase();
  if (text === '') return { empty: true };

  const p = PATTERNS[kind];
  const bad = [...new Set([...text].filter((c) => !p.allowed.test(c)))];
  if (bad.length) {
    return { error: `使用できない文字「${bad.map(describeChar).join(' ')}」が含まれています。${p.help}` };
  }
  if (kind !== 'bin' && text.indexOf('-', 1) !== -1) {
    return { error: '「-」は先頭にのみ入力できます。' };
  }
  if (text === '-') return { empty: true }; // 入力途中
  if (!p.valid.test(text)) return { error: p.help };

  let value;
  if (kind === 'dec') {
    value = BigInt(text);
  } else {
    const { bitsPerDigit, prefix } = RADIX[kind];
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    let u = BigInt(prefix + body);

    if (negative) {
      value = -u;
    } else if (settings.bitWidth) {
      const w = BigInt(settings.bitWidth);
      if (u >= (1n << w)) {
        return { error: `${settings.bitWidth}bit を超える値です。` };
      }
      if (settings.signed && u >= (1n << (w - 1n))) u -= (1n << w);
      value = u;
    } else {
      if (settings.signed) {
        const minDigits = kind === 'hex' ? settings.hexDigits : settings.binDigits;
        const bits = BigInt(Math.max(minDigits, body.length) * bitsPerDigit);
        if (u >= (1n << (bits - 1n))) u -= (1n << bits);
      }
      value = u;
    }
  }

  const rangeErr = checkRange(value, settings);
  if (rangeErr) return { error: rangeErr };
  return { value };
}

/** 2^n の表示文字列（大きすぎる値は近似・省略） */
function pow2(n) {
  if (n >= 0 && n <= LIMITS.POW_EXACT_MAX) return (1n << BigInt(n)).toString();
  if (n < 0 && n >= LIMITS.POW_EXACT_MIN) {
    const k = -n;
    return '0.' + (5n ** BigInt(k)).toString().padStart(k, '0'); // 2^-k = 5^k / 10^k
  }
  if (Math.abs(n) > LIMITS.POW_APPROX_ABS_MAX) return '（桁数過大のため省略）';
  const l = n * Math.log10(2);
  let e = Math.floor(l);
  let m = (10 ** (l - e)).toFixed(4);
  if (m.startsWith('10')) { m = '1.0000'; e += 1; }
  return `≈ ${m}e${e >= 0 ? '+' : ''}${e}`;
}

/** 早見表の行データ生成 */
function buildRows(start, end, settings) {
  const rows = [];
  for (let i = start; i <= end; i++) {
    const v = BigInt(i);
    const hex = formatRadix(v, 'hex', settings);
    const bin = formatRadix(v, 'bin', settings);
    rows.push({
      dec: String(i),
      hex: hex.error ? '範囲外' : hex.text,
      bin: bin.error ? '範囲外' : bin.text,
      pow: pow2(i),
      hexOut: Boolean(hex.error),
      binOut: Boolean(bin.error),
    });
  }
  return rows;
}

/** 早見表の入力値検証 */
function validateRange(startRaw, endRaw) {
  const s = String(startRaw).trim();
  const e = String(endRaw).trim();
  if (!/^-?\d+$/.test(s) || !/^-?\d+$/.test(e)) {
    return { error: '開始値と終了値には整数を入力してください。', field: !/^-?\d+$/.test(s) ? 'start' : 'end' };
  }
  const start = Number(s);
  const end = Number(e);
  if (!Number.isSafeInteger(start)) return { error: '開始値が扱える範囲を超えています。', field: 'start' };
  if (!Number.isSafeInteger(end)) return { error: '終了値が扱える範囲を超えています。', field: 'end' };
  if (start > end) return { error: '開始値は終了値以下にしてください。', field: 'start' };
  const count = end - start + 1;
  if (count > LIMITS.MAX_ROWS) {
    return {
      error: `一度に生成できるのは最大 ${LIMITS.MAX_ROWS.toLocaleString()} 行です（指定: ${count.toLocaleString()} 行）。`,
      field: 'end',
    };
  }
  return { start, end };
}

/* ---------- エクスポート ---------- */
const TABLE_HEADERS = ['# (Dec)', 'Dec2Hex', 'Dec2Bin', '2^n'];

function csvEscape(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV 文字列（Excel で文字化けしないよう UTF-8 BOM 付き） */
function toCsv(rows) {
  const lines = [TABLE_HEADERS, ...rows.map((r) => [r.dec, r.hex, r.bin, r.pow])]
    .map((cols) => cols.map(csvEscape).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function mdEscape(v) {
  return String(v).replace(/\|/g, '\\|');
}

/** Markdown テーブル（GitHub Flavored Markdown） */
function toMarkdown(rows) {
  const head = `| ${TABLE_HEADERS.join(' | ')} |`;
  const sep = '|' + TABLE_HEADERS.map(() => '--:').join('|') + '|';
  const body = rows.map((r) => `| ${[r.dec, r.hex, r.bin, r.pow].map(mdEscape).join(' | ')} |`);
  return [head, sep, ...body].join('\n') + '\n';
}

/* =========================================================
   UI（DOM 依存部）
   ========================================================= */
function initApp() {
  const $ = (id) => document.getElementById(id);

  const fields = {
    dec: { input: $('decInput'), error: $('decError') },
    hex: { input: $('hexInput'), error: $('hexError') },
    bin: { input: $('binInput'), error: $('binError') },
  };
  const el = {
    hexDigits: $('hexDigits'),
    binDigits: $('binDigits'),
    signMode: $('signMode'),
    bitWidth: $('bitWidth'),
    tableForm: $('tableForm'),
    startVal: $('startVal'),
    endVal: $('endVal'),
    tableError: $('tableError'),
    refBody: $('refBody'),
    rowCount: $('rowCount'),
    csvBtn: $('csvBtn'),
    mdBtn: $('mdBtn'),
    toast: $('toast'),
    themeToggle: $('themeToggle'),
    themeLabel: $('themeLabel'),
  };

  const state = {
    value: null,     // 現在の値（BigInt）
    source: null,    // 最後に入力されたフィールド
    range: null,     // 最後に生成した早見表の範囲
    rows: [],        // 現在表示中の早見表データ
  };

  /* ---------- 設定 ---------- */
  function getSettings() {
    return {
      hexDigits: clampInt(el.hexDigits.value, LIMITS.HEX_DIGITS),
      binDigits: clampInt(el.binDigits.value, LIMITS.BIN_DIGITS),
      signed: el.signMode.value === 'signed',
      bitWidth: el.bitWidth.value === 'auto' ? null : Number(el.bitWidth.value),
    };
  }

  /* ---------- エラー表示 ---------- */
  function setFieldError(kind, message) {
    const f = fields[kind];
    f.input.classList.add('is-invalid');
    f.input.setAttribute('aria-invalid', 'true');
    f.input.title = message;
    f.error.textContent = message;
  }

  function clearFieldErrors() {
    Object.values(fields).forEach((f) => {
      f.input.classList.remove('is-invalid');
      f.input.removeAttribute('aria-invalid');
      f.input.removeAttribute('title');
      f.error.textContent = '';
    });
  }

  /* ---------- 変換処理 ---------- */
  function clearOthers(except) {
    Object.keys(fields).forEach((k) => { if (k !== except) fields[k].input.value = ''; });
  }

  /** 値から指定フィールド群を再描画 */
  function renderFields(kinds, settings) {
    kinds.forEach((k) => {
      const out = formatValue(k, state.value, settings);
      if (out.error) {
        fields[k].input.value = '';
        setFieldError(k, out.error);
      } else {
        fields[k].input.value = out.text;
      }
    });
  }

  /** 最後に入力されたフィールドを起点に再変換 */
  function runConversion() {
    clearFieldErrors();
    const kind = state.source;
    if (!kind) return;
    const settings = getSettings();
    const result = parseInput(kind, fields[kind].input.value, settings);

    if (result.error) {
      state.value = null;
      setFieldError(kind, result.error);
      clearOthers(kind);
      return;
    }
    if (result.empty) {
      state.value = null;
      clearOthers(kind);
      return;
    }
    state.value = result.value;
    renderFields(Object.keys(fields).filter((k) => k !== kind), settings);
  }

  /** HEX 入力を大文字へ自動変換（カーソル位置保持） */
  function uppercaseInPlace(input) {
    const up = input.value.toUpperCase();
    if (up === input.value) return;
    const { selectionStart, selectionEnd } = input;
    input.value = up;
    try { input.setSelectionRange(selectionStart, selectionEnd); } catch (e) { /* 無視 */ }
  }

  Object.keys(fields).forEach((kind) => {
    fields[kind].input.addEventListener('input', () => {
      if (kind === 'hex') uppercaseInPlace(fields[kind].input);
      state.source = kind;
      runConversion();
    });
  });

  /** 有効桁数変更：現在値のゼロ埋めを再計算 */
  function onDigitsChange() {
    if (state.value !== null) {
      clearFieldErrors();
      renderFields(['hex', 'bin'], getSettings());
    }
    refreshTable();
  }

  [el.hexDigits, el.binDigits].forEach((input) => {
    const limits = input === el.hexDigits ? LIMITS.HEX_DIGITS : LIMITS.BIN_DIGITS;
    input.addEventListener('input', onDigitsChange);
    // 確定時に範囲外の値を補正して表示を合わせる
    input.addEventListener('change', () => {
      const n = clampInt(input.value, limits);
      if (String(n) !== input.value) {
        input.value = String(n);
        onDigitsChange();
      }
    });
  });

  /** 符号・ビット幅変更：入力元を新しい解釈で再変換 */
  [el.signMode, el.bitWidth].forEach((select) => {
    select.addEventListener('change', () => {
      runConversion();
      refreshTable();
    });
  });

  /* ---------- 早見表 ---------- */
  function renderTable() {
    const { start, end } = state.range;
    const rows = buildRows(start, end, getSettings());
    const frag = document.createDocumentFragment();

    for (const r of rows) {
      const tr = document.createElement('tr');
      const cells = [
        [r.dec, ''],
        [r.hex, r.hexOut ? 'out-of-range' : ''],
        [r.bin, r.binOut ? 'out-of-range' : ''],
        [r.pow, 'pow'],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }

    el.refBody.replaceChildren(frag);
    state.rows = rows;
    el.rowCount.textContent = `${start} 〜 ${end}（${rows.length.toLocaleString()} 行）`;
  }

  function refreshTable() {
    if (state.range) renderTable();
  }

  function generateTable() {
    el.tableError.textContent = '';
    el.startVal.classList.remove('is-invalid');
    el.endVal.classList.remove('is-invalid');
    el.startVal.removeAttribute('aria-invalid');
    el.endVal.removeAttribute('aria-invalid');

    const r = validateRange(el.startVal.value, el.endVal.value);
    if (r.error) {
      el.tableError.textContent = r.error;
      const target = r.field === 'start' ? el.startVal : el.endVal;
      target.classList.add('is-invalid');
      target.setAttribute('aria-invalid', 'true');
      return false;
    }
    state.range = { start: r.start, end: r.end };
    renderTable();
    return true;
  }

  // フォーム送信（ボタン押下・Enter キー）で生成
  el.tableForm.addEventListener('submit', (e) => {
    e.preventDefault();
    generateTable();
  });

  /* ---------- コピー・エクスポート ---------- */
  let toastTimer = null;
  function showToast(message, type = 'ok') {
    el.toast.textContent = message;
    el.toast.dataset.type = type;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* フォールバックへ */ }

    // 非セキュアコンテキスト（http の社内サーバー等）向けフォールバック
    const active = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (active && typeof active.focus === 'function') active.focus();
    return ok;
  }

  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = document.getElementById(btn.dataset.target);
      const text = input.value.trim();
      if (!text) {
        showToast(`${btn.dataset.name} が空です`, 'error');
        return;
      }
      const ok = await copyText(text);
      showToast(ok ? 'コピーしました' : 'コピーに失敗しました', ok ? 'ok' : 'error');
    });
  });

  el.csvBtn.addEventListener('click', () => {
    if (!state.rows.length) {
      showToast('先に早見表を生成してください', 'error');
      return;
    }
    const blob = new Blob([toCsv(state.rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `base_table_${state.range.start}_${state.range.end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('CSVをダウンロードしました');
  });

  el.mdBtn.addEventListener('click', async () => {
    if (!state.rows.length) {
      showToast('先に早見表を生成してください', 'error');
      return;
    }
    const ok = await copyText(toMarkdown(state.rows));
    showToast(ok ? 'Markdownをコピーしました' : 'コピーに失敗しました', ok ? 'ok' : 'error');
  });

  /* ---------- テーマ切替 ---------- */
  const mq = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function updateThemeToggle() {
    const dark = currentTheme() === 'dark';
    el.themeToggle.setAttribute('aria-checked', String(dark));
    el.themeLabel.textContent = dark ? '🌙 ダーク' : '☀️ ライト';
    el.themeToggle.title = dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
  }

  el.themeToggle.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* 保存不可でも動作継続 */ }
    updateThemeToggle();
  });

  // 保存済み設定がなければ OS 設定の変更に追従
  if (mq) {
    const onSchemeChange = () => updateThemeToggle();
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSchemeChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onSchemeChange);
  }

  /* ---------- 初期化 ---------- */
  updateThemeToggle();
  generateTable(); // 初期表示: 0 〜 16
}

/* =========================================================
   エントリーポイント
   ========================================================= */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

// テスト用（Node.js から読み込んだ場合のみ）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clampInt, formatRadix, formatValue, parseInput, checkRange,
    pow2, buildRows, validateRange, toCsv, toMarkdown, LIMITS,
  };
}
