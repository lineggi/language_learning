// Shared access check for every /api/* function that spends Gemini quota.
//
// Runtime AI is the only cost that scales with how many people use the app —
// the daily pack build is a fixed three calls whatever the headcount — so this
// is where an allowlist actually defends the bill. It is also the one check a
// browser cannot talk its way past: the client may hide buttons, but the key
// lives here.
//
// Every entitlement decision goes through this one file on purpose. Adding
// subscriptions later means changing requireAccess, not five endpoints.
//
// Env (Vercel):
//   SUPABASE_URL                public project URL, same as the client's
//   SUPABASE_SERVICE_ROLE_KEY   server-only; bypasses RLS to read accounts
//   ACCESS_CONTROL              "off" disables the check entirely (default
//                               while the accounts table does not exist yet)

const ON = () => (process.env.ACCESS_CONTROL || "").toLowerCase() !== "off";

function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : null;
}

// Ask Supabase who this token belongs to. Verifying through the auth endpoint
// rather than decoding the JWT here means a signed-out or revoked token is
// rejected too, and there is no JWT secret to keep in sync.
async function emailFromToken(base, anonKey, token) {
  const r = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  const email = u && u.email;
  return email ? String(email).toLowerCase() : null;
}

async function lookupAccount(base, serviceKey, email) {
  const url = `${base}/rest/v1/accounts?email=eq.${encodeURIComponent(email)}`
    + `&select=email,plan,status,valid_until`;
  const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) throw new Error(`accounts lookup failed (HTTP ${r.status})`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Decide whether this request may spend AI quota.
 * Returns { ok: true, email, account } or { ok: false, status, error }.
 *
 * Fails CLOSED on a misconfigured backend: if the check is switched on but the
 * server cannot reach Supabase, the request is refused rather than waved
 * through, since waving it through is what costs money.
 */
async function requireAccess(req) {
  if (!ON()) return { ok: true, email: null, account: null, skipped: true };

  const base = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const anonKey = (process.env.SUPABASE_ANON_KEY || "").trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!base || !serviceKey || !anonKey) {
    return { ok: false, status: 500, error: "서버 설정이 끝나지 않았어요 (SUPABASE_* 환경변수)" };
  }

  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: "로그인이 필요해요" };

  let email, account;
  try {
    email = await emailFromToken(base, anonKey, token);
    if (!email) return { ok: false, status: 401, error: "로그인이 만료됐어요 · 다시 로그인해 주세요" };
    account = await lookupAccount(base, serviceKey, email);
  } catch (e) {
    return { ok: false, status: 503, error: "권한을 확인하지 못했어요 · 잠시 뒤 다시 시도해 주세요" };
  }

  if (!account || account.status === "pending") {
    return { ok: false, status: 403, error: "승인 대기 중이에요 · 승인되면 바로 쓸 수 있어요", state: "pending" };
  }
  if (account.status !== "approved") {
    return { ok: false, status: 403, error: "이용이 제한된 계정이에요", state: account.status };
  }
  if (account.valid_until && new Date(account.valid_until) <= new Date()) {
    return { ok: false, status: 403, error: "이용 기간이 끝났어요", state: "expired" };
  }
  return { ok: true, email, account };
}

// Wrap a handler so it only runs for someone allowed to spend quota.
function guarded(handler) {
  return async function (req, res) {
    const gate = await requireAccess(req);
    if (!gate.ok) { res.status(gate.status).json({ error: gate.error, state: gate.state }); return; }
    req.account = gate.account;
    return handler(req, res);
  };
}

module.exports = { requireAccess, guarded };
