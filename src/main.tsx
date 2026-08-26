import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import './react.css'
import { App } from './app/App'
import { AppProvider } from './app/app-context'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root application element')

createRoot(root).render(<StrictMode><AppProvider><App /></AppProvider></StrictMode>)
