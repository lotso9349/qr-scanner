// OTP QR 解析：支援 otpauth://（單一帳號）與 otpauth-migration://（Google Authenticator 匯出）
(function (root) {
  'use strict';

  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function toBase32(bytes) {
    let bits = 0;
    let val = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += B32[(val >>> (bits - 5)) & 31];
        bits -= 5;
      }
      val &= (1 << bits) - 1;
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }

  function utf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ---------- 極簡 protobuf 讀取 ----------
  function readVarint(buf, pos) {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error('eof');
      const b = buf[pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return [result, pos];
    }
    throw new Error('varint');
  }

  function parseMessage(buf, onField) {
    let pos = 0;
    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (wire === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        onField(field, v);
      } else if (wire === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        if (pos + len > buf.length) throw new Error('length');
        onField(field, buf.subarray(pos, pos + len));
        pos += len;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new Error('wire');
      }
    }
  }

  // ---------- 共用 ----------
  const ALGO = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };

  function splitLabel(label, issuerParam) {
    let issuer = issuerParam || '';
    let account = label;
    const i = label.indexOf(':');
    if (i >= 0) {
      const pre = label.slice(0, i).trim();
      const rest = label.slice(i + 1).trim();
      if (!issuer) issuer = pre;
      if (!issuerParam || pre === issuerParam) account = rest;
    }
    return { issuer: issuer, account: account };
  }

  function buildUri(a) {
    const label = (a.issuer ? encodeURIComponent(a.issuer) + ':' : '') + encodeURIComponent(a.account);
    let q = 'secret=' + a.secret;
    if (a.issuer) q += '&issuer=' + encodeURIComponent(a.issuer);
    q += '&algorithm=' + a.algorithm + '&digits=' + a.digits;
    q += a.type === 'hotp' ? '&counter=' + a.counter : '&period=' + a.period;
    return 'otpauth://' + a.type + '/' + label + '?' + q;
  }

  // ---------- otpauth://totp/Label?secret=... ----------
  function parseOtpauth(uri) {
    const m = uri.match(/^otpauth:\/\/(totp|hotp)\/([^?]*)\??(.*)$/i);
    if (!m) throw new Error('format');
    const type = m[1].toLowerCase();
    let label = m[2];
    try { label = decodeURIComponent(label); } catch (e) { /* 保持原樣 */ }
    const params = new URLSearchParams(m[3]);
    const secret = (params.get('secret') || '').replace(/\s+/g, '').toUpperCase();
    if (!secret) throw new Error('secret');
    const parts = splitLabel(label.trim(), (params.get('issuer') || '').trim());
    return {
      type: type,
      issuer: parts.issuer,
      account: parts.account,
      secret: secret,
      algorithm: (params.get('algorithm') || 'SHA1').toUpperCase(),
      digits: parseInt(params.get('digits') || '6', 10) || 6,
      period: parseInt(params.get('period') || '30', 10) || 30,
      counter: parseInt(params.get('counter') || '0', 10) || 0,
      uri: uri,
    };
  }

  // ---------- otpauth-migration://offline?data=... ----------
  function parseOtpParameters(buf) {
    const o = { secretBytes: null, name: '', issuer: '', algo: 1, digits: 1, type: 2, counter: 0 };
    parseMessage(buf, function (f, v) {
      if (f === 1) o.secretBytes = v;
      else if (f === 2) o.name = utf8(v);
      else if (f === 3) o.issuer = utf8(v);
      else if (f === 4) o.algo = v;
      else if (f === 5) o.digits = v;
      else if (f === 6) o.type = v;
      else if (f === 7) o.counter = v;
    });
    if (!o.secretBytes || !o.secretBytes.length) throw new Error('secret');
    const parts = splitLabel(o.name.trim(), o.issuer.trim());
    const a = {
      type: o.type === 1 ? 'hotp' : 'totp',
      issuer: parts.issuer,
      account: parts.account,
      secret: toBase32(o.secretBytes),
      algorithm: ALGO[o.algo] || 'SHA1',
      digits: o.digits === 2 ? 8 : 6,
      period: 30,
      counter: o.counter || 0,
    };
    a.uri = buildUri(a);
    return a;
  }

  function parseMigration(uri) {
    const m = uri.match(/[?&]data=([^&\s]+)/);
    if (!m) throw new Error('data');
    let b64 = m[1];
    try { b64 = decodeURIComponent(b64); } catch (e) { /* 保持原樣 */ }
    b64 = b64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const accounts = [];
    const meta = { batchSize: 1, batchIndex: 0, batchId: 0 };
    parseMessage(bytes, function (f, v) {
      if (f === 1) accounts.push(parseOtpParameters(v));
      else if (f === 3) meta.batchSize = v || 1;
      else if (f === 4) meta.batchIndex = v;
      else if (f === 5) meta.batchId = v;
    });
    return { accounts: accounts, batchSize: meta.batchSize, batchIndex: meta.batchIndex, batchId: meta.batchId };
  }

  function isOtpText(text) {
    return /^otpauth(-migration)?:\/\//i.test((text || '').trim());
  }

  // 回傳 { accounts, batchSize, batchIndex, batchId }；不是 OTP 則回傳 null；格式錯誤會丟出例外
  function parseOtp(text) {
    const t = (text || '').trim();
    if (/^otpauth-migration:\/\//i.test(t)) return parseMigration(t);
    if (/^otpauth:\/\//i.test(t)) {
      return { accounts: [parseOtpauth(t)], batchSize: 1, batchIndex: 0, batchId: 0 };
    }
    return null;
  }

  function formatBackup(accounts, when) {
    const lines = ['# OTP 備份（請妥善保管，金鑰等同密碼）', '# 產生時間：' + when, ''];
    accounts.forEach(function (a, i) {
      const name = a.issuer ? a.issuer + '（' + a.account + '）' : a.account;
      lines.push((i + 1) + '. 名稱：' + name);
      lines.push('   金鑰：' + a.secret);
      lines.push('   規格：' + a.type.toUpperCase() + ' / ' + a.algorithm + ' / ' + a.digits + ' 位' +
        (a.type === 'totp' ? ' / ' + a.period + ' 秒' : ' / 計數 ' + a.counter));
      lines.push('   URI：' + a.uri);
      lines.push('');
    });
    return lines.join('\n');
  }

  const api = { parseOtp: parseOtp, isOtpText: isOtpText, toBase32: toBase32, formatBackup: formatBackup };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OtpParse = api;
})(typeof self !== 'undefined' ? self : this);
