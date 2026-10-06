import { Background } from './components/Background'
import { Placeholder } from './components/Placeholder'
import { Splash } from './components/Splash'
import Onboarding from './screens/Onboarding'
import ServerPicker from './screens/ServerPicker'
import { useApiEvents, useStore } from './store'

export default function App(): JSX.Element {
  useApiEvents()
  const screen = useStore((s) => s.screen)

  switch (screen) {
    case 'onboarding':
      return <Onboarding />
    case 'picker':
      return <ServerPicker />
    case 'dashboard':
      return <Placeholder title="Dashboard" />
    case 'settings':
      return <Placeholder title="Settings" />
    default:
      return (
        <Background>
          <Splash />
        </Background>
      )
  }
}
