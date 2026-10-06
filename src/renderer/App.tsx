import { Background } from './components/Background'
import { CaptchaPanel } from './components/CaptchaPanel'
import { Splash } from './components/Splash'
import { Toasts } from './components/Toasts'
import Dashboard from './screens/Dashboard'
import Onboarding from './screens/Onboarding'
import ServerPicker from './screens/ServerPicker'
import Settings from './screens/Settings'
import { useApiEvents, useStore } from './store'

function Screen(): JSX.Element {
  const screen = useStore((s) => s.screen)
  const message = useStore((s) => s.connectionMessage)

  switch (screen) {
    case 'onboarding':
      return <Onboarding />
    case 'picker':
      return <ServerPicker />
    case 'dashboard':
      return <Dashboard />
    case 'settings':
      return <Settings />
    default:
      return (
        <Background>
          <Splash label={message ? `${message} — nouvel essai…` : undefined} />
        </Background>
      )
  }
}

export default function App(): JSX.Element {
  useApiEvents()
  const blocked = useStore((s) => s.captcha !== null)
  // while a captcha is open nothing behind the modal can be focused or read by assistive tech
  const inertProps = blocked ? ({ inert: '', 'aria-hidden': true } as Record<string, unknown>) : {}
  return (
    <>
      <div className="h-full" {...inertProps}>
        <Screen />
      </div>
      <CaptchaPanel />
      <Toasts />
    </>
  )
}
