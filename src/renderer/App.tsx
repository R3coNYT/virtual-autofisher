import { Background } from './components/Background'
import { Placeholder } from './components/Placeholder'
import { Splash } from './components/Splash'
import Dashboard from './screens/Dashboard'
import Onboarding from './screens/Onboarding'
import ServerPicker from './screens/ServerPicker'
import { useApiEvents, useStore } from './store'

export default function App(): JSX.Element {
  useApiEvents()
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
      return <Placeholder title="Settings" />
    default:
      return (
        <Background>
          <Splash label={message ? `${message} — nouvel essai…` : undefined} />
        </Background>
      )
  }
}
