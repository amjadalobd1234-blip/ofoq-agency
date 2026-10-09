'use client'
import { useEffect, useState } from 'react'

export default function DebugPage() {
  const [info, setInfo] = useState<any>({})
  const [testResult, setTestResult] = useState('')

  useEffect(() => {
    setInfo({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL || 'MISSING',
      urlLength: process.env.NEXT_PUBLIC_SUPABASE_URL?.length || 0,
      keyExists: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      keyLength: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.length || 0,
      keyPrefix: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.substring(0, 25) || 'MISSING'
    })
  }, [])

  async function testFetch() {
    setTestResult('جارٍ الاختبار...')
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      const res = await fetch(`${url}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'apikey': key ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'debug' + Date.now() + '@ofoq.com', password: 'Test@12345678' })
      })
      const data = await res.json()
      setTestResult('SUCCESS: ' + JSON.stringify(data))
    } catch (e: any) {
      setTestResult('FAILED: ' + e.message)
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: 'monospace', color: '#fff', background: '#000', minHeight: '100vh' }}>
      <h1>Debug Info</h1>
      <pre>{JSON.stringify(info, null, 2)}</pre>
      <button onClick={testFetch} style={{ padding: 10, marginTop: 20 }}>Test Fetch</button>
      <pre style={{ marginTop: 20, color: '#0f0' }}>{testResult}</pre>
    </div>
  )
}
