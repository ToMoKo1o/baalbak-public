/* This separate request resource stores no phone or Auth token persistently. */
'use strict';
const copy = window.baalbakDeletionCopy;
const get = (id) => document.getElementById(id);
let language = 'en';
let phone = '';
let accessToken = '';
let verifiedActor = '';
let busy = false;
let messageKey = '';
let statusKey = '';
const receiptKey = 'baalbak-deletion-receipt-v1';
let receipt = null;

function translate() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'en' ? 'ltr' : 'rtl';
  document.title = `${copy[language].brand} — ${copy[language].title}`;
  document.querySelectorAll('[data-copy]').forEach((element) => {
    element.textContent = copy[language][element.dataset.copy];
  });
  get('message').textContent = messageKey ? copy[language][messageKey] : '';
  get('status-copy').textContent = statusKey ? copy[language][statusKey] : '';
}
function message(key) {
  messageKey = key;
  translate();
}
function screen(id) {
  ['phone-form', 'code-form', 'confirm-form', 'status-panel'].forEach(
    (name) => {
      get(name).hidden = name !== id;
    },
  );
  const target = get(id).querySelector('input, h2');
  target?.focus();
}
function clearVerificationState() {
  phone = '';
  accessToken = '';
  verifiedActor = '';
  get('phone').value = '';
  get('code').value = '';
  get('confirm').checked = false;
}
function showStatus(status) {
  statusKey = status;
  get('check-status').hidden = status === 'complete';
  screen('status-panel');
  message('');
  clearVerificationState();
  if (receipt && receipt.ownerDigest) {
    receipt = receiptBody(receipt);
    sessionStorage.setItem(receiptKey, JSON.stringify(receipt));
  }
  if (status === 'complete') {
    sessionStorage.removeItem(receiptKey);
    receipt = null;
  }
}
async function api(path, body, token = '') {
  const response = await fetch(
    `${window.baalbakDeletionApiBase ?? ''}/api/account-deletion/${path}`,
    {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('unavailable');
    error.status = response.status;
    throw error;
  }
  if (!response.headers.get('content-type')?.startsWith('application/json'))
    throw new Error('invalid');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16384) {
        await reader.cancel();
        throw new Error('invalid');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const value = JSON.parse(text);
  const key =
    path === 'verify'
      ? 'accessToken'
      : path === 'context'
        ? 'isFinalAdmin'
        : 'status';
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, key) ||
    (key === 'accessToken'
      ? typeof value.accessToken !== 'string' ||
        value.accessToken.length < 50 ||
        value.accessToken.length > 8192
      : key === 'isFinalAdmin'
        ? typeof value.isFinalAdmin !== 'boolean'
        : !(path === 'otp' ? ['sent'] : ['pending', 'complete']).includes(
            value.status,
          ))
  )
    throw new Error('invalid');
  return value;
}
async function action(operation) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  message('');
  try {
    await operation();
  } catch {
    message('unavailable');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
}
function receiptBody(value) {
  return { requestId: value.requestId, receiptSecret: value.receiptSecret };
}
async function ownerDigest(secret, actor) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${secret}:${actor}`),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
async function persistedReceipt() {
  try {
    if (!/^[0-9a-f-]{36}$/.test(verifiedActor)) return null;
    const sameOwner =
      receipt?.ownerDigest &&
      receipt.ownerDigest ===
        (await ownerDigest(receipt.receiptSecret, verifiedActor));
    const current = sameOwner
      ? receipt
      : {
          requestId: crypto.randomUUID(),
          receiptSecret: Array.from(
            crypto.getRandomValues(new Uint8Array(32)),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
        };
    current.ownerDigest = await ownerDigest(
      current.receiptSecret,
      verifiedActor,
    );
    const encoded = JSON.stringify(current);
    sessionStorage.setItem(receiptKey, encoded);
    if (sessionStorage.getItem(receiptKey) !== encoded) return null;
    receipt = current;
    return receiptBody(current);
  } catch {
    return null;
  }
}
async function checkStatus() {
  if (!receipt) return;
  try {
    const result = await api('status', receiptBody(receipt));
    if (!['pending', 'complete'].includes(result.status))
      throw new Error('invalid');
    showStatus(result.status);
  } catch (error) {
    if (error.status !== 404) throw error;
    screen(accessToken ? 'confirm-form' : 'phone-form');
    message('absent');
  }
}
get('language').addEventListener('change', (event) => {
  language = event.target.value;
  translate();
});
get('phone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    phone = get('phone').value.trim();
    await api('otp', { phone });
    screen('code-form');
  });
});
get('restart').addEventListener('click', () => {
  clearVerificationState();
  screen('phone-form');
  message('');
});
get('code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    let result;
    try {
      result = await api('verify', { phone, code: get('code').value });
    } catch {
      message('verificationFailed');
      return;
    }
    if (typeof result.accessToken !== 'string' || !result.accessToken)
      throw new Error('invalid');
    accessToken = result.accessToken;
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    if (!/^[0-9a-f-]{36}$/.test(claims.sub ?? '')) throw new Error('invalid');
    verifiedActor = claims.sub;
    get('code').value = '';
    get('phone').value = '';
    phone = '';
    // Always display this warning: another Admin may leave after verification.
    get('admin-warning').hidden = false;
    get('confirm').checked = false;
    screen('confirm-form');
  });
});
get('confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    if (!get('confirm').checked || !accessToken) return;
    const saved = await persistedReceipt();
    if (!saved) {
      message('storageFailed');
      return;
    }
    try {
      const result = await api(
        'request',
        { ...saved, confirmed: true },
        accessToken,
      );
      if (!['pending', 'complete'].includes(result.status))
        throw new Error('invalid');
      accessToken = '';
      showStatus(result.status);
    } catch {
      await checkStatus();
    }
  });
});
get('check-status').addEventListener('click', () => {
  void action(checkStatus);
});
try {
  const saved = JSON.parse(sessionStorage.getItem(receiptKey));
  if (
    saved &&
    [2, 3].includes(Object.keys(saved).length) &&
    /^[0-9a-f-]{36}$/.test(saved.requestId) &&
    /^[0-9a-f]{64}$/.test(saved.receiptSecret) &&
    (saved.ownerDigest === undefined ||
      /^[0-9a-f]{64}$/.test(saved.ownerDigest))
  )
    receipt = saved;
} catch {
  /* An invalid local receipt cannot authorize server data access. */
}
translate();
if (receipt) {
  screen('status-panel');
  void action(checkStatus);
}
