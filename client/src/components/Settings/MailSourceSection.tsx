import React, { useEffect, useState } from 'react'
import { Mail, Save, Trash2, RefreshCw, Plug, KeyRound, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import { useToast } from '../shared/Toast'
import Section from './Section'
import ToggleSwitch from './ToggleSwitch'

// Direct links to each provider's app-password page. Most providers block plain
// IMAP logins and require a generated app password (with IMAP enabled).
const APP_PASSWORD_LINKS: { label: string; url: string }[] = [
  { label: 'Gmail', url: 'https://myaccount.google.com/apppasswords' },
  { label: 'Outlook / Microsoft', url: 'https://account.microsoft.com/security' },
  { label: 'Yahoo', url: 'https://login.yahoo.com/account/security/app-passwords' },
  { label: 'iCloud Mail', url: 'https://support.apple.com/102654' },
  { label: 'Fastmail', url: 'https://app.fastmail.com/settings/security/devicekeys' },
]

/**
 * Settings → Integrations → Mail ingest. Connect a mailbox (IMAP) and TREK scans
 * it for flight/hotel confirmations and files them onto trips. Mirrors the
 * AirTrail / AI-parsing connection sections. The password is stored encrypted and
 * never returned to the client.
 */

interface MailSource {
  id: number
  host: string
  port: number
  username: string
  folder: string
  poll_interval_minutes: number
  mode: string
  enabled: boolean
  last_polled_at: string | null
}

const inputCls =
  'w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 border-edge bg-surface-secondary text-content'

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/mail-ingest${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(data?.error || 'Request failed')
  return data
}

export default function MailSourceSection(): React.ReactElement {
  const toast = useToast()
  const [sources, setSources] = useState<MailSource[]>([])
  const [host, setHost] = useState('')
  const [port, setPort] = useState('993')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [folder, setFolder] = useState('INBOX')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [catchingUp, setCatchingUp] = useState<number | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const load = async () => {
    try {
      setSources(await api<MailSource[]>('/sources'))
    } catch {
      /* ignore — section just shows the empty form */
    }
  }
  useEffect(() => {
    load()
  }, [])

  const body = () => ({
    host: host.trim(),
    port: Number(port) || 993,
    username: username.trim(),
    password,
    folder: folder.trim() || 'INBOX',
  })

  const test = async () => {
    setTesting(true)
    try {
      const r = await api<{ ok: boolean; error?: string }>('/sources/test', { method: 'POST', body: JSON.stringify(body()) })
      if (r.ok) toast.success('Connection successful')
      else toast.error(`Connection failed: ${r.error ?? 'unknown error'}`)
    } catch (e) {
      toast.error(`Connection failed: ${(e as Error).message}`)
    } finally {
      setTesting(false)
    }
  }

  const add = async () => {
    setBusy(true)
    try {
      await api('/sources', { method: 'POST', body: JSON.stringify(body()) })
      setHost('')
      setUsername('')
      setPassword('')
      setPort('993')
      setFolder('INBOX')
      toast.success('Mailbox connected')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (s: MailSource) => {
    try {
      await api(`/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) })
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const remove = async (s: MailSource) => {
    try {
      await api(`/sources/${s.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const catchUp = async (s: MailSource) => {
    setCatchingUp(s.id)
    try {
      const r = await api<{ imported: number; pending: number; skipped: number }>(`/sources/${s.id}/catch-up?days=30`, { method: 'POST' })
      toast.success(`Caught up — ${r.imported} added, ${r.pending} to review, ${r.skipped} skipped`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCatchingUp(null)
    }
  }

  const canSubmit = host.trim() && username.trim() && password

  return (
    <Section title="Mail ingest" icon={Mail}>
      <div className="space-y-4">
        <p className="text-xs text-content-secondary">
          Connect a mailbox and TREK scans it for flight &amp; hotel confirmations, filing each onto the matching trip
          (creating the trip if none exists). It reads your inbox to find bookings — set a folder below to limit it to,
          e.g., a dedicated <code>TREK</code> folder.
        </p>

        {/* Connected sources */}
        {sources.length > 0 && (
          <div className="space-y-2">
            {sources.map((s) => (
              <div key={s.id} className="flex items-center gap-3 p-3 border rounded-lg border-edge bg-surface-secondary">
                <Mail className="w-4 h-4 text-content-faint shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-content truncate">{s.username}</div>
                  <div className="text-xs text-content-faint truncate">
                    {s.host}:{s.port} · {s.folder}
                    {s.last_polled_at ? ` · last checked ${new Date(s.last_polled_at).toLocaleString()}` : ' · not checked yet'}
                  </div>
                </div>
                <button
                  onClick={() => catchUp(s)}
                  disabled={catchingUp === s.id}
                  title="Scan the last 30 days now"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-edge text-content-secondary hover:bg-surface disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${catchingUp === s.id ? 'animate-spin' : ''}`} />
                  Catch up
                </button>
                <ToggleSwitch on={s.enabled} onToggle={() => toggle(s)} />
                <button onClick={() => remove(s)} title="Remove" className="p-1.5 rounded-lg text-content-faint hover:text-red-500 hover:bg-surface">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add a mailbox */}
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-1.5 text-content-secondary">IMAP host</label>
              <input type="text" autoComplete="off" value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.gmail.com" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-content-secondary">Port</label>
              <input type="text" autoComplete="off" value={port} onChange={(e) => setPort(e.target.value)} placeholder="993" className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-content-secondary">Username</label>
              <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="you@example.com" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-content-secondary">Password (app password)</label>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className={inputCls} />
              <p className="mt-1 text-xs text-content-faint">Use an app password, not your login password.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5 text-content-secondary">Folder</label>
            <input type="text" autoComplete="off" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="INBOX" className={inputCls} />
            <p className="mt-1 text-xs text-content-faint">Default <code>INBOX</code>. Point at a dedicated folder to keep TREK out of the rest of your mail.</p>
          </div>

          {/* App-password help — mirrors the MCP "Client Configuration" collapsible. */}
          <div className="rounded-lg border overflow-hidden border-edge">
            <button
              type="button"
              onClick={() => setHelpOpen((o) => !o)}
              className="w-full flex items-center justify-between px-3 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 bg-surface-secondary"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-content-secondary">
                <KeyRound className="w-4 h-4" /> Where do I create an app password?
              </span>
              {helpOpen ? (
                <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />
              ) : (
                <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />
              )}
            </button>
            {helpOpen && (
              <div className="p-3 border-t border-edge space-y-2">
                <p className="text-xs text-content-faint">
                  Most providers block plain IMAP logins — generate an <strong>app password</strong> and make sure IMAP
                  is enabled in your mail settings, then paste it above.
                </p>
                <div className="flex flex-wrap gap-2">
                  {APP_PASSWORD_LINKS.map((p) => (
                    <a
                      key={p.label}
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-edge text-xs text-content-secondary hover:bg-surface"
                    >
                      {p.label} <ExternalLink className="w-3 h-3" />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={test}
              disabled={!canSubmit || testing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-edge text-content-secondary hover:bg-surface disabled:opacity-50"
            >
              <Plug className="w-4 h-4" /> {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              onClick={add}
              disabled={!canSubmit || busy}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-slate-900 hover:bg-slate-700 disabled:opacity-50"
            >
              <Save className="w-4 h-4" /> {busy ? 'Connecting…' : 'Connect mailbox'}
            </button>
          </div>
        </div>
      </div>
    </Section>
  )
}
