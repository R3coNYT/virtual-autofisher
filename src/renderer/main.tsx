import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTauriApi } from './api'
import './styles.css'

installTauriApi() // window.api before the first render

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
