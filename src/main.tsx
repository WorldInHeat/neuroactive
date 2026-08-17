import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import PrivacyPolicyPage from './components/PrivacyPolicyPage.tsx'
import TermsOfServicePage from './components/TermsOfServicePage.tsx'

// /privacy and /terms are real, standalone routes — resolved here, before the app's own
// auth/state machinery even initializes, so they're reachable regardless of Firebase Auth,
// DNS_ONLY_LAUNCH, or anything else App.tsx depends on. No router dependency needed for
// two static pages; Firebase Hosting's catch-all rewrite already serves index.html for
// any path, so direct navigation and refresh on these URLs work without extra hosting config.
const path = window.location.pathname
const page =
  path === '/privacy' ? <PrivacyPolicyPage /> :
  path === '/terms' ? <TermsOfServicePage /> :
  <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
)
