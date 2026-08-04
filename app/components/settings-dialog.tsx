import { useState, useEffect } from "react"
import { useFetcher } from "react-router"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { ResultButton } from "#/components/result-button"
import { Mail, Lock, Server, Send } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog"
import type { Settings } from "#/types/settings"
import type { EmailTransportKind } from "#/lib/email/message"

// SMTP configurations for common email providers
const SMTP_CONFIGS: Record<string, { host: string; port: number; secure: boolean; hint: string }> = {
  "gmail.com": {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    hint: "For Gmail, use an App Password instead of your regular password. Go to Google Account → Security → 2-Step Verification → App passwords."
  },
  "outlook.com": {
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    hint: "For Outlook, use your regular Microsoft account password or an App Password if you have 2FA enabled."
  },
  "hotmail.com": {
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    hint: "For Hotmail, use your regular Microsoft account password or an App Password if you have 2FA enabled."
  },
  "yahoo.com": {
    host: "smtp.mail.yahoo.com",
    port: 587,
    secure: false,
    hint: "For Yahoo, generate an App Password at: Account Info → Account Security → Generate app password."
  },
  "icloud.com": {
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    hint: "For iCloud, use an App-Specific Password. Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords."
  },
}

function getEmailDomain(email: string): string | null {
  const match = email.match(/@(.+)$/)
  return match ? match[1].toLowerCase() : null
}

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings | null
  credentialEncryption: boolean
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  credentialEncryption,
}: SettingsDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const testFetcher = useFetcher<{
    success?: boolean
    error?: string
    transport?: string
    recipient?: string
  }>()
  const clearFetcher = useFetcher<{ success?: boolean; error?: string }>()

  const [transport, setTransport] = useState<EmailTransportKind>(
    settings?.email_transport ?? "cloudflare"
  )
  const [fromAddress, setFromAddress] = useState(settings?.email_from_address ?? "")
  const [fromName, setFromName] = useState(settings?.email_from_name ?? "")
  const [email, setEmail] = useState(settings?.notification_email || "")
  const [password, setPassword] = useState("")
  const [smtpHost, setSmtpHost] = useState(settings?.smtp_host || "")
  const [smtpPort, setSmtpPort] = useState(settings?.smtp_port?.toString() || "")
  const [smtpSecure, setSmtpSecure] = useState(settings?.smtp_secure === 1)

  const initialEmail = settings?.notification_email || ""
  const initialDomain = getEmailDomain(initialEmail)
  const initialConfig = initialDomain && SMTP_CONFIGS[initialDomain] ? SMTP_CONFIGS[initialDomain] : null

  const [emailDomain, setEmailDomain] = useState<string | null>(initialDomain)
  const [smtpConfig, setSmtpConfig] = useState<typeof SMTP_CONFIGS[string] | null>(initialConfig)

  // Update form when settings prop changes
  useEffect(() => {
    if (settings) {
      setTransport(settings.email_transport)
      setFromAddress(settings.email_from_address ?? "")
      setFromName(settings.email_from_name ?? "")
      setEmail(settings.notification_email || "")
      setPassword("")
      setSmtpHost(settings.smtp_host || "")
      setSmtpPort(settings.smtp_port?.toString() || "")
      setSmtpSecure(settings.smtp_secure === 1)
    }
  }, [settings])

  // Auto-detect SMTP settings based on email (debounced)
  useEffect(() => {
    const domain = getEmailDomain(email)

    if (!domain) {
      setEmailDomain(null)
      setSmtpConfig(null)
      return
    }

    const timer = setTimeout(() => {
      setEmailDomain(domain)

      if (SMTP_CONFIGS[domain]) {
        const config = SMTP_CONFIGS[domain]
        setSmtpConfig(config)
        setSmtpHost(config.host)
        setSmtpPort(config.port.toString())
        setSmtpSecure(config.secure)
      } else {
        setSmtpConfig(null)
        if (!settings?.smtp_host) {
          setSmtpHost("")
          setSmtpPort("")
        }
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [email, settings?.smtp_host])

  const isSaving = fetcher.state === "submitting"
  const isSaved = fetcher.state === "idle" && fetcher.data?.success === true

  const isTesting = testFetcher.state === "submitting"
  const testSuccess =
    testFetcher.state === "idle" && testFetcher.data?.success === true

  const isClearing = clearFetcher.state === "submitting"
  const isCleared = clearFetcher.state === "idle" && clearFetcher.data?.success === true

  useEffect(() => {
    if (clearFetcher.state === "idle" && clearFetcher.data?.success) {
      setTransport("cloudflare")
      setFromAddress("")
      setFromName("")
      setEmail("")
      setPassword("")
      setSmtpHost("")
      setSmtpPort("")
      setEmailDomain(null)
      setSmtpConfig(null)
    }
  }, [clearFetcher.state, clearFetcher.data])

  const handleTestEmail = () => {
    // Tests the stored, resolved transport, so it can only run once settings
    // have been saved.
    testFetcher.submit(null, {
      method: "post",
      action: "/settings/notifications/test",
    })
  }

  const handleDisableNotifications = () => {
    clearFetcher.submit(null, {
      method: "delete",
      action: "/settings/notifications"
    })
  }

  const smtpComplete =
    Boolean(email) &&
    Boolean(smtpHost) &&
    Boolean(smtpPort) &&
    (Boolean(password) || Boolean(settings?.has_password))
  const canSave =
    transport === "cloudflare" ? Boolean(fromAddress) : smtpComplete
  const canTest = Boolean(settings) && !isSaving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] h-[90vh] max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] overflow-y-auto p-6 flex flex-col items-start">
        <DialogHeader className="mb-6 w-full">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Email Notifications</CardTitle>
            <CardDescription>
              Choose how FormZero sends notification emails for form submissions
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <fetcher.Form method="post" action="/settings/notifications">
              <div className="space-y-6">
                <input type="hidden" name="email_transport" value={transport} />
                <input type="hidden" name="smtp_secure" value={smtpSecure ? "1" : "0"} />

                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium">Transport</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={transport === "cloudflare"}
                      onChange={() => setTransport("cloudflare")}
                    />
                    <span>
                      Cloudflare Email Service
                      <span className="block text-muted-foreground">
                        Recommended. No credentials to store. Requires a sending
                        domain onboarded with{" "}
                        <code>npx wrangler email sending enable &lt;domain&gt;</code>.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={transport === "smtp"}
                      onChange={() => setTransport("smtp")}
                    />
                    <span>
                      Custom SMTP server
                      <span className="block text-muted-foreground">
                        Sends through your own mail server. The password is stored
                        encrypted, so <code>FORMZERO_ENCRYPTION_KEY</code> must be set.
                      </span>
                    </span>
                  </label>
                </fieldset>

                {transport === "smtp" && !credentialEncryption && (
                  <p className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                    <code>FORMZERO_ENCRYPTION_KEY</code> is not set, so an SMTP
                    password cannot be stored. Run{" "}
                    <code>openssl rand -hex 32 | npx wrangler secret put FORMZERO_ENCRYPTION_KEY</code>{" "}
                    (or add it to <code>.dev.vars</code>), or use the Cloudflare Email
                    Service transport.
                  </p>
                )}

                <div className="space-y-2">
                  <Label htmlFor="from-address" className="flex items-center gap-2">
                    <Send className="h-4 w-4" />
                    Sender address
                  </Label>
                  <Input
                    id="from-address"
                    name="email_from_address"
                    type="email"
                    placeholder="forms@yourdomain.com"
                    value={fromAddress}
                    onChange={(e) => setFromAddress(e.target.value)}
                    required={transport === "cloudflare"}
                  />
                  <p className="text-sm text-muted-foreground">
                    {transport === "cloudflare"
                      ? "Must be on a domain onboarded for Cloudflare Email Sending; anything else is rejected as an unverified sender."
                      : "Optional. Defaults to the SMTP account address below."}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="from-name">Sender name</Label>
                  <Input
                    id="from-name"
                    name="email_from_name"
                    type="text"
                    placeholder="FormZero"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                  />
                </div>

                {transport === "smtp" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="email" className="flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        SMTP account address
                      </Label>
                      <Input
                        id="email"
                        name="notification_email"
                        type="email"
                        placeholder="your.email@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                      <p className="text-sm text-muted-foreground">
                        The SMTP username used to authenticate against the server.
                      </p>
                    </div>

                    {emailDomain && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="password" className="flex items-center gap-2">
                            <Lock className="h-4 w-4" />
                            SMTP Password
                          </Label>
                          <Input
                            id="password"
                            name="notification_email_password"
                            type="password"
                            placeholder={
                              settings?.has_password
                                ? "Leave blank to keep the saved password"
                                : "Enter your SMTP password"
                            }
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required={!settings?.has_password}
                          />
                          <p className="text-sm text-muted-foreground">
                            {smtpConfig ? smtpConfig.hint : "Use your email password or app-specific password"}
                          </p>
                        </div>

                        {!smtpConfig && (
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label htmlFor="smtp-host" className="flex items-center gap-2">
                                <Server className="h-4 w-4" />
                                SMTP Host
                              </Label>
                              <Input
                                id="smtp-host"
                                name="smtp_host"
                                type="text"
                                placeholder="smtp.example.com"
                                value={smtpHost}
                                onChange={(e) => setSmtpHost(e.target.value)}
                                required
                              />
                              <p className="text-sm text-muted-foreground">
                                The SMTP server address for your email provider
                              </p>
                            </div>

                            <div className="space-y-2">
                              <Label htmlFor="smtp-port">SMTP Port</Label>
                              <Input
                                id="smtp-port"
                                name="smtp_port"
                                type="number"
                                placeholder="587"
                                value={smtpPort}
                                onChange={(e) => setSmtpPort(e.target.value)}
                                required
                              />
                              <p className="text-sm text-muted-foreground">
                                Common ports: 587 (TLS), 465 (SSL), 25 (Plain)
                              </p>
                            </div>
                          </div>
                        )}

                        {smtpConfig && (
                          <>
                            <input type="hidden" name="smtp_host" value={smtpHost} />
                            <input type="hidden" name="smtp_port" value={smtpPort} />
                          </>
                        )}

                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={smtpSecure}
                            onChange={(event) => setSmtpSecure(event.target.checked)}
                          />
                          Use implicit TLS (usually port 465)
                        </label>
                      </>
                    )}
                  </>
                )}

                <div className="space-y-3 pt-2">
                  {fetcher.data?.error && (
                    <p className="text-sm text-destructive">{fetcher.data.error}</p>
                  )}
                  {testFetcher.data?.error && (
                    <p className="text-sm text-destructive">
                      {testFetcher.data.error}
                    </p>
                  )}
                  {testSuccess && (
                    <p className="text-sm text-muted-foreground">
                      Test email sent to {testFetcher.data?.recipient} via{" "}
                      {testFetcher.data?.transport}.
                    </p>
                  )}
                  {clearFetcher.data?.error && (
                    <p className="text-sm text-destructive">
                      {clearFetcher.data.error}
                    </p>
                  )}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="flex flex-col sm:flex-row gap-2">
                      <ResultButton
                        type="submit"
                        isSubmitting={isSaving}
                        isSuccess={isSaved}
                        loadingText="Saving..."
                        successText="Saved!"
                        disabled={!canSave}
                        className="w-full sm:w-auto"
                      >
                        Save Settings
                      </ResultButton>
                      <ResultButton
                        type="button"
                        variant="outline"
                        isSubmitting={isTesting}
                        isSuccess={testSuccess}
                        loadingText="Sending..."
                        successText="Test email sent!"
                        disabled={!canTest}
                        onClick={handleTestEmail}
                        className="w-full sm:w-auto"
                      >
                        Send test email
                      </ResultButton>
                    </div>
                    {settings && (
                      <ResultButton
                        type="button"
                        variant="outline"
                        isSubmitting={isClearing}
                        isSuccess={isCleared}
                        loadingText="Disabling..."
                        successText="Disabled!"
                        className="w-full sm:w-auto text-destructive hover:text-destructive"
                        onClick={handleDisableNotifications}
                      >
                        Disable Notifications
                      </ResultButton>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The test sends through the stored configuration, so save
                    first — a passing test then means the delivery queue will
                    succeed too.
                  </p>
                </div>
              </div>
            </fetcher.Form>
          </CardContent>
        </Card>
      </DialogContent>
    </Dialog>
  )
}
