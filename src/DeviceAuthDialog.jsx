import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export function DeviceAuthDialog({ Icons, onAccountUpdate, onClose }) {
  const [step, setStep] = useState('idle')
  const [deviceCode, setDeviceCode] = useState('')
  const [userCode, setUserCode] = useState('')
  const [verificationUri, setVerificationUri] = useState('')
  const [errorText, setErrorText] = useState('')
  const [expiresAt, setExpiresAt] = useState(null)
  const [copied, setCopied] = useState(false)
  const pollTimerRef = useRef(null)
  const pollIntervalRef = useRef(5000)
  const epochRef = useRef(0)
  const autoCopiedCodeRef = useRef('')

  const copyUserCode = async (code = userCode, showFeedback = true) => {
    const text = String(code || '').trim()
    if (!text) return false
    try {
      await invoke('write_clipboard', { text })
      if (showFeedback) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
      return true
    } catch {
      return false
    }
  }

  const startDeviceAuth = async () => {
    const epoch = ++epochRef.current
    setStep('loading')
    setErrorText('')
    try {
      const resp = await invoke('github_start_device_auth')
      if (epoch !== epochRef.current) return
      setDeviceCode(resp.device_code)
      setUserCode(resp.user_code)
      setVerificationUri(resp.verification_uri)
      setExpiresAt(Date.now() + resp.expires_in * 1000)
      setStep('waiting')
      startPolling(resp.device_code, resp.interval * 1000, epoch)
    } catch (e) {
      if (epoch !== epochRef.current) return
      setErrorText(String(e))
      setStep('error')
    }
  }

  const startPolling = (code, interval, epoch) => {
    pollIntervalRef.current = interval
    poll()
    pollTimerRef.current = setInterval(poll, interval)

    async function poll() {
      if (epoch !== epochRef.current) { clearInterval(pollTimerRef.current); return }
      try {
        const account = await invoke('github_poll_token', { deviceCode: code })
        if (epoch !== epochRef.current) { clearInterval(pollTimerRef.current); return }
        clearInterval(pollTimerRef.current)
        setStep('done')
        onAccountUpdate(account)
      } catch (e) {
        if (epoch !== epochRef.current) { clearInterval(pollTimerRef.current); return }
        const errMsg = String(e?.message ?? e)
        // 调试日志（不含 token）
        if (errMsg.includes('authorization_pending')) {
          return
        }
        if (errMsg.includes('slow_down')) {
          clearInterval(pollTimerRef.current)
          pollIntervalRef.current = Math.min(pollIntervalRef.current * 2, 30000)
          pollTimerRef.current = setInterval(poll, pollIntervalRef.current)
          return
        }
        clearInterval(pollTimerRef.current)
        setErrorText(errMsg)
        setStep('error')
      }
    }
  }

  const openVerificationUrl = async () => {
    try {
      await openUrl(verificationUri)
    } catch (e) {
      // 静默失败
    }
  }

  const handleRetry = () => {
    epochRef.current += 1
    clearInterval(pollTimerRef.current)
    autoCopiedCodeRef.current = ''
    setStep('idle')
    setErrorText('')
    setDeviceCode('')
    setUserCode('')
    setVerificationUri('')
    setExpiresAt(null)
  }

  const handleCancel = () => {
    epochRef.current += 1
    clearInterval(pollTimerRef.current)
    autoCopiedCodeRef.current = ''
    onClose()
  }

  useEffect(() => {
    return () => {
      epochRef.current += 1
      clearInterval(pollTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (step === 'idle') {
      startDeviceAuth()
    }
  }, [step])

  useEffect(() => {
    if (step !== 'waiting' || !userCode || autoCopiedCodeRef.current === userCode) return
    autoCopiedCodeRef.current = userCode
    void copyUserCode(userCode, true)
  }, [step, userCode])

  // 倒计时
  const [countdown, setCountdown] = useState('')
  useEffect(() => {
    if (!expiresAt || step !== 'waiting') {
      setCountdown('')
      return
    }
    const tick = () => {
      const sec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      const m = Math.floor(sec / 60)
      const s = sec % 60
      setCountdown(`${m}:${String(s).padStart(2, '0')}`)
      if (sec <= 0) {
        clearInterval(pollTimerRef.current)
        setErrorText('授权码已过期，请重新开始')
        setStep('error')
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [expiresAt, step])

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={handleCancel}>
      <div data-overlay-motion="surface" className="device-auth-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="device-auth-dialog__header">
          <div className="device-auth-dialog__icon">
            <Icons.github className="icon icon--warning" />
          </div>
          <div>
            <div className="device-auth-dialog__title">登录 GitHub</div>
            <div className="device-auth-dialog__subtitle">
              通过 GitHub Device Flow 安全授权
            </div>
          </div>
        </div>

        <div className="device-auth-dialog__body">
          {step === 'loading' && (
            <div className="device-auth-dialog__status">
              <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
              <span>正在连接 GitHub...</span>
            </div>
          )}

          {step === 'waiting' && (
            <>
              <div className="device-auth-dialog__code-section">
                <div className="device-auth-dialog__code-label">请在浏览器中打开以下地址，输入验证码</div>
                <div className="device-auth-dialog__code-box">
                  <a
                    href={verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="device-auth-dialog__verification-uri"
                  >
                    {verificationUri}
                  </a>
                </div>
                <div
                  className={`device-auth-dialog__user-code ${copied ? 'device-auth-dialog__user-code--copied' : ''}`}
                  onClick={() => { void copyUserCode(userCode, true) }}
                >{userCode}</div>
                <div className="device-auth-dialog__code-hint">{copied ? '已复制 ✓' : '验证码（点击复制）'}</div>
                <button
                  className="device-auth-dialog__open-btn"
                  onClick={openVerificationUrl}
                >
                  在浏览器中打开
                </button>
              </div>
              <div className="device-auth-dialog__waiting">
                等待授权中... 剩余 {countdown}
              </div>
            </>
          )}

          {step === 'error' && (
            <div className="device-auth-dialog__error" role="alert">
              <Icons.warning className="icon icon--xs" />
              <span>{errorText}</span>
            </div>
          )}

          {step === 'done' && (
            <div className="device-auth-dialog__done">
              <Icons.check className="icon icon--md" />
              <span>登录成功！</span>
            </div>
          )}
        </div>

        <div className="device-auth-dialog__footer">
          {step === 'error' ? (
            <>
              <button className="dialog-btn" onClick={handleCancel}>取消</button>
              <button className="dialog-btn dialog-btn--primary" onClick={handleRetry}>重试</button>
            </>
          ) : (
            <button className="dialog-btn" onClick={handleCancel}>取消</button>
          )}
        </div>
      </div>
    </div>
  )
}
