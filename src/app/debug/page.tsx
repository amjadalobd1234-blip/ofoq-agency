'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * /debug — لوحة تشخيص الشبكة والاتصال بـ Supabase.
 *
 * تشغّل تلقائيًا مجموعة اختبارات من المتصفح:
 *  1) اتصال عام (example.com / google.com) — هل المشكلة في المتصفح/الشبكة كلها؟
 *  2) اتصال Supabase (health / root / auth settings) — هل مشروع Supabase نفسه مستهدف؟
 *  3) فحص no-cors — هل المضيف يرد على مستوى الشبكة حتى لو منعه CORS؟
 *  4) فحص من خادم Netlify نفسه (/api/debug/remote) — لفصل مشكلة المتصفح عن مشكلة المشروع.
 *  5) تفاصيل المتغيرات وفك ترميز JWT للمفتاح — هل المفتاح يخص هذا المشروع فعلًا؟
 *  6) هل رابط المشروع يبدو "متوقفًا" (Paused)؟
 */

type TestStatus = 'pending' | 'ok' | 'warn' | 'fail'

interface TestResult {
  name: string
  status: TestStatus
  detail: string
  ms: number | null
}

interface JwtInfo {
  header: Record<string, unknown> | null
  payload: Record<string, unknown> | null
  ref: string
  role: string
  alg: string
  keyMatchesProject: boolean | null
}

const EXPECTED_JWT_HEADER_PREFIX = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'

function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '==='.slice((normalized.length + 3) % 4)
    return JSON.parse(atob(padded)) as Record<string, unknown>
  } catch {
    return null
  }
}

function decodeAnonKey(key: string): JwtInfo {
  const empty: JwtInfo = { header: null, payload: null, ref: '', role: '', alg: '', keyMatchesProject: null }
  if (!key.includes('.')) return empty
  const parts = key.split('.')
  if (parts.length < 2) return empty
  const header = decodeJwtSegment(parts[0] ?? '')
  const payload = decodeJwtSegment(parts[1] ?? '')
  const ref = typeof payload?.ref === 'string' ? (payload.ref as string) : ''
  const role = typeof payload?.role === 'string' ? (payload.role as string) : ''
  const alg = typeof header?.alg === 'string' ? (header.alg as string) : ''
  return { header, payload, ref, role, alg, keyMatchesProject: null }
}

function classifyFailure(error: unknown): { kind: 'network' | 'cors-or-network' | 'other'; message: string } {
  const err = error as { name?: string; message?: string } | null
  const message = err?.message ?? String(error)
  const name = err?.name ?? ''
  const networkish =
    name === 'TypeError' ||
    /failed to fetch|networkerror|fetch failed|load failed|network request failed/i.test(message)
  return {
    kind: networkish ? 'cors-or-network' : 'other',
    message: `${name ? `${name}: ` : ''}${message}`,
  }
}

export default function DebugPage() {
  const [results, setResults] = useState<TestResult[]>([])
  const [envInfo, setEnvInfo] = useState<Record<string, unknown>>({})
  const [jwtInfo, setJwtInfo] = useState<JwtInfo | null>(null)
  const [serverProbe, setServerProbe] = useState<Record<string, unknown> | null>(null)
  const [cspHeader, setCspHeader] = useState<string>('…')
  const [signupResult, setSignupResult] = useState('')
  const [escalationReport, setEscalationReport] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string[]>([])
  const startedRef = useRef(false)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  const runTests = useCallback(async () => {
    // قيم محلية تُلتقط أثناء التنفيذ (حالة React قد تكون متأخرة داخل نفس الاستدعاء)
    let serverProbeLocal: Record<string, unknown> | null = null
    const tests: { name: string; run: () => Promise<{ status: TestStatus; detail: string }> }[] = [
      {
        name: 'example.com',
        run: async () => {
          const r = await fetch('https://example.com', { method: 'GET', signal: AbortSignal.timeout(8000) })
          return { status: r.ok ? 'ok' : 'warn', detail: `OK (status ${r.status})` }
        },
      },
      {
        name: 'google.com',
        run: async () => {
          const r = await fetch('https://www.google.com', { method: 'GET', signal: AbortSignal.timeout(8000) })
          return { status: r.ok ? 'ok' : 'warn', detail: `OK (status ${r.status})` }
        },
      },
      {
        name: 'supabase health',
        run: async () => {
          const target = url ? `${url}/auth/v1/health` : 'MISSING_URL'
          const r = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(8000) })
          const body = (await r.text()).slice(0, 120)
          return { status: r.ok ? 'ok' : 'warn', detail: `OK (status ${r.status}) body: ${body}` }
        },
      },
      {
        name: 'supabase root',
        run: async () => {
          const target = url || 'MISSING_URL'
          const r = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(8000) })
          return { status: r.ok ? 'ok' : 'warn', detail: `OK (status ${r.status})` }
        },
      },
      {
        name: 'supabase auth/v1/settings (مع apikey)',
        run: async () => {
          const target = url ? `${url}/auth/v1/settings` : 'MISSING_URL'
          const r = await fetch(target, {
            method: 'GET',
            headers: { apikey: key },
            signal: AbortSignal.timeout(8000),
          })
          const body = (await r.text()).slice(0, 160)
          return {
            status: r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'warn' : 'warn',
            detail: `status ${r.status} — ${r.ok ? 'المفتاح مقبول' : 'رد HTTP (المضيف مستهدف لكن الطلب مرفوض/خطأ)'} — body: ${body}`,
          }
        },
      },
      {
        name: 'supabase root (no-cors probe)',
        run: async () => {
          const target = url || 'MISSING_URL'
          await fetch(target, { method: 'GET', mode: 'no-cors', signal: AbortSignal.timeout(8000) })
          return {
            status: 'ok',
            detail: 'الشبكة تصل للمضيف (رد opaque). الوصول على مستوى الشبكة يعمل — أي فشل cors أعلاه هو حظر CORS وليس انقطاع.',
          }
        },
      },
      {
        name: 'same-origin /api/health (خادم Netlify → Supabase)',
        run: async () => {
          const r = await fetch('/api/health', { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(10000) })
          const body = (await r.text()).slice(0, 220)
          return { status: r.ok ? 'ok' : 'warn', detail: `status ${r.status} — body: ${body}` }
        },
      },
      {
        name: 'same-origin /api/debug/remote (تشخيص من الخادم)',
        run: async () => {
          const r = await fetch('/api/debug/remote', { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000) })
          const body = await r.text()
          try {
            serverProbeLocal = JSON.parse(body) as Record<string, unknown>
            setServerProbe(serverProbeLocal)
          } catch {
            /* ignore */
          }
          return { status: r.ok ? 'ok' : 'warn', detail: `status ${r.status} — body: ${body.slice(0, 260)}` }
        },
      },
      {
        name: 'proxy: /api/supabase-proxy/auth/v1/health (تجاوز حجب ISP)',
        run: async () => {
          const r = await fetch('/api/supabase-proxy/auth/v1/health', {
            method: 'GET',
            headers: { apikey: key },
            signal: AbortSignal.timeout(12000),
          })
          const body = (await r.text()).slice(0, 140)
          return {
            status: r.ok ? 'ok' : 'warn',
            detail: `status ${r.status} — ${r.ok ? 'الوسيط يعمل ✓ (المتصفح يصل لـ Supabase عبر Netlify)' : 'الوسيط لم ينجح'} — body: ${body}`,
          }
        },
      },
      {
        name: 'proxy: /api/supabase-proxy/auth/v1/settings (مع apikey)',
        run: async () => {
          const r = await fetch('/api/supabase-proxy/auth/v1/settings', {
            method: 'GET',
            headers: { apikey: key },
            signal: AbortSignal.timeout(12000),
          })
          const body = (await r.text()).slice(0, 160)
          return {
            status: r.ok ? 'ok' : 'warn',
            detail: `status ${r.status} — body: ${body}`,
          }
        },
      },
    ]

    const out: TestResult[] = tests.map((t) => ({ name: t.name, status: 'pending', detail: 'جارٍ التنفيذ…', ms: null }))
    setResults([...out])

    for (let i = 0; i < tests.length; i += 1) {
      const test = tests[i]!
      const started = Date.now()
      try {
        const result = await test.run()
        out[i] = { name: test.name, status: result.status, detail: result.detail, ms: Date.now() - started }
      } catch (error) {
        const classified = classifyFailure(error)
        out[i] = {
          name: test.name,
          status: 'fail',
          detail:
            classified.kind === 'cors-or-network'
              ? `FAILED — فشل شبكة/CORS قبل وصول الرد (${classified.message}). غالبًا: المضيف لا يستجيب (مشروع متوقف/محذوف/رابط خاطئ)، أو حظر من مانع إعلانات/مضاد فيروسات/بروكسي، أو CSP.`
              : `FAILED (${classified.message})`,
          ms: Date.now() - started,
        }
      }
      setResults([...out])
    }

    // ---- تحليل نهائي ----
    const byName = new Map(out.map((r) => [r.name, r]))
    const lines: string[] = []
    const general = [byName.get('example.com'), byName.get('google.com')]
    const supa = [byName.get('supabase health'), byName.get('supabase root')]
    const proxyOk = [
      byName.get('proxy: /api/supabase-proxy/auth/v1/health (تجاوز حجب ISP)'),
      byName.get('proxy: /api/supabase-proxy/auth/v1/settings (مع apikey)'),
    ].some((r) => r?.status === 'ok')
    const generalOk = general.every((r) => r?.status === 'ok')
    const supaOk = supa.some((r) => r?.status === 'ok')
    const server = serverProbeLocal as { verdict?: string } | null

    if (!generalOk) {
      lines.push('⚠️ حتى example.com/google.com تفشل: المشكلة ليست في Supabase — تحقق من الإنترنت نفسه (بروكسي، VPN، مانع إعلانات، جدار حماية، DNS).')
    }
    if (generalOk && !supaOk) {
      if (proxyOk) {
        lines.push('🔴➡️🟢 المؤكد: حجب من مزود الخدمة (ISP) لنطاق supabase.co — المتصفح لا يصل للمشروع مباشرة، لكن مواقع أخرى تعمل.')
        lines.push('🟢 الوسيط /api/supabase-proxy يعمل — التسجيل والدخول سيعملان من هذه الشبكة بدون VPN (يتطلب ضبط NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy ثم إعادة النشر).')
      } else {
        lines.push('🔴 المؤكد: رابط مشروع Supabase لا يرد من متصفحك (حجب ISP — كما في العراق — أو مشروع متوقف/رابط خاطئ).')
        lines.push('→ 1) تحقق من حالة المشروع في dashboard.supabase.com (Paused؟) — 2) فعّل الوسيط NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy وأعد النشر لتجاوز الحجب.')
      }
    }
    if (server?.verdict === 'server_cannot_reach_supabase') {
      lines.push('🔴 خادم Netlify أيضًا لا يصل إلى Supabase → المشروع متوقف/محذوف/الرابط خاطئ (قبل أي حجب). أعد تفعيل المشروع أو صحّح الرابط.')
    }
    if (server?.verdict === 'server_reaches_supabase' && !supaOk) {
      lines.push('🟠 خادم Netlify يصل إلى Supabase لكن متصفحك لا يصل مباشرة ← هذا نمط حجب ISP لنطاق supabase.co (شائع في العراق). الحل: الوسيط — أو جرّب شبكة أخرى للتأكد.')
    }
    if (generalOk && supaOk) {
      lines.push('🟢 كل اختبارات الشبكة ناجحة — الاتصال بـ Supabase يعمل من متصفحك الآن. إن فشل التسجيل فالسبب إعدادات Auth (Site URL / Redirect URLs / تأكيد البريد) وليست الشبكة.')
    }
    setVerdict(lines)
  }, [url, key])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    // تفاصيل المتغيرات (بما فيها المحارف الخفية)
    const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return 'INVALID_URL'
      }
    })()
    const projectRefFromHost = host.replace(/\.supabase\.co$/, '')
    const jwt = rawKey ? decodeAnonKey(rawKey) : null
    if (jwt) {
      jwt.keyMatchesProject = jwt.ref ? jwt.ref === projectRefFromHost : null
    }
    setJwtInfo(jwt)
    setEnvInfo({
      url: rawUrl ?? 'MISSING',
      urlLength: rawUrl?.length ?? 0,
      urlFirstCharCodes: [...(rawUrl ?? '')].slice(0, 3).map((c) => c.charCodeAt(0)),
      urlLastCharCodes: [...(rawUrl ?? '')].slice(-3).map((c) => c.charCodeAt(0)),
      urlHost: host,
      projectRefFromHost,
      keyExists: !!rawKey,
      keyLength: rawKey?.length ?? 0,
      keyPrefix: rawKey ? `${rawKey.substring(0, 25)}…` : 'MISSING',
      keyFirstCharCodes: [...(rawKey ?? '')].slice(0, 3).map((c) => c.charCodeAt(0)),
      keyLooksLikeLegacyJwt: rawKey ? rawKey.startsWith(EXPECTED_JWT_HEADER_PREFIX) : false,
      keyLooksLikePublishable: rawKey ? rawKey.startsWith('sb_publishable_') : false,
      nodeEnv: process.env.NODE_ENV,
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      proxyUrl: process.env.NEXT_PUBLIC_SUPABASE_PROXY_URL || 'غير مضبوط (اتصال مباشر)',
      browserBaseUrl: (() => {
        const raw = process.env.NEXT_PUBLIC_SUPABASE_PROXY_URL?.trim().replace(/\/+$/, '')
        if (raw && typeof window !== 'undefined') {
          try {
            return `${new URL(raw, window.location.origin).toString().replace(/\/+$/, '')} (عبر الوسيط)`
          } catch {
            /* fall through */
          }
        }
        return url || 'MISSING'
      })(),
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    })

    // هل فيه رأس CSP؟ (من استجابة same-origin)
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => setCspHeader(r.headers.get('content-security-policy') || 'none'))
      .catch(() => setCspHeader('تعذّر القراءة'))

    void runTests()
  }, [runTests, url, key])

  async function testSignup() {
    setSignupResult('جارٍ الاختبار… (سيُنشئ مستخدمًا فعليًا إذا نجح)')
    try {
      const res = await fetch(`${url}/auth/v1/signup`, {
        method: 'POST',
        headers: { apikey: key ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'debug' + Date.now() + '@ofoq.com', password: 'Test@12345678' }),
      })
      const data = await res.json()
      setSignupResult('SUCCESS: ' + JSON.stringify(data))
    } catch (e) {
      const classified = classifyFailure(e)
      setSignupResult(
        `FAILED: ${classified.message}` +
          (classified.kind === 'cors-or-network'
            ? ' — فشل شبكة/CORS: الطلب لم يصل إلى Supabase أصلًا (يتفق مع 0 مستخدمين في Auth).'
            : ''),
      )
    }
  }

  /** يقرأ تقرير التصعيد من الخادم (يعمل بجلسة المستخدم الحالية). */
  async function runEscalationCheck() {
    setEscalationReport('جارٍ الفحص…')
    try {
      const res = await fetch('/api/debug/escalation', { cache: 'no-store' })
      const data = await res.json()
      setEscalationReport(JSON.stringify(data, null, 2))
    } catch (e) {
      const classified = classifyFailure(e)
      setEscalationReport(`FAILED: ${classified.message}`)
    }
  }

  function copyReport() {
    const lines = [
      `# Ofoq /debug report — ${new Date().toISOString()}`,
      `origin: ${envInfo.origin}`,
      `csp: ${cspHeader}`,
      '',
      '## env',
      JSON.stringify(envInfo, null, 2),
      '',
      '## jwt',
      jwtInfo ? JSON.stringify({ alg: jwtInfo.alg, ref: jwtInfo.ref, role: jwtInfo.role, keyMatchesProject: jwtInfo.keyMatchesProject }, null, 2) : 'n/a',
      '',
      '## tests',
      ...results.map((r) => `[${r.status}] ${r.name} (${r.ms ?? '?'}ms) — ${r.detail}`),
      '',
      '## server probe',
      serverProbe ? JSON.stringify(serverProbe, null, 2) : 'n/a',
      '',
      '## escalation',
      escalationReport ?? 'n/a',
      '',
      '## verdict',
      ...verdict,
    ]
    void navigator.clipboard.writeText(lines.join('\n'))
  }

  const statusIcon: Record<TestStatus, string> = { pending: '⏳', ok: '🟢', warn: '🟠', fail: '🔴' }

  return (
    <div dir="rtl" style={{ padding: 20, color: '#fff', background: '#000', minHeight: '100vh', fontFamily: 'monospace' }}>
      <h1>Network Tests — تشخيص الاتصال</h1>
      <p style={{ color: '#aaa' }}>
        تُنفَّذ الاختبارات من متصفحك تلقائيًا. النتائج تفصل بين: انقطاع الإنترنت، عدم استجابة مشروع Supabase، حظر CORS/CSP، وحظر محلي (إضافات المتصفح).
      </p>

      <h2 style={{ marginTop: 24 }}>1) نتائج الاتصال</h2>
      {results.map((r) => (
        <p key={r.name} style={{ margin: '6px 0', direction: 'ltr', textAlign: 'left' }}>
          <span>{statusIcon[r.status]}</span> <b>{r.name}</b>: {r.status === 'pending' ? '…' : r.detail}{' '}
          <span style={{ color: '#888' }}>({r.ms ?? '?'}ms)</span>
        </p>
      ))}

      <h2 style={{ marginTop: 24 }}>2) الخلاصة (Verdict)</h2>
      {verdict.length === 0 && <p style={{ color: '#888' }}>تظهر بعد انتهاء الاختبارات…</p>}
      {verdict.map((v, i) => (
        <p key={i} style={{ margin: '8px 0', background: '#111', padding: 8, borderRadius: 6 }}>
          {v}
        </p>
      ))}
      {cspHeader !== '…' && cspHeader !== 'none' && cspHeader !== 'تعذّر القراءة' && (
        <p style={{ margin: '8px 0', background: '#111', padding: 8, borderRadius: 6 }}>
          🟠 رأس CSP موجود على الموقع — تأكد أن connect-src يسمح بـ https://*.supabase.co (المتصفح يحظر الاتصال خارج connect-src).
        </p>
      )}

      <h2 style={{ marginTop: 24 }}>3) المتغيرات (env)</h2>
      <pre style={{ background: '#111', padding: 12, borderRadius: 6, direction: 'ltr', textAlign: 'left' }}>
        {JSON.stringify(envInfo, null, 2)}
      </pre>

      <h2>4) فك ترميز المفتاح (JWT)</h2>
      <pre style={{ background: '#111', padding: 12, borderRadius: 6, direction: 'ltr', textAlign: 'left' }}>
        {jwtInfo
          ? JSON.stringify(
              {
                alg: jwtInfo.alg,
                header: jwtInfo.header,
                ref: jwtInfo.ref,
                role: jwtInfo.role,
                keyMatchesProject: jwtInfo.keyMatchesProject,
                expectedHeaderPrefix: EXPECTED_JWT_HEADER_PREFIX,
              },
              null,
              2,
            )
          : 'المفتاح غير موجود أو ليس JWT'}
      </pre>
      {jwtInfo?.keyMatchesProject === false && (
        <p style={{ color: '#ff6b6b' }}>
          🔴 المفتاح يخص مشروعًا آخر (ref داخل المفتاح لا يطابق الرابط). انسخ anon key الصحيح من Project Settings → API.
        </p>
      )}
      {jwtInfo?.keyMatchesProject === true && <p style={{ color: '#0f0' }}>🟢 المفتاح يطابق المشروع في الرابط (ref متطابق).</p>}

      <h2 style={{ marginTop: 24 }}>5) رأس CSP</h2>
      <pre style={{ background: '#111', padding: 12, borderRadius: 6, direction: 'ltr', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
        {cspHeader}
      </pre>

      <h2 style={{ marginTop: 24 }}>6) تشخيص الخادم (Netlify → Supabase)</h2>
      <pre style={{ background: '#111', padding: 12, borderRadius: 6, direction: 'ltr', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
        {serverProbe ? JSON.stringify(serverProbe, null, 2) : '…'}
      </pre>

      <hr style={{ margin: '24px 0' }} />

      <h2>7) اختبار يدوي — إنشاء مستخدم فعلي (اختياري)</h2>
      <p style={{ color: '#aaa' }}>⚠️ هذا الاختبار ينشئ مستخدمًا حقيقيًا في Supabase Auth إذا نجح.</p>
      <button onClick={testSignup} style={{ padding: 10, marginTop: 8, cursor: 'pointer' }}>
        Test Signup (POST /auth/v1/signup)
      </button>
      <pre style={{ marginTop: 12, color: '#0f0', whiteSpace: 'pre-wrap', direction: 'ltr', textAlign: 'left' }}>{signupResult}</pre>

      <h2 style={{ marginTop: 24 }}>8) فحص التصعيد (escalation)</h2>
      <p style={{ color: '#aaa' }}>
        يجلب تقريرًا من قاعدة البيانات نفسها عن حسابك: دورك، هل لديك سجل عميل (customers)، من يملك المحادثة،
        هل جدول <code>alerts</code> موجود وعمود <code>customer_id</code> يقبل NULL، وهل دالة{' '}
        <code>ofoq_client_escalate</code> مثبّتة. هذا هو الفحص الذي يوضّح سبب رسالة «تعذّر تسجيل تنبيه التحويل».
      </p>
      <button onClick={runEscalationCheck} style={{ padding: 10, marginTop: 8, cursor: 'pointer' }}>
        فحص التصعيد الآن (GET /api/debug/escalation)
      </button>
      <pre style={{ background: '#111', padding: 12, borderRadius: 6, direction: 'ltr', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
        {escalationReport ?? '…'}
      </pre>

      <button onClick={copyReport} style={{ padding: 10, marginTop: 16, cursor: 'pointer' }}>
        📋 نسخ التقرير كاملًا (لصقه في وصف المشكلة)
      </button>
    </div>
  )
}
