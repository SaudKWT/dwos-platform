import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
// Leaflet ships its own stylesheet and the map is a grey void without it — the
// tile grid, zoom control and marker panes are all positioned by these rules.
import 'leaflet/dist/leaflet.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
